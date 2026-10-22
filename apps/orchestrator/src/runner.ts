import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  complete, fail, getJob, heartbeat, markNeedsInput, markRunning,
  type Db, type HarnessAdapter, type HarnessName, type Job, type RunHandle, type RunResult, type Tier,
} from "@catapult/core";
import { buildSettings, isSandboxed, wrapCommand } from "@catapult/sandbox";
import type { Config } from "./config.ts";
import { esc, nullNotifier } from "./notify/telegram.ts";
import { loadProject, settingsFor } from "./project-config.ts";
import { createWorktree, forceRemoveWorktree, removeWorktree, type Worktree } from "./worktree.ts";
import type { Outcome, Services, Worker, WorkerContext } from "./workers/index.ts";

export interface RunnerDeps {
  db: Db;
  config: Config;
  adapters: Record<HarnessName, HarnessAdapter>;
  workers: Record<string, Worker>;
  services?: Services;
  /** Heartbeat period; defaults to a third of the lease. */
  heartbeatMs?: number;
  /** Test hook: override the srt wrapper. */
  wrap?: (job: Job, settingsPath: string, argv: string[]) => string[];
}

export interface ActiveRun {
  job: Job;
  /** Session id once the harness reported it. */
  readonly sessionId: string | undefined;
  send(message: string): Promise<void>;
  cancel(): Promise<void>;
  done: Promise<void>;
}

const TIER_RANK: Record<Tier, number> = { unsandboxed: 0, interactive: 0, trusted: 1, untrusted: 2 };
/** A worker may move a job to a stricter tier, never a looser one. */
export function tighten(tier: Tier, wanted?: Tier): Tier {
  return wanted && TIER_RANK[wanted] > TIER_RANK[tier] ? wanted : tier;
}

const EXEC_TIMEOUT_MS = 15 * 60_000;

/** Run `sh -c command` in cwd (wrapped by the sandbox) and capture the tail of its output. */
export function execIn(cwd: string, command: string, wrap: (argv: string[]) => string[] = (a) => a): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const argv = wrap(["sh", "-c", command]);
    const child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const add = (c: Buffer) => { out = (out + c.toString()).slice(-8000); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const t = setTimeout(() => child.kill("SIGKILL"), EXEC_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(t); resolve({ ok: false, output: e.message }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ ok: code === 0, output: out }); });
  });
}

