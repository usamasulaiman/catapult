import { lease, recoverExpired } from "@catapult/core";
import { fireDueSchedules } from "./cron.ts";
import { costToday } from "./metrics.ts";
import { runJob, type ActiveRun, type RunnerDeps } from "./runner.ts";

/** Leases ready jobs up to the caps and runs them. The only writer of job state besides the API. */
export class Dispatcher {
  private active = new Map<string, ActiveRun>();
  private timer?: NodeJS.Timeout;
  private lastMinute = -1;
  private capped = false;

  private deps: RunnerDeps;

  constructor(deps: RunnerDeps) { this.deps = deps; }

  get activeCount(): number { return this.active.size; }

  tick(now = new Date()): void {
    const { db, config } = this.deps;
    recoverExpired(db, now.getTime());
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute !== this.lastMinute) { this.lastMinute = minute; fireDueSchedules(db, now); }
    if (config.dailyCostUsd > 0 && costToday(db, now) >= config.dailyCostUsd) {
      if (!this.capped) console.warn(`daily cost cap $${config.dailyCostUsd} reached; not leasing until tomorrow`);
      this.capped = true;
      return;
    }
    this.capped = false;
    for (;;) {
      const job = lease(db, {
        owner: config.owner, leaseMs: config.leaseMs,
        globalCap: config.globalCap, perProjectCap: config.perProjectCap, now: now.getTime(),
      });
      if (!job) return;
      const run = runJob(this.deps, job);
      this.active.set(job.id, run);
      void run.done.finally(() => this.active.delete(job.id));
    }
  }

  start(everyMs = 2000): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), everyMs);
  }

  /** Sessions currently driven by a live run, as `harness:session_id`. */
  liveSessions(): Set<string> {
    const out = new Set<string>();
    for (const r of this.active.values()) {
      if (!r.sessionId) continue;
      const harness = this.deps.db.prepare("SELECT harness FROM runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1").get(r.job.id) as { harness: string } | undefined;
      if (harness) out.add(`${harness.harness}:${r.sessionId}`);
    }
    return out;
  }

  /** Steer the live run driving a session. Returns false if no run is driving it. */
  async send(sessionId: string, message: string): Promise<boolean> {
    const run = [...this.active.values()].find((r) => r.sessionId === sessionId);
    if (!run) return false;
    await run.send(message);
    return true;
  }

  /** Ask a running job's process to stop. The API has already marked the job cancelled. */
  async cancel(jobId: string): Promise<void> { await this.active.get(jobId)?.cancel(); }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.active.values()].map((r) => r.cancel()));
  }
}
