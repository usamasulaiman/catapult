import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  complete, fail, getJob, heartbeat, markNeedsInput, markRunning,
  type Db, type HarnessAdapter, type HarnessName, type Job, type Project, type RunResult,
} from "@catapult/core";
import { buildSettings, isSandboxed, wrapCommand } from "@catapult/sandbox";
import type { Config } from "./config.ts";
import { createWorktree, removeWorktree, type Worktree } from "./worktree.ts";
import type { Worker } from "./workers.ts";

export interface RunnerDeps {
  db: Db;
  config: Config;
  adapters: Record<HarnessName, HarnessAdapter>;
  workers: Record<string, Worker>;
  /** Heartbeat period; defaults to a third of the lease. */
  heartbeatMs?: number;
  /** Test hook: override the srt wrapper. */
  wrap?: (job: Job, settingsPath: string, argv: string[]) => string[];
}

export interface ActiveRun {
  job: Job;
  cancel(): Promise<void>;
  done: Promise<void>;
}

function loadProject(db: Db, id: string): Project {
  const r = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as any;
  if (!r) throw new Error(`unknown project ${id}`);
  return { ...r, config: JSON.parse(r.config_json) };
}

/** Run one leased job to a terminal state. Never throws: failures go through queue.fail. */
export function runJob(deps: RunnerDeps, job: Job): ActiveRun {
  const { db, config } = deps;
  let handle: { cancel(): Promise<void> } | undefined;
  let cancelled = false;

  const done = (async () => {
    let wt: Worktree | undefined;
    let project: Project | undefined;
    const runId = randomUUID();
    let hb: NodeJS.Timeout | undefined;
    let sessionId: string | undefined;
    try {
      project = loadProject(db, job.project_id);
      const worker = deps.workers[job.worker];
      if (!worker) throw new Error(`unknown worker '${job.worker}'`);
      const harness = (project.config.harness as HarnessName | undefined) ?? "claude";
      const adapter = deps.adapters[harness];

      wt = await createWorktree({
        repo: project.local_path, root: config.worktreesDir, project: project.id, jobId: job.id,
        branch: `catapult/${job.worker}/${job.id.slice(0, 8)}`, base: project.default_branch,
      });

      let wrap: ((argv: string[]) => string[]) | undefined;
      if (isSandboxed(job.tier)) {
        const settings = buildSettings({
          tier: job.tier, worktree: wt.path, home: config.home, dataDir: config.dataDir,
          projectDomains: (project.config.allow_domains as string[] | undefined) ?? [],
        });
        const dir = join(config.dataDir, "srt");
        await mkdir(dir, { recursive: true });
        const settingsPath = join(dir, `${job.id}.json`);
        await writeFile(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
        wrap = deps.wrap ? (argv) => deps.wrap!(job, settingsPath, argv) : (argv) => wrapCommand(job.tier, settingsPath, argv);
      }

      markRunning(db, job.id, config.owner);
      db.prepare("INSERT INTO runs (id, job_id, harness, worktree_path, started_at) VALUES (?, ?, ?, ?, ?)")
        .run(runId, job.id, harness, wt.path, Date.now());

      const run = adapter.start({
        cwd: wt.path, prompt: worker.prompt(job.input, project), budget: job.budget,
        wrap, unattended: true,
      });
      handle = run;

      hb = setInterval(() => {
        if (!heartbeat(db, job.id, config.owner, config.leaseMs)) void run.cancel();
      }, deps.heartbeatMs ?? Math.max(1000, config.leaseMs / 3));
      hb.unref();

      for await (const ev of run.events) {
        if (ev.kind === "started" && ev.sessionId) {
          sessionId = ev.sessionId;
          db.prepare("UPDATE runs SET session_id = ? WHERE id = ?").run(ev.sessionId, runId);
          db.prepare(
            `INSERT INTO sessions (harness, session_id, project_id, cwd, transcript_path, origin, status, driver, last_event_at)
             VALUES (?, ?, ?, ?, ?, 'job', 'working', 'runner', ?)
             ON CONFLICT (harness, session_id) DO UPDATE SET status = 'working', driver = 'runner', last_event_at = excluded.last_event_at`,
          ).run(harness, ev.sessionId, project.id, wt.path, ev.transcriptPath ?? null, Date.now());
        } else if (ev.kind === "needs_input") {
          markNeedsInput(db, job.id, config.owner);
        }
      }
      const result = await run.done;
      finalize(db, deps, job, runId, harness, { ...result, sessionId: result.sessionId ?? sessionId }, cancelled);

      const ok = !cancelled && result.reason === "completed";
      if (ok) await removeWorktree(project.local_path, wt, project.default_branch).catch(() => {});
    } catch (err) {
      fail(db, job.id, config.owner, (err as Error).message);
      db.prepare("UPDATE runs SET ended_at = ?, exit_reason = 'error' WHERE id = ? AND ended_at IS NULL").run(Date.now(), runId);
    } finally {
      if (hb) clearInterval(hb);
    }
  })();

  return {
    job,
    done,
    cancel: async () => { cancelled = true; await handle?.cancel(); },
  };
}

function finalize(db: Db, deps: RunnerDeps, job: Job, runId: string, harness: HarnessName, r: RunResult, cancelled: boolean) {
  const owner = deps.config.owner;
  db.prepare(
    "UPDATE runs SET ended_at = ?, exit_reason = ?, cost_usd = ?, tokens_in = ?, tokens_out = ?, session_id = COALESCE(?, session_id), artifact_json = ? WHERE id = ?",
  ).run(Date.now(), cancelled ? "cancelled" : r.reason, r.costUsd ?? null, r.tokensIn ?? null, r.tokensOut ?? null,
    r.sessionId ?? null, JSON.stringify({ finalText: r.finalText, error: r.error }), runId);
  if (r.sessionId) {
    // Release the runner's claim so the session can be taken over or resumed.
    db.prepare("UPDATE sessions SET status = ?, driver = 'none', last_event_at = ? WHERE harness = ? AND session_id = ?")
      .run(r.reason === "completed" ? "idle" : "ended", Date.now(), harness, r.sessionId);
  }
  // A cancel already moved the job to 'cancelled'; don't resurrect it.
  if (cancelled || getJob(db, job.id)?.status === "cancelled") return;
  if (r.reason === "completed") complete(db, job.id, owner);
  else if (r.reason === "needs_input") markNeedsInput(db, job.id, owner);
  else fail(db, job.id, owner, r.error ?? r.reason);
}
