import type { Db } from "./db.ts";

export interface RoundState {
  rounds: number;
  last_diff_sha: string | null;
}

export function getRounds(db: Db, project: string, worker: string, subject: string): RoundState {
  const r = db.prepare("SELECT rounds, last_diff_sha FROM round_counters WHERE project_id = ? AND worker = ? AND subject_key = ?")
    .get(project, worker, subject) as RoundState | undefined;
  return r ?? { rounds: 0, last_diff_sha: null };
}

/** Count one completed round for a subject (e.g. a PR) and remember the head it produced. */
export function recordRound(db: Db, project: string, worker: string, subject: string, diffSha: string | null): RoundState {
  db.prepare(
    `INSERT INTO round_counters (project_id, worker, subject_key, rounds, last_diff_sha) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (project_id, worker, subject_key) DO UPDATE SET rounds = rounds + 1, last_diff_sha = excluded.last_diff_sha`,
  ).run(project, worker, subject, diffSha);
  return getRounds(db, project, worker, subject);
}
