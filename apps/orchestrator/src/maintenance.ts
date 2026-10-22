import { existsSync, statSync } from "node:fs";
import type { Db } from "@catapult/core";
import { forceRemoveWorktree } from "./worktree.ts";

const DAY = 86_400_000;

/** Failed/cancelled jobs keep their worktree for inspection; remove it after 7 days (plan: Worktrees). */
export async function sweepWorktrees(db: Db, worktreesDir: string, now = Date.now(), keepMs = 7 * DAY): Promise<string[]> {
  const rows = db.prepare(
    `SELECT r.worktree_path, j.worker, j.id AS job_id, p.local_path FROM runs r
     JOIN jobs j ON j.id = r.job_id JOIN projects p ON p.id = j.project_id
     WHERE j.status IN ('failed','cancelled') AND r.ended_at IS NOT NULL AND r.ended_at < ? AND r.worktree_path IS NOT NULL`,
  ).all(now - keepMs) as { worktree_path: string; worker: string; job_id: string; local_path: string }[];
  const removed: string[] = [];
  for (const r of rows) {
    // Only ever delete inside catapult's own worktree root (resume jobs reuse an existing session dir).
    if (!r.worktree_path.startsWith(worktreesDir + "/") || !existsSync(r.worktree_path)) continue;
    const branch = r.worker === "pr-babysitter" || r.worker === "implement" || r.worker === "resume" ? "" : `catapult/${r.worker}/${r.job_id.slice(0, 8)}`;
    await forceRemoveWorktree(r.local_path, { path: r.worktree_path, branch });
    removed.push(r.worktree_path);
  }
  return removed;
}

/**
 * The runner claims sessions it drives. After a restart (or a crash) a claim can outlive its process:
 * release it, unless the transcript is still being written, which means something else is driving it.
 * That is flagged as a conflict instead of guessed at (plan: Session ownership).
 */
export function reconcileSessions(db: Db, liveSessions: Set<string>, now = Date.now(), freshMs = 60_000): { released: string[]; conflicts: string[] } {
  const rows = db.prepare("SELECT harness, session_id, transcript_path FROM sessions WHERE driver = 'runner'").all() as
    { harness: string; session_id: string; transcript_path: string | null }[];
  const out = { released: [] as string[], conflicts: [] as string[] };
  for (const s of rows) {
    if (liveSessions.has(`${s.harness}:${s.session_id}`)) continue;
    let mtime = 0;
    try { if (s.transcript_path) mtime = statSync(s.transcript_path).mtimeMs; } catch {}
    if (now - mtime < freshMs) {
      db.prepare("UPDATE sessions SET conflict = 1 WHERE harness = ? AND session_id = ?").run(s.harness, s.session_id);
      out.conflicts.push(s.session_id);
    } else {
      db.prepare("UPDATE sessions SET driver = 'none', status = CASE WHEN status = 'working' THEN 'ended' ELSE status END, conflict = 0 WHERE harness = ? AND session_id = ?")
        .run(s.harness, s.session_id);
      out.released.push(s.session_id);
    }
  }
  return out;
}
