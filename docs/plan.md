# catapult — Plan

> Follows [`guide.md`](./guide.md). Depends on rock (contract in guide §3). Works without conveyer; hooks only improve status latency.

## Goal

A single orchestrator process on the dev host (rock) that schedules, runs, tracks and reports agent work across your projects. Every session (interactive or headless, Claude Code or pi) and every job is visible and controllable from Telegram and, later, a PWA/desktop UI.

## Layout

```
catapult/
  apps/
    orchestrator/
      src/
        api/            # REST + SSE for UI; /ingest for hooks and webhooks
        scheduler/      # cron rules → jobs
        queue/          # leased jobs table, retries, concurrency
        sources/        # github, posthog pollers + webhook handlers
        trackers/       # Tracker interface: linear (primary), github, jira; chosen per project
        notify/         # telegram bot: messages, inline approvals, audit
        runner/         # worktree + srt + harness adapter → run
        sessions/       # JSONL watcher/indexer, driver locks
        cli.ts          # `catapult` CLI (talks to the API)
    ui/                 # Vite + React PWA (phase 5)
    desktop/            # Tauri shell (phase 6)
  packages/
    core/               # types, SQL schema, migrations, zod schemas for job inputs
    harness-claude/     # `claude -p` stream-json driver, transcript parser, event mapping
    harness-pi/         # `pi --mode rpc` driver, session parser, event mapping
    sandbox/            # srt profile builders per tier
  workers/
    pr-babysitter/      # worker.ts (inputs, stop rules) + prompt.md
    alert-triage/
    groomer/
  deploy/
    catapult.service     # systemd, User=dev
    litestream.yml
    install.sh
  docs/
    spike-report.md     # phase F0 output
```

## Data model (SQLite, operational only)

```sql
projects (id, repo_full_name, default_branch, local_path, config_json, created_at)

schedules (id, project_id, worker, cron, input_json, enabled, created_at, updated_at)

jobs (
  id, project_id, worker, input_json, tier,            -- interactive|trusted|untrusted|unsandboxed
  status,                                               -- queued|leased|running|needs_input|succeeded|failed|cancelled
  idempotency_key UNIQUE, attempts, max_attempts,
  run_after, lease_owner, lease_until,
  budget_json,                                          -- max_turns, max_wall_seconds, max_cost_usd, max_rounds
  parent_job_id, schedule_id, created_at, updated_at
)

runs (id, job_id, harness, session_id, worktree_path, started_at, ended_at,
      exit_reason, cost_usd, tokens_in, tokens_out, artifact_json)

sessions (                                               -- index over harness JSONL; never copies messages
  harness, session_id, project_id, cwd, transcript_path,
  origin,                                                -- interactive|job
  status,                                                -- working|needs_input|idle|ended
  driver,                                                -- none|runner|terminal
  title, last_event_at,
  PRIMARY KEY (harness, session_id)
)

events (id, harness, session_id, kind, payload_json, created_at)   -- hook + runner status events; pruned after 30 days

actions (id, job_id, run_id, kind, payload_json, status,           -- pending|approved|rejected|expired|executed
         expires_at, created_at)
approvals (id, action_id, decision, approver_channel, approver_id, approver_name,
           channel_message_id, decided_at)

source_cursors (source, project_id, cursor, updated_at)            -- polling state
round_counters (project_id, worker, subject_key, rounds, last_diff_sha)  -- e.g. subject_key = PR number
```

Migrations are plain SQL files, applied at startup. WAL mode, `busy_timeout=5000`. Only the orchestrator opens the database.

## Queue semantics

- **Enqueue** is idempotent through `idempotency_key` (for example `pr-babysitter:owner/repo#123:review-<id>`).
- **Lease:** `UPDATE … SET status='leased', lease_until=now+N WHERE status='queued' AND run_after<=now … LIMIT 1 RETURNING`. The runner heartbeats to extend the lease. Expired leases go back to `queued`.
- **Concurrency:** a global cap (for example 3) and a per-project cap (default 1 per worker type) to avoid overlapping edits.
- **Retry:** exponential backoff, `max_attempts` default 2. Agent failures are usually not transient, so keep retries low.
- **Cancel:** the API marks the job cancelled; the runner sends SIGTERM to the sandbox, then SIGKILL after a grace period.

## Harness adapter interface

```ts
interface HarnessAdapter {
  name: 'claude' | 'pi';
  start(opts: {
    cwd: string; prompt: string; systemAppend?: string;
    sandbox: SandboxProfile; budget: Budget; env: Record<string, string>;
  }): Promise<RunHandle>;
  resume(sessionId: string, prompt: string, opts: ResumeOpts): Promise<RunHandle>;
  parseTranscript(path: string): AsyncIterable<NormalizedMessage>;   // for the UI
  mapHookEvent(raw: unknown): SessionEvent | null;
  locateTranscript(sessionId: string, cwd: string): string;
}

interface RunHandle {
  sessionId: string;
  events: AsyncIterable<RunEvent>;      // started, message, tool, needs_input, usage, finished
  send(message: string): Promise<void>; // steer
  cancel(): Promise<void>;
  done: Promise<RunResult>;             // exit reason, cost, tokens, final text
}
```

