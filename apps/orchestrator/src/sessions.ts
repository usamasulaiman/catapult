import type { Db } from "@catapult/core";

export interface IngestEvent {
  harness: "claude" | "pi";
  event: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  ts?: string;
  payload?: unknown;
}

const STATUS_BY_EVENT: Record<string, "working" | "needs_input" | "idle" | "ended"> = {
  SessionStart: "idle",
  UserPromptSubmit: "working",
  Notification: "needs_input",
  Stop: "idle",
  SubagentStop: "working",
  SessionEnd: "ended",
};

/** Find the project owning a cwd: its clone, or one of its job worktrees. */
export function projectForCwd(db: Db, cwd: string | undefined, worktreesDir?: string): string | null {
  if (!cwd) return null;
  const rows = db.prepare("SELECT id, local_path FROM projects").all() as { id: string; local_path: string }[];
  let best: { id: string; len: number } | undefined;
  for (const p of rows) {
    const inClone = cwd === p.local_path || cwd.startsWith(p.local_path + "/");
    const inWorktrees = worktreesDir && cwd.startsWith(`${worktreesDir}/${p.id}/`);
    if ((inClone || inWorktrees) && (!best || p.local_path.length > best.len)) best = { id: p.id, len: p.local_path.length };
  }
  return best?.id ?? null;
}

/**
 * Record a hook/extension event and update the session index. Never copies message content:
 * the harness JSONL stays the record; this row is only a pointer plus status.
 * Sessions owned by the runner keep origin=job and driver=runner.
 */
export function ingestEvent(db: Db, e: IngestEvent, opts: { worktreesDir?: string; now?: number } = {}): void {
  const now = opts.now ?? Date.now();
  db.prepare("INSERT INTO events (harness, session_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(e.harness, e.session_id ?? null, e.event, JSON.stringify(e.payload ?? {}), now);
  const status = STATUS_BY_EVENT[e.event];
  if (!e.session_id || !status) return;

  const project = projectForCwd(db, e.cwd, opts.worktreesDir);
  const isJob = !!opts.worktreesDir && !!e.cwd?.startsWith(opts.worktreesDir + "/");
  db.prepare(
    `INSERT INTO sessions (harness, session_id, project_id, cwd, transcript_path, origin, status, driver, last_event_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (harness, session_id) DO UPDATE SET
       status = excluded.status,
       last_event_at = excluded.last_event_at,
       transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path),
       project_id = COALESCE(sessions.project_id, excluded.project_id),
       cwd = COALESCE(sessions.cwd, excluded.cwd)`,
  ).run(
    e.harness, e.session_id, project, e.cwd ?? null, e.transcript_path ?? null,
    isJob ? "job" : "interactive", status, isJob ? "runner" : "terminal", now,
  );
}

/** Delete hook events older than the retention window. */
export function pruneEvents(db: Db, olderThanMs: number, now = Date.now()): number {
  return Number(db.prepare("DELETE FROM events WHERE created_at < ?").run(now - olderThanMs).changes);
}

export type Driver = "none" | "runner" | "terminal";

/**
 * Takeover: allowed when no live process is driving (idle / needs_input / ended job session).
 * Returns the resume command for the caller to print.
 */
export function takeover(db: Db, harness: string, sessionId: string): { ok: true; command: string } | { ok: false; error: string } {
  const s = db.prepare("SELECT * FROM sessions WHERE harness = ? AND session_id = ?").get(harness, sessionId) as
    | { status: string; driver: Driver; transcript_path: string | null } | undefined;
  if (!s) return { ok: false, error: "no such session" };
  if (s.driver === "runner" && s.status === "working") return { ok: false, error: "session is being driven by the runner" };
  db.prepare("UPDATE sessions SET driver = 'terminal' WHERE harness = ? AND session_id = ?").run(harness, sessionId);
  const command = harness === "claude" ? `claude --resume ${sessionId}` : `pi --session ${s.transcript_path ?? sessionId}`;
  return { ok: true, command };
}

export function release(db: Db, harness: string, sessionId: string): boolean {
  return Number(db.prepare("UPDATE sessions SET driver = 'none' WHERE harness = ? AND session_id = ? AND driver = 'terminal'").run(harness, sessionId).changes) === 1;
}
