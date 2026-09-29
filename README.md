# catapult

Single-user orchestrator for coding agents: schedules, runs, tracks and reports work across your projects, for Claude Code and pi. Runs on the dev host provisioned by [rock](../linux-hardening); agent config comes from [conveyer](../conveyer). Design: [`docs/guide.md`](docs/guide.md) (shared) and [`docs/plan.md`](docs/plan.md) (this repo).

## Status
F1 core: SQLite schema + leased queue, srt sandbox profiles, `claude`/`pi` drivers, worktree runner, session index from hooks, cron schedules, HTTP API, CLI. Not yet: PR babysitter, Telegram, PostHog triage, groomer, UI (see plan phases F2+).

## Develop
```sh
pnpm install
pnpm test        # vitest
pnpm typecheck
```
Node 24 runs the `.ts` sources directly (type stripping), so there is no build step.

## Use
```sh
node apps/orchestrator/src/cli.ts serve                       # CATAPULT_ROOT=/srv/catapult by default
catapult project add web ~/code/web --repo me/web --harness claude
catapult run noop --project web --tier unsandboxed --prompt "add a hello.txt"
catapult jobs; catapult sessions
catapult takeover claude <session>                            # prints `claude --resume <id>`
```
Tiers `trusted`/`untrusted` run under `srt` (install via rock's `sandbox` and `harnesses` modules); `unsandboxed` runs the harness directly. A job's worktree is kept when it holds changes or commits, and removed when clean.

Deploy: `deploy/install.sh` (systemd unit, Doppler-injected env) and `deploy/litestream.yml` (replication).