- **Claude:** the CLI itself, `claude -p --input-format stream-json --output-format stream-json --verbose` (resume with `--resume <id>`), spawned inside `srt`. No SDK: the CLI is the same binary you use interactively, so sessions are identical. Claude Code's native sandbox is disabled for jobs.
- **pi:** `pi --mode rpc` under `srt`, JSONL over stdio. Split frames on `\n` only (not Node `readline`). Commands: `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `get_session_stats`.
- **Transcripts are parsed defensively** (unknown fields are ignored), with fixtures from real sessions checked into the tests.

## Session ownership (principle 5)

- The runner is the driver for job sessions while they run.
- Interactive sessions started in herdr have `driver=terminal` and are read-only in the UI.
- **Takeover:** when a job session is `idle` or `needs_input`, `catapult takeover <session>` sets `driver=terminal` and prints `claude --resume <id>` / `pi --session <…>`. The UI shows the session as taken over. Handing it back sets `driver=none`, and the runner may resume it.
- The indexer detects when a transcript is being written while `driver=runner` but the runner holds no process. It flags a conflict rather than guessing.

## Worktrees

- Path: `/srv/catapult/worktrees/<project>/<job-id>`, on a branch `catapult/<worker>/<subject>`. The PR babysitter checks out the PR's head branch instead.
- Removed after `succeeded` (unless the job produced an unmerged branch that should be kept); kept for 7 days after `failed`, for inspection.
- The main clone at `projects.local_path` is never modified by jobs.

## Sandbox profiles (`packages/sandbox`)

| Tier | Filesystem write | Network allowlist | Env |
|---|---|---|---|
| trusted | worktree, `~/.cache`, tmp | LLM APIs, github.com + api.github.com, package registries, docs domains from `.catapult.yml` | scoped GitHub token, LLM key |
| untrusted | worktree, tmp | LLM APIs, api.github.com, package registries | short-lived scoped GitHub token, LLM key |
| unsandboxed | — | — | same as trusted; only allowed for trusted input |

Reads of `~/.ssh`, `~/.config/gh`, `/srv/catapult/data` and other secrets directories are denied in every sandboxed tier.

## Per-project config

The DB is the source of truth for what the UI edits (schedules, `max_rounds`, enabled workers). An optional `.catapult.yml` in each repo holds facts about the repo itself:

```yaml
setup: pnpm install --frozen-lockfile
test: pnpm test
lint: pnpm lint
harness: claude            # default harness for jobs in this repo
tracker: linear             # linear | github | jira (per project)
allow_domains: [docs.example.com]
unsandboxed_ok: false      # true lets trusted jobs run without srt (e.g. needs Docker)
```

## Workers

Each worker is `workers/<name>/worker.ts` (an input schema, `plan()` that decides whether to run, `prompt()`, and `evaluate()` that checks the result and stop rules) plus `prompt.md`. The runner is generic; workers hold no process logic.

### PR babysitter (phase 2)
- **Trigger:** poll open PRs authored by you or catapult, every 3 min. The GitHub webhook (`pull_request_review`, `issue_comment`) only speeds this up.
- **Input:** unresolved review threads and comments since the last round, CI status.
- **Tier:** `untrusted` if any comment author is outside the allowlist, otherwise `trusted`.
- **Stop rules:** `rounds >= max_rounds` (per project, default 5); no diff produced in a round; only comments from ignored authors (for example bots you've muted); PR closed or merged. On stop, send a Telegram escalation.
- **Output:** commits pushed to the PR branch, a reply on each addressed thread saying what changed, and a run summary to Telegram.
- **Evidence:** the `test` command from `.catapult.yml` must pass before pushing. If it fails, set `needs_input`.

### Alert triage — PostHog (phase 3)
- **Sources:**
  - Polling (source of truth): the PostHog API for error-tracking issues and new or spiking exceptions since the cursor.
  - Webhook (latency): a PostHog webhook destination on `$exception` or on insight alerts, sent to Funnel `/ingest/posthog` with a shared secret.
- **Dedup:** fingerprint the issue, with one open triage per fingerprint per 24 h.
- **Tier:** `untrusted` (the payload contains user-controlled strings).
- **Output:** a report posted to Telegram (summary, likely cause, affected files, proposed fix) and stored as the run artifact. A proposed `open_draft_pr` **action** is attached.
- **On approval:** a new `trusted` job implements the fix in a worktree and opens a draft PR. The approval is recorded.

### Groomer (phase 4)
- **Tracker interface:** `Tracker { list(filter), get(id), proposeUpdate(id, patch), comment(id, body) }`. The tracker is a per-project setting (`tracker: linear|github|jira`). Implement Linear first (primary), then GitHub Issues; Jira last.
- **Schedule:** daily, plus on demand.
- **Output:** for each item that isn't ready, proposed refinements: acceptance criteria, scope, size estimate, open questions, and a "ready" label. Each is an **action**.
- **On approval:** apply the update to the source. Items marked ready can be enqueued as implementation jobs, which is a separate approval.

## Telegram bot (`notify/`)

- Long polling (`getUpdates`), so no inbound port is needed.
- Updates from user ids not in `TELEGRAM_ALLOWED_USER_IDS` are ignored.
- Each action message has inline buttons **Approve / Reject / Details**. `callback_data` carries `action_id` plus a nonce.
- Idempotent: the first decision wins; later taps reply "already decided by … at …".
- `expires_at` is enforced (default 48 h). Expired actions are edited in place to show "expired".
- Every decision writes an `approvals` row with the Telegram user id, name and message id.
- Commands: `/status`, `/jobs`, `/cancel <job>`, `/run <worker> <project>`.

## API (for CLI and UI)

```
GET  /projects                         GET  /projects/:id/schedules|jobs
POST /projects/:id/schedules           PATCH /schedules/:id
POST /jobs            (manual run)     POST /jobs/:id/cancel
GET  /sessions?project=&status=        GET  /sessions/:harness/:id/transcript   (parsed, paginated)
POST /sessions/:harness/:id/message    (steer; only if driver ∈ {none, runner})
POST /sessions/:harness/:id/takeover|release
GET  /actions?status=pending           POST /actions/:id/decision
GET  /stream                           (SSE: session status, job transitions, actions)
POST /ingest                           (hooks; loopback only)
POST /ingest/github|posthog            (Funnel; signature verified)
```

API routes bind to the Tailscale interface through `tailscale serve`. Only the `/ingest/github` and `/ingest/posthog` routes are exposed through Funnel, using a separate listener port so the two can't be confused.

## Catapult's own observability

Per run, record cost, tokens, wall time, exit reason and rounds. Per worker, record success rate and median cost. `/status` in Telegram and a UI page show these, so you can see which workers are worth their tokens.

## Phases

### F0 — Spike (guide phase 0). Output: `docs/spike-report.md`
Check each of these on amd64 **and** arm64:
- [ ] `claude -p` stream-json run → `claude --resume <id>` in a terminal continues the same conversation, and the reverse
- [ ] `pi --mode rpc` run → resumable interactively
- [ ] Both run correctly under `srt` with the untrusted allowlist: `git push` works, arbitrary curl is blocked
- [ ] Claude Code hook payloads include `session_id` and `transcript_path`; pi extension events cover start, turn end and needs input
- [ ] Transcript JSONL locations and shapes are recorded, and fixtures saved
- [ ] PostHog: which of API polling, webhook destinations and insight alerts gives exceptions most reliably

If any check fails, update the guide before F1.

### F1 — Core (guide phase 1)
- DB and migrations, queue, runner, sandbox profiles, both adapters, session indexer, CLI (`catapult run|jobs|sessions|takeover`), systemd unit, Litestream.
- **Acceptance:** `catapult run noop --project x` runs a sandboxed job that edits a file in a worktree; the session appears in `catapult sessions`; `catapult takeover` then `claude --resume` works; killing the orchestrator mid-run and restarting it recovers or fails the job cleanly (no stuck leases); a Litestream restore onto a fresh box gives back all state.

### F2 — PR babysitter + Telegram notify (guide phase 2)
- **Acceptance:** on a real PR with 3 review comments, all are addressed with tests passing, each thread gets a reply, and a Telegram summary arrives. A bot reviewer that keeps commenting is stopped at `max_rounds` with an escalation. Everything still works with webhooks disabled.

### F3 — Approvals + PostHog triage (guide phase 3)
- **Acceptance:** a PostHog exception triggered on purpose produces one report (a duplicate is suppressed); tapping Approve opens a draft PR; the `approvals` row shows who and when; a second tap is a no-op; an unapproved action expires.

### F4 — Groomer (guide phase 4)
- **Acceptance:** 5 backlog items produce proposals; only approved proposals are written back; nothing is changed without approval.

### F5 — UI, read-only (guide phase 5)
- PWA: projects → schedules and jobs; sessions list with live status (SSE); transcript viewer; pending actions.
- **Acceptance:** from your phone over Tailscale, you see an interactive herdr session and a job session update live, and can browse the jobs and schedules of any project.

### F6 — UI, interactive + desktop (guide phase 6)
- Start a session, steer, approve/reject, cancel, edit schedules; Tauri wrapper.
- **Acceptance:** start a session from the phone, steer it twice, take it over in the terminal, hand it back, and see the full history in the UI.

## Risks

| Risk | Mitigation |
|---|---|
| Harness transcript or CLI protocol changes | Adapter isolation, fixtures, pinned versions (rock) |
| `srt` doesn't fit a harness's needs (proxy, TTY) | F0 spike checks this first; fallback is to call bwrap directly plus an HTTP proxy with an allowlist |
| Cost runaway | Per-job budgets, global daily cap check in the scheduler, round limits |
| Review overload | Workers produce reports and drafts, not merges; tune schedules using the success/cost metrics |
| Scope creep in the UI | F5 is read-only; F6 only after F2–F4 are in daily use |
