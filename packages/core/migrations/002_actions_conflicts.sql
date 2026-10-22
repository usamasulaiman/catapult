-- Actions carry what the approval UI needs; channel_message_id lets Telegram edit the message in place.
ALTER TABLE actions ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE actions ADD COLUMN summary TEXT;
ALTER TABLE actions ADD COLUMN nonce TEXT;
ALTER TABLE actions ADD COLUMN channel_message_id TEXT;
ALTER TABLE actions ADD COLUMN result_json TEXT;
CREATE INDEX actions_status ON actions(status, expires_at);

-- Set by the indexer when a transcript is written while the runner claims the session but holds no process.
ALTER TABLE sessions ADD COLUMN conflict INTEGER NOT NULL DEFAULT 0;

CREATE INDEX runs_started ON runs(started_at);
