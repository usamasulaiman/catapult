import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db.ts";
import { cancel, complete, enqueue, fail, getJob, heartbeat, lease, markRunning, recoverExpired } from "./queue.ts";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  const ins = db.prepare("INSERT INTO projects (id, local_path, created_at) VALUES (?, ?, 0)");
  ins.run("p1", "/tmp/p1");
  ins.run("p2", "/tmp/p2");
});

const job = (o: Partial<Parameters<typeof enqueue>[1]> = {}) =>
  enqueue(db, { project_id: "p1", worker: "noop", tier: "trusted", ...o }, 1000);

describe("enqueue", () => {
  it("is idempotent on idempotency_key", () => {
    const a = job({ idempotency_key: "k" });
    const b = job({ idempotency_key: "k" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
  });
  it("rejects invalid tier", () => {
    expect(() => job({ tier: "nope" as never })).toThrow();
  });
});

describe("lease", () => {
  it("leases the oldest ready job and counts the attempt", () => {
    const a = job({ run_after: 1000 }).job;
    job({ run_after: 2000 });
    const l = lease(db, { owner: "o1", leaseMs: 5000, now: 3000 })!;
    expect(l.id).toBe(a.id);
    expect(l.status).toBe("leased");
    expect(l.attempts).toBe(1);
    expect(l.lease_until).toBe(8000);
  });
  it("skips jobs not yet due", () => {
    job({ run_after: 9000 });
    expect(lease(db, { owner: "o", leaseMs: 1, now: 3000 })).toBeUndefined();
  });
  it("never hands the same job to two owners", () => {
    job();
    expect(lease(db, { owner: "a", leaseMs: 1000, now: 2000 })).toBeDefined();
    expect(lease(db, { owner: "b", leaseMs: 1000, now: 2000 })).toBeUndefined();
  });
  it("enforces the global cap", () => {
    job(); job();
    lease(db, { owner: "a", leaseMs: 1000, globalCap: 1, now: 2000 });
    expect(lease(db, { owner: "b", leaseMs: 1000, globalCap: 1, now: 2000 })).toBeUndefined();
  });
  it("enforces the per project+worker cap but lets other projects through", () => {
    const a = job().job;
    job();
    const other = enqueue(db, { project_id: "p2", worker: "noop", tier: "trusted" }, 1001).job;
    lease(db, { owner: "a", leaseMs: 1000, perProjectCap: 1, now: 2000 });
    const next = lease(db, { owner: "b", leaseMs: 1000, perProjectCap: 1, now: 2000 })!;
    expect(next.id).toBe(other.id);
    expect(next.id).not.toBe(a.id);
  });
});

describe("lifecycle", () => {
  it("heartbeat extends only for the owner", () => {
    const j = job().job;
    lease(db, { owner: "a", leaseMs: 1000, now: 2000 });
    expect(heartbeat(db, j.id, "b", 1000, 2500)).toBe(false);
    expect(heartbeat(db, j.id, "a", 1000, 2500)).toBe(true);
    expect(getJob(db, j.id)!.lease_until).toBe(3500);
  });
  it("complete requires ownership", () => {
    const j = job().job;
    lease(db, { owner: "a", leaseMs: 1000, now: 2000 });
    markRunning(db, j.id, "a");
    expect(complete(db, j.id, "b")).toBe(false);
    expect(complete(db, j.id, "a")).toBe(true);
    expect(getJob(db, j.id)!.status).toBe("succeeded");
  });
  it("fail retries with backoff, then fails for good", () => {
    const j = job({ max_attempts: 2 }).job;
    lease(db, { owner: "a", leaseMs: 1000, now: 2000 });
    expect(fail(db, j.id, "a", "boom", 2000, 10_000)).toBe("queued");
    expect(getJob(db, j.id)!.run_after).toBe(12_000);
    expect(lease(db, { owner: "a", leaseMs: 1000, now: 5000 })).toBeUndefined();
    lease(db, { owner: "a", leaseMs: 1000, now: 12_000 });
    expect(fail(db, j.id, "a", "boom2", 12_000)).toBe("failed");
    expect(getJob(db, j.id)!.error).toBe("boom2");
  });
  it("cancel is a no-op on finished jobs", () => {
    const j = job().job;
    expect(cancel(db, j.id)).toBe("queued");
    expect(cancel(db, j.id)).toBeUndefined();
  });
});

describe("recoverExpired", () => {
  it("requeues expired leases and fails those out of attempts", () => {
    const a = job({ max_attempts: 2 }).job;
    lease(db, { owner: "dead", leaseMs: 1000, now: 2000 });
    expect(recoverExpired(db, 2500)).toEqual({ requeued: [], failed: [] });
    expect(recoverExpired(db, 4000).requeued).toEqual([a.id]);
    lease(db, { owner: "dead", leaseMs: 1000, now: 4000 });
    expect(recoverExpired(db, 9000).failed).toEqual([a.id]);
    expect(getJob(db, a.id)!.status).toBe("failed");
  });
  it("leaves needs_input jobs alone", () => {
    const a = job().job;
    lease(db, { owner: "o", leaseMs: 1000, now: 2000 });
    markRunning(db, a.id, "o");
    db.prepare("UPDATE jobs SET status = 'needs_input' WHERE id = ?").run(a.id);
    expect(recoverExpired(db, 99_999)).toEqual({ requeued: [], failed: [] });
  });
});
