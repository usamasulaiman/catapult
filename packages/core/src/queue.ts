import { randomUUID } from "node:crypto";
import { tx, type Db } from "./db.ts";
import type { Budget, Job, Tier } from "./types.ts";

export interface EnqueueOpts {
  project_id: string;
  worker: string;
  input?: unknown;
  tier: Tier;
  idempotency_key?: string;
  max_attempts?: number;
  run_after?: number;
  budget?: Budget;
  parent_job_id?: string;
  schedule_id?: string;
}

export interface LeaseOpts {
  owner: string;
  leaseMs: number;
  /** Max jobs in leased|running across all projects. */
  globalCap?: number;
  /** Max jobs in leased|running per project+worker. */
  perProjectCap?: number;
  now?: number;
}

type Row = Record<string, unknown>;

function toJob(r: Row): Job {
  return {
    ...(r as unknown as Job),
    input: JSON.parse(r.input_json as string),
    budget: JSON.parse(r.budget_json as string),
  };
}

/** Insert a job. If idempotency_key already exists, returns the existing job (created=false). */
export function enqueue(db: Db, o: EnqueueOpts, now = Date.now()): { job: Job; created: boolean } {
  return tx(db, () => {
    if (o.idempotency_key) {
      const ex = db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(o.idempotency_key);
      if (ex) return { job: toJob(ex as Row), created: false };
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO jobs (id, project_id, worker, input_json, tier, idempotency_key, max_attempts,
                         run_after, budget_json, parent_job_id, schedule_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, o.project_id, o.worker, JSON.stringify(o.input ?? {}), o.tier, o.idempotency_key ?? null,
      o.max_attempts ?? 2, o.run_after ?? now, JSON.stringify(o.budget ?? {}),
      o.parent_job_id ?? null, o.schedule_id ?? null, now, now,
    );
    return { job: getJob(db, id)!, created: true };
  });
}

export function getJob(db: Db, id: string): Job | undefined {
  const r = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  return r ? toJob(r as Row) : undefined;
}

/** Atomically lease the oldest ready job that fits the concurrency caps. */
export function lease(db: Db, o: LeaseOpts): Job | undefined {
  const now = o.now ?? Date.now();
  return tx(db, () => {
    const active = db.prepare("SELECT project_id, worker FROM jobs WHERE status IN ('leased','running')").all() as
      { project_id: string; worker: string }[];
    if (o.globalCap !== undefined && active.length >= o.globalCap) return undefined;

    const ready = db
      .prepare("SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY run_after, created_at")
      .all(now) as Row[];
    for (const r of ready) {
      const n = active.filter((a) => a.project_id === r.project_id && a.worker === r.worker).length;
      if (o.perProjectCap !== undefined && n >= o.perProjectCap) continue;
      db.prepare(
        `UPDATE jobs SET status = 'leased', lease_owner = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = ?`,
      ).run(o.owner, now + o.leaseMs, now, r.id as string);
      return getJob(db, r.id as string);
    }
    return undefined;
  });
}

/** Extend a lease. Returns false if the caller no longer owns the job. */
export function heartbeat(db: Db, id: string, owner: string, leaseMs: number, now = Date.now()): boolean {
  const res = db
    .prepare(
      `UPDATE jobs SET lease_until = ?, updated_at = ?
       WHERE id = ? AND lease_owner = ? AND status IN ('leased','running','needs_input')`,
    )
    .run(now + leaseMs, now, id, owner);
  return Number(res.changes) === 1;
}

export function markRunning(db: Db, id: string, owner: string, now = Date.now()): boolean {
  const res = db
    .prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND lease_owner = ? AND status IN ('leased','needs_input')")
    .run(now, id, owner);
  return Number(res.changes) === 1;
}

export function markNeedsInput(db: Db, id: string, owner: string, now = Date.now()): boolean {
  const res = db
    .prepare("UPDATE jobs SET status = 'needs_input', updated_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'")
    .run(now, id, owner);
  return Number(res.changes) === 1;
}

export function complete(db: Db, id: string, owner: string, now = Date.now()): boolean {
  const res = db
    .prepare(
      `UPDATE jobs SET status = 'succeeded', lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND lease_owner = ? AND status IN ('leased','running','needs_input')`,
    )
    .run(now, id, owner);
  return Number(res.changes) === 1;
}

/**
 * Record a failure. Retries with exponential backoff until max_attempts, then fails for good.
 * Returns the resulting status.
 */
export function fail(
  db: Db, id: string, owner: string, error: string, now = Date.now(), baseBackoffMs = 30_000,
): "queued" | "failed" | undefined {
  return tx(db, () => {
    const j = getJob(db, id);
    if (!j || j.lease_owner !== owner || !["leased", "running", "needs_input"].includes(j.status)) return undefined;
    if (j.attempts < j.max_attempts) {
      const runAfter = now + baseBackoffMs * 2 ** (j.attempts - 1);
      db.prepare(
        `UPDATE jobs SET status = 'queued', lease_owner = NULL, lease_until = NULL, run_after = ?, error = ?, updated_at = ?
         WHERE id = ?`,
      ).run(runAfter, error, now, id);
      return "queued";
    }
    db.prepare(
      `UPDATE jobs SET status = 'failed', lease_owner = NULL, lease_until = NULL, error = ?, updated_at = ? WHERE id = ?`,
    ).run(error, now, id);
    return "failed";
  });
}

/** Cancel a job that is not already finished. Returns the previous status if it changed. */
export function cancel(db: Db, id: string, now = Date.now()): Job["status"] | undefined {
  return tx(db, () => {
    const j = getJob(db, id);
    if (!j || ["succeeded", "failed", "cancelled"].includes(j.status)) return undefined;
    db.prepare(
      "UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?",
    ).run(now, id);
    return j.status;
  });
}

/**
 * Return jobs whose lease expired to the queue (or fail them if out of attempts).
 * needs_input jobs are exempt: they wait on a human, not a process.
 */
export function recoverExpired(db: Db, now = Date.now()): { requeued: string[]; failed: string[] } {
  const rows = db
    .prepare("SELECT id, lease_owner FROM jobs WHERE status IN ('leased','running') AND lease_until < ?")
    .all(now) as { id: string; lease_owner: string }[];
  const out = { requeued: [] as string[], failed: [] as string[] };
  for (const r of rows) {
    const res = fail(db, r.id, r.lease_owner, "lease expired", now, 0);
    if (res === "queued") out.requeued.push(r.id);
    else if (res === "failed") out.failed.push(r.id);
  }
  return out;
}