/** Run one leased job to a terminal state. Never throws: failures go through queue.fail. */
export function runJob(deps: RunnerDeps, job: Job): ActiveRun {
  const { db, config } = deps;
  const services = deps.services ?? { notify: nullNotifier, tracker: () => undefined, propose: async () => { throw new Error("no action service"); } };
  let handle: RunHandle | undefined;
  let cancelled = false;
  let sessionId: string | undefined;

  const done = (async () => {
    let wt: Worktree | undefined;
    let reused = false;
    const runId = randomUUID();
    let hb: NodeJS.Timeout | undefined;
    try {
      const project = loadProject(db, job.project_id);
      const worker = deps.workers[job.worker];
      if (!worker) throw new Error(`unknown worker '${job.worker}'`);
      const settings = settingsFor(project);
      const ctx: WorkerContext = { db, job, project, settings, services };

      markRunning(db, job.id, config.owner);
      const input = worker.prepare ? await worker.prepare(job.input as any, ctx) : job.input;
      if (input === null) {
        complete(db, job.id, config.owner);
        return;
      }
      const tier = tighten(job.tier, worker.tier?.(input));
      const harness = worker.harness?.(input) ?? settings.harness;
      const adapter = deps.adapters[harness];

      const checkout = worker.checkout
        ? await worker.checkout(input, ctx)
        : { branch: `catapult/${job.worker}/${job.id.slice(0, 8)}`, base: project.default_branch };
      if ("reuse" in checkout) {
        wt = { path: checkout.reuse, branch: "" };
        reused = true;
      } else {
        wt = await createWorktree({
          repo: project.local_path, root: config.worktreesDir, project: project.id, jobId: job.id,
          branch: checkout.branch, base: checkout.base,
        });
      }

      let wrap: ((argv: string[]) => string[]) | undefined;
      if (isSandboxed(tier)) {
        const sb = buildSettings({
          tier, worktree: wt.path, home: config.home, dataDir: config.dataDir, projectDomains: settings.allow_domains,
        });
        const dir = join(config.dataDir, "srt");
        await mkdir(dir, { recursive: true });
        const settingsPath = join(dir, `${job.id}.json`);
        await writeFile(settingsPath, JSON.stringify(sb, null, 2), { mode: 0o600 });
        wrap = deps.wrap ? (argv) => deps.wrap!(job, settingsPath, argv) : (argv) => wrapCommand(tier, settingsPath, argv);
      }
      const exec = (command: string) => execIn(wt!.path, command, wrap);

      db.prepare("INSERT INTO runs (id, job_id, harness, worktree_path, started_at) VALUES (?, ?, ?, ?, ?)")
        .run(runId, job.id, harness, wt.path, Date.now());

      if (settings.setup && !reused) {
        const r = await exec(settings.setup);
        if (!r.ok) throw new Error(`setup failed: ${r.output.slice(-1000)}`);
      }

      const run = adapter.start({
        cwd: wt.path, prompt: worker.prompt(input, project, settings), budget: job.budget,
        wrap, unattended: true, resume: worker.resume?.(input),
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
             ON CONFLICT (harness, session_id) DO UPDATE SET status = 'working', driver = 'runner', conflict = 0,
               transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path), last_event_at = excluded.last_event_at`,
          ).run(harness, ev.sessionId, project.id, wt.path, ev.transcriptPath ?? null, Date.now());
        } else if (ev.kind === "needs_input") {
          markNeedsInput(db, job.id, config.owner);
        }
      }
      const result = await run.done;
      const r = { ...result, sessionId: result.sessionId ?? sessionId };

      let outcome: Outcome | undefined;
      if (!cancelled && r.reason === "completed" && worker.evaluate) {
        outcome = await worker.evaluate({ ...ctx, input, runId, worktree: wt, result: r, exec })
          .catch((e: Error) => ({ status: "failed" as const, error: `evaluate: ${e.message}` }));
      }
      finalize(db, deps, services, job, runId, harness, r, cancelled, outcome);

      const ok = !cancelled && r.reason === "completed" && (!outcome || outcome.status === "succeeded");
      if (ok && !reused) {
        if (outcome?.status === "succeeded" && outcome.keepWorktree === false) await forceRemoveWorktree(project.local_path, wt).catch(() => {});
        else await removeWorktree(project.local_path, wt, "base" in checkout ? checkout.base : project.default_branch).catch(() => {});
      }
    } catch (err) {
      const status = fail(db, job.id, config.owner, (err as Error).message);
      db.prepare("UPDATE runs SET ended_at = ?, exit_reason = 'error' WHERE id = ? AND ended_at IS NULL").run(Date.now(), runId);
      if (status === "failed") await services.notify.send(`❌ <b>${job.worker}</b> on ${job.project_id} failed: ${esc((err as Error).message)}`);
    } finally {
      if (hb) clearInterval(hb);
    }
  })();

  return {
    job,
    done,
    get sessionId() { return sessionId; },
    send: async (message) => { if (!handle) throw new Error("run has not started"); await handle.send(message); },
    cancel: async () => { cancelled = true; await handle?.cancel(); },
  };
}

function finalize(
  db: Db, deps: RunnerDeps, services: Services, job: Job, runId: string, harness: HarnessName,
  r: RunResult, cancelled: boolean, outcome?: Outcome,
) {
  const owner = deps.config.owner;
  const summary = outcome?.status === "succeeded" ? outcome.summary : outcome?.status === "needs_input" ? outcome.reason : undefined;
  db.prepare(
    "UPDATE runs SET ended_at = ?, exit_reason = ?, cost_usd = ?, tokens_in = ?, tokens_out = ?, session_id = COALESCE(?, session_id), artifact_json = ? WHERE id = ?",
  ).run(Date.now(), cancelled ? "cancelled" : r.reason, r.costUsd ?? null, r.tokensIn ?? null, r.tokensOut ?? null,
    r.sessionId ?? null, JSON.stringify({ finalText: r.finalText, error: r.error, summary }), runId);
  if (r.sessionId) {
    // Release the runner's claim so the session can be taken over or resumed.
    db.prepare("UPDATE sessions SET status = ?, driver = 'none', last_event_at = ? WHERE harness = ? AND session_id = ?")
      .run(r.reason === "completed" ? "idle" : "ended", Date.now(), harness, r.sessionId);
  }
  // A cancel already moved the job to 'cancelled'; don't resurrect it.
  if (cancelled || getJob(db, job.id)?.status === "cancelled") return;
  const tag = `<b>${esc(job.worker)}</b> on ${esc(job.project_id)} (job ${job.id.slice(0, 8)})`;
  if (r.reason === "completed" && (!outcome || outcome.status === "succeeded")) {
    complete(db, job.id, owner);
  } else if (r.reason === "needs_input" || outcome?.status === "needs_input") {
    markNeedsInput(db, job.id, owner);
    void services.notify.send(`✋ ${tag} needs input: ${esc(summary ?? r.finalText.slice(0, 500))}`);
  } else {
    const error = outcome?.status === "failed" ? outcome.error : r.error ?? r.reason;
    if (fail(db, job.id, owner, error) === "failed") void services.notify.send(`❌ ${tag} failed: ${esc(error)}`);
  }
}
