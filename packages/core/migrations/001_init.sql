CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  local_path TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  worker TEXT NOT NULL,
  cron TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  worker TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  tier TEXT NOT NULL CHECK (tier IN ('interactive','trusted','untrusted','unsandboxed')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','leased','running','needs_input','succeeded','failed','cancelled')),
  idempotency_key TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  run_after INTEGER NOT NULL,
  lease_owner TEXT,
  lease_until INTEGER,
  budget_json TEXT NOT NULL DEFAULT '{}',
  parent_job_id TEXT REFERENCES jobs(id),
  schedule_id TEXT REFERENCES schedules(id),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_ready ON jobs(status, run_after);
CREATE INDEX jobs_project ON jobs(project_id, status);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  harness TEXT NOT NULL,
  session_id TEXT,
  worktree_path TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  exit_reason TEXT,
  cost_usd REAL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  artifact_json TEXT
);
CREATE INDEX runs_job ON runs(job_id);

CREATE TABLE sessions (
  harness TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  cwd TEXT,
  transcript_path TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('interactive','job')),
  status TEXT NOT NULL CHECK (status IN ('working','needs_input','idle','ended')),
  driver TEXT NOT NULL DEFAULT 'none' CHECK (driver IN ('none','runner','terminal')),
  title TEXT,
  last_event_at INTEGER NOT NULL,
  PRIMARY KEY (harness, session_id)
);
CREATE INDEX sessions_project ON sessions(project_id, status);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  harness TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX events_session ON events(harness, session_id, id);

CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  run_id TEXT REFERENCES runs(id),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','expired','executed')),
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES actions(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  approver_channel TEXT NOT NULL,
  approver_id TEXT NOT NULL,
  approver_name TEXT,
  channel_message_id TEXT,
  decided_at INTEGER NOT NULL
);

CREATE TABLE source_cursors (
  source TEXT NOT NULL,
  project_id TEXT NOT NULL,
  cursor TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source, project_id)
);

CREATE TABLE round_counters (
  project_id TEXT NOT NULL,
  worker TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  rounds INTEGER NOT NULL DEFAULT 0,
  last_diff_sha TEXT,
  PRIMARY KEY (project_id, worker, subject_key)
);
