import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AsyncQueue, enqueue, getJob, lease, openDb, recoverExpired,
  type Db, type HarnessAdapter, type RunEvent, type RunResult, type StartOpts,
} from "@catapult/core";
import { loadConfig } from "./config.ts";
import { runJob, type RunnerDeps } from "./runner.ts";
import { builtinWorkers } from "./workers.ts";

let dir: string, db: Db, deps: RunnerDeps;
const seen: StartOpts[] = [];

function fakeAdapter(behavior: (o: StartOpts) => Promise<RunResult> | RunResult, hold?: Promise<void>): HarnessAdapter {
  return {
    name: "claude",
    start(o) {
      seen.push(o);
      const events = new AsyncQueue<RunEvent>();
      const done = (async () => {
        events.push({ kind: "started", sessionId: "sess-x", transcriptPath: "/t.jsonl" });
        if (hold) await hold;
        const r = await behavior(o);
        events.close();
        return r;
      })();
      return { events, done, send: async () => {}, cancel: async () => { events.close(); } };
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cat-run-"));
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  db = openDb(":memory:");
  db.prepare("INSERT INTO projects (id, local_path, created_at) VALUES ('p', ?, 0)").run(repo);
  seen.length = 0;
  const config = { ...loadConfig({ CATAPULT_ROOT: dir, HOME: dir }), owner: "test-owner", leaseMs: 60_000 };
  deps = { db, config, adapters: { claude: fakeAdapter(() => ({ reason: "completed", finalText: "ok" })), pi: fakeAdapter(() => ({ reason: "completed", finalText: "" })) }, workers: builtinWorkers, heartbeatMs: 50 };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const queued = (tier: "trusted" | "unsandboxed" = "unsandboxed", extra = {}) => {
  enqueue(db, { project_id: "p", worker: "noop", tier, ...extra });
  return lease(db, { owner: "test-owner", leaseMs: 60_000 })!;
};

describe("runJob", () => {
  it("runs to success, records run + session, and removes the worktree", async () => {
    const job = queued();
    await runJob(deps, job).done;
    expect(getJob(db, job.id)!.status).toBe("succeeded");
    const run = db.prepare("SELECT * FROM runs WHERE job_id = ?").get(job.id) as any;
    expect(run).toMatchObject({ harness: "claude", session_id: "sess-x", exit_reason: "completed" });
    expect(existsSync(run.worktree_path)).toBe(false);
    expect(db.prepare("SELECT status, driver, origin FROM sessions WHERE session_id = 'sess-x'").get()).toMatchObject({ status: "idle", driver: "none", origin: "job" });
  });

  it("keeps the worktree when the agent left changes", async () => {
    deps.adapters.claude = fakeAdapter((o) => { writeFileSync(join(o.cwd, "out.txt"), "x"); return { reason: "completed", finalText: "" }; });
    const job = queued();
    await runJob(deps, job).done;
    const run = db.prepare("SELECT worktree_path FROM runs WHERE job_id = ?").get(job.id) as any;
    expect(existsSync(join(run.worktree_path, "out.txt"))).toBe(true);
    expect(getJob(db, job.id)!.status).toBe("succeeded");
  });

  it("runs the agent inside the worktree, not the main clone", async () => {
    const job = queued();
    await runJob(deps, job).done;
    expect(seen[0]!.cwd).toContain(join(dir, "worktrees", "p"));
    expect(seen[0]!.unattended).toBe(true);
  });

  it("retries a failed run then gives up, keeping the worktree for inspection", async () => {
    deps.adapters.claude = fakeAdapter(() => ({ reason: "error", finalText: "", error: "kaput" }));
    const job = queued();
    await runJob(deps, job).done;
    expect(getJob(db, job.id)).toMatchObject({ status: "queued", error: "kaput" });
    const run = db.prepare("SELECT worktree_path FROM runs WHERE job_id = ?").get(job.id) as any;
    expect(existsSync(run.worktree_path)).toBe(true);
  });

  it("fails cleanly for an unknown worker", async () => {
    enqueue(db, { project_id: "p", worker: "nope", tier: "unsandboxed", max_attempts: 1 });
    const job = lease(db, { owner: "test-owner", leaseMs: 1000 })!;
    await runJob(deps, job).done;
    expect(getJob(db, job.id)).toMatchObject({ status: "failed", error: "unknown worker 'nope'" });
  });

  it("wraps sandboxed tiers with an srt settings file that contains the worktree", async () => {
    let wrapped: string[] = [];
    deps.wrap = (_j, settingsPath, argv) => { wrapped = [settingsPath, ...argv]; return argv; };
    deps.adapters.claude = fakeAdapter((o) => { o.wrap!(["claude"]); return { reason: "completed", finalText: "" }; });
    const job = queued("trusted");
    await runJob(deps, job).done;
    expect(wrapped[0]).toMatch(/srt\/.+\.json$/);
    expect(seen[0]!.wrap).toBeDefined();
  });

  it("does not wrap unsandboxed jobs", async () => {
    await runJob(deps, queued("unsandboxed")).done;
    expect(seen[0]!.wrap).toBeUndefined();
  });

  it("cancel leaves the job cancelled", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    deps.adapters.claude = fakeAdapter(() => ({ reason: "cancelled", finalText: "" }), hold);
    const job = queued();
    const active = runJob(deps, job);
    await new Promise((r) => setTimeout(r, 100));
    db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(job.id);
    const c = active.cancel();
    release();
    await Promise.all([c, active.done]);
    expect(getJob(db, job.id)!.status).toBe("cancelled");
  });
});

describe("crash recovery", () => {
  it("a job whose runner died is requeued when the lease expires", () => {
    const job = queued("unsandboxed", { max_attempts: 3 });
    db.prepare("UPDATE jobs SET status = 'running', lease_until = 1 WHERE id = ?").run(job.id);
    expect(recoverExpired(db, 10).requeued).toEqual([job.id]);
    expect(getJob(db, job.id)!.status).toBe("queued");
  });
});
