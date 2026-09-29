export type Tier = "interactive" | "trusted" | "untrusted" | "unsandboxed";
export type JobStatus = "queued" | "leased" | "running" | "needs_input" | "succeeded" | "failed" | "cancelled";

export interface Budget {
  max_turns?: number;
  max_wall_seconds?: number;
  max_cost_usd?: number;
  max_rounds?: number;
}

export interface Job {
  id: string;
  project_id: string;
  worker: string;
  input: unknown;
  tier: Tier;
  status: JobStatus;
  idempotency_key: string | null;
  attempts: number;
  max_attempts: number;
  run_after: number;
  lease_owner: string | null;
  lease_until: number | null;
  budget: Budget;
  parent_job_id: string | null;
  schedule_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface Project {
  id: string;
  repo_full_name: string | null;
  default_branch: string;
  local_path: string;
  config: Record<string, unknown>;
}
