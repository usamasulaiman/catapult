import { enqueue, type Db } from "@catapult/core";

function parseField(f: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of f.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step in '${f}'`);
    let lo = min, hi = max;
    if (range !== "*") {
      const [a, b] = range!.split("-");
      lo = Number(a);
      hi = b === undefined ? (stepStr ? max : lo) : Number(b);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) throw new Error(`bad cron field '${f}'`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Standard 5-field cron (min hour dom month dow), evaluated in local time. dow: 0 or 7 = Sunday. */
export function cronMatches(expr: string, d: Date): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron needs 5 fields: '${expr}'`);
  const dow = parseField(f[4]!, 0, 7);
  if (dow.has(7)) dow.add(0);
  const dom = parseField(f[2]!, 1, 31), dowStar = f[4] === "*", domStar = f[2] === "*";
  const domOk = dom.has(d.getDate()), dowOk = dow.has(d.getDay());
  // Vixie cron: if both are restricted, either may match.
  const dayOk = !domStar && !dowStar ? domOk || dowOk : domOk && dowOk;
  return parseField(f[0]!, 0, 59).has(d.getMinutes()) && parseField(f[1]!, 0, 23).has(d.getHours())
    && parseField(f[3]!, 1, 12).has(d.getMonth() + 1) && dayOk;
}

/**
 * Enqueue a job for every enabled schedule due this minute. Idempotent per schedule+minute,
 * so overlapping ticks or a restart within the minute can't double-fire.
 */
export function fireDueSchedules(db: Db, now = new Date()): string[] {
  const minute = Math.floor(now.getTime() / 60_000);
  const rows = db.prepare("SELECT * FROM schedules WHERE enabled = 1").all() as any[];
  const fired: string[] = [];
  for (const s of rows) {
    let due = false;
    try { due = cronMatches(s.cron, now); } catch { continue; }
    if (!due) continue;
    const { job, created } = enqueue(db, {
      project_id: s.project_id, worker: s.worker, input: JSON.parse(s.input_json),
      tier: "trusted", schedule_id: s.id, idempotency_key: `schedule:${s.id}:${minute}`,
    });
    if (created) fired.push(job.id);
  }
  return fired;
}
