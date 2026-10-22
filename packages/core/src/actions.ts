import { randomBytes, randomUUID } from "node:crypto";
import { tx, type Db } from "./db.ts";

export type ActionStatus = "pending" | "approved" | "rejected" | "expired" | "executed";

export interface Action {
  id: string;
  job_id: string | null;
  run_id: string | null;
  project_id: string | null;
  kind: string;
  summary: string | null;
  payload: any;
  status: ActionStatus;
  nonce: string;
  expires_at: number | null;
  channel_message_id: string | null;
  result: unknown;
  created_at: number;
}

export interface Approver {
  channel: "telegram" | "ui" | "cli";
  id: string;
  name?: string;
  messageId?: string;
}

export const DEFAULT_ACTION_TTL_MS = 48 * 3_600_000;

type Row = Record<string, unknown>;
function toAction(r: Row): Action {
  return {
    ...(r as unknown as Action),
    payload: JSON.parse(r.payload_json as string),
    result: r.result_json ? JSON.parse(r.result_json as string) : null,
  };
}

/** Record a side effect an agent proposed. Nothing happens until it is approved (principle 3). */
export function createAction(db: Db, o: {
  kind: string; payload: unknown; summary?: string; project_id?: string; job_id?: string; run_id?: string; ttlMs?: number;
}, now = Date.now()): Action {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO actions (id, job_id, run_id, project_id, kind, summary, payload_json, status, nonce, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(id, o.job_id ?? null, o.run_id ?? null, o.project_id ?? null, o.kind, o.summary ?? null,
    JSON.stringify(o.payload ?? {}), randomBytes(4).toString("hex"), now + (o.ttlMs ?? DEFAULT_ACTION_TTL_MS), now);
  return getAction(db, id)!;
}

export function getAction(db: Db, id: string): Action | undefined {
  const r = db.prepare("SELECT * FROM actions WHERE id = ?").get(id);
  return r ? toAction(r as Row) : undefined;
}

export function listActions(db: Db, status?: ActionStatus): Action[] {
  return (db.prepare("SELECT * FROM actions WHERE (?1 IS NULL OR status = ?1) ORDER BY created_at DESC LIMIT 200")
    .all(status ?? null) as Row[]).map(toAction);
}

export interface PriorDecision { decision: string; approver_name: string | null; approver_id: string; decided_at: number }

export type DecideResult =
  | { ok: true; action: Action }
  | { ok: false; reason: "not_found" | "bad_nonce" | "expired" | "already_decided"; prior?: PriorDecision };

/**
 * Decide a pending action. The first decision wins; later ones return the prior decision.
 * `nonce` is checked when given (Telegram callback data carries it).
 */
export function decideAction(
  db: Db, id: string, decision: "approved" | "rejected", who: Approver, o: { nonce?: string; now?: number } = {},
): DecideResult {
  const now = o.now ?? Date.now();
  return tx(db, () => {
    const a = getAction(db, id);
    if (!a) return { ok: false, reason: "not_found" };
    if (o.nonce !== undefined && o.nonce !== a.nonce) return { ok: false, reason: "bad_nonce" };
    if (a.status !== "pending") {
      const prior = db.prepare("SELECT decision, approver_name, approver_id, decided_at FROM approvals WHERE action_id = ? ORDER BY decided_at LIMIT 1")
        .get(id) as PriorDecision | undefined;
      return { ok: false, reason: a.status === "expired" ? "expired" : "already_decided", prior };
    }
    if (a.expires_at !== null && a.expires_at <= now) {
      db.prepare("UPDATE actions SET status = 'expired' WHERE id = ?").run(id);
      return { ok: false, reason: "expired" };
    }
    db.prepare("UPDATE actions SET status = ? WHERE id = ?").run(decision, id);
    db.prepare(
      `INSERT INTO approvals (id, action_id, decision, approver_channel, approver_id, approver_name, channel_message_id, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), id, decision, who.channel, who.id, who.name ?? null, who.messageId ?? null, now);
    return { ok: true, action: getAction(db, id)! };
  });
}

/** Expire pending actions past their deadline. Returns the expired actions (to update their messages). */
export function expireActions(db: Db, now = Date.now()): Action[] {
  return tx(db, () => {
    const rows = (db.prepare("SELECT * FROM actions WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?")
      .all(now) as Row[]).map(toAction);
    for (const a of rows) db.prepare("UPDATE actions SET status = 'expired' WHERE id = ?").run(a.id);
    return rows.map((a) => ({ ...a, status: "expired" as const }));
  });
}

/** An approved action has been carried out (e.g. its job was enqueued). */
export function markExecuted(db: Db, id: string, result: unknown): boolean {
  return Number(db.prepare("UPDATE actions SET status = 'executed', result_json = ? WHERE id = ? AND status = 'approved'")
    .run(JSON.stringify(result ?? null), id).changes) === 1;
}

export function setActionMessage(db: Db, id: string, messageId: string): void {
  db.prepare("UPDATE actions SET channel_message_id = ? WHERE id = ?").run(messageId, id);
}
