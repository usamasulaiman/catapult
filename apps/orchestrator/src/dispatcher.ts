import { lease, recoverExpired } from "@catapult/core";
import { fireDueSchedules } from "./cron.ts";
import { runJob, type ActiveRun, type RunnerDeps } from "./runner.ts";

/** Leases ready jobs up to the caps and runs them. The only writer of job state besides the API. */
export class Dispatcher {
  private active = new Map<string, ActiveRun>();
  private timer?: NodeJS.Timeout;
  private lastMinute = -1;

  private deps: RunnerDeps;

  constructor(deps: RunnerDeps) { this.deps = deps; }

  get activeCount(): number { return this.active.size; }

  tick(now = new Date()): void {
    const { db, config } = this.deps;
    recoverExpired(db, now.getTime());
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute !== this.lastMinute) { this.lastMinute = minute; fireDueSchedules(db, now); }
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

  /** Ask a running job's process to stop. The API has already marked the job cancelled. */
  async cancel(jobId: string): Promise<void> { await this.active.get(jobId)?.cancel(); }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.active.values()].map((r) => r.cancel()));
  }
}
