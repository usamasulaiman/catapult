import type { Db } from "@catapult/core";

export interface WorkerStats {
  worker: string;
  runs: number;
  succeeded: number;
  success_rate: number;
  median_cost_usd: number | null;
  cost_usd_7d: number;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Per-worker success rate and cost over the last 7 days, so you can see which workers earn their tokens. */
export function workerStats(db: Db, now = Date.now()): WorkerStats[] {
  const rows = db.prepare(
    `SELECT j.worker, r.exit_reason, r.cost_usd, j.status FROM runs r JOIN jobs j ON j.id = r.job_id WHERE r.started_at >= ?`,
  ).all(now - 7 * 86_400_000) as { worker: string; exit_reason: string | null; cost_usd: number | null; status: string }[];
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.worker, [...(by.get(r.worker) ?? []), r]);
  return [...by].map(([worker, rs]) => {
    const succeeded = rs.filter((r) => r.exit_reason === "completed" && r.status === "succeeded").length;
    const costs = rs.map((r) => r.cost_usd).filter((c): c is number => c !== null);
    return {
      worker, runs: rs.length, succeeded, success_rate: rs.length ? succeeded / rs.length : 0,
      median_cost_usd: median(costs), cost_usd_7d: costs.reduce((a, b) => a + b, 0),
    };
  }).sort((a, b) => a.worker.localeCompare(b.worker));
}

/** Spend since local midnight. */
export function costToday(db: Db, now = new Date()): number {
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  return Number((db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM runs WHERE started_at >= ?").get(midnight.getTime()) as any).c);
}

export function queueCounts(db: Db): Record<string, number> {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as { status: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
