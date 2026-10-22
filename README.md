# catapult

Single-user orchestrator for coding agents: schedules, runs, tracks and reports work across your projects, for Claude Code and pi. Runs on the dev host provisioned by [rock](../rock); agent config comes from [conveyer](../conveyer). Design: [`docs/guide.md`](docs/guide.md) (shared) and [`docs/plan.md`](docs/plan.md) (this repo).

## Status
Built: F1 core (SQLite queue, srt sandbox profiles, `claude`/`pi` drivers, worktree runner, session index, cron, HTTP API, CLI), F2 PR babysitter + Telegram, F3 approvals, F4 groomer (GitHub Issues) + implement worker, F5/F6 PWA (sessions, transcripts, steer, takeover, approvals, schedules) and a Tauri desktop shell.

Not done: the F0 spike (`docs/spike-report.md`) and every phase's acceptance test need the real dev host (arm64 + srt). PostHog triage and Linear/Jira trackers were dropped (guide D19).

## Develop
```sh
pnpm install
pnpm test        # vitest
pnpm typecheck   # server + UI
pnpm build       # UI → apps/ui/dist (served by the orchestrator at /)
```
Node 24 runs the `.ts` sources directly (type stripping), so there is no build step.

## Use
```sh
node apps/orchestrator/src/cli.ts serve                       # CATAPULT_ROOT=/srv/catapult by default
catapult project add web ~/code/web --repo me/web --harness claude --babysit
catapult run task --project web --prompt "add a hello.txt"   # sandboxed (trusted tier)
catapult jobs; catapult sessions
catapult takeover claude <session>                            # prints `claude --resume <id>`
catapult steer claude <session> "also update the docs"
catapult schedule add web groomer "0 8 * * 1-5"
catapult actions; catapult approve <action>                   # or tap Approve in Telegram / the UI
```
Tiers `trusted`/`untrusted` run under `srt` (install via rock's `sandbox` and `harnesses` modules); `unsandboxed` runs the harness directly. `unsandboxed` needs `--unsandboxed-ok` on the project. A job's worktree is kept when it holds changes or commits (failed jobs: for 7 days), and removed when clean.

## Configure
Environment (from Doppler on the dev host): `GITHUB_TOKEN` (PR babysitter, groomer, draft PRs), `GITHUB_WEBHOOK_SECRET` (optional; webhook listener on `CATAPULT_WEBHOOK_PORT`, default 7701, for Funnel), `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` + `TELEGRAM_ALLOWED_USER_IDS`, `CATAPULT_DAILY_COST_USD` (optional cap). Anything unset is simply off.

Per repo, an optional `.catapult.yml`:
```yaml
setup: pnpm install --frozen-lockfile
test: pnpm test
harness: claude
allow_domains: [docs.example.com]
unsandboxed_ok: false
```
Per project in the DB (`catapult project set <id> <key> <json>` or the UI): `pr_babysitter: {enabled, max_rounds, trusted_authors, ignored_authors}`, `ready_label`.

## Deploy
`deploy/install.sh` builds the UI, installs the systemd units (Doppler-injected env) and Litestream (`deploy/litestream.yml`). Expose the UI and API on the tailnet with `tailscale serve 7700`; only the webhook port goes through Funnel.

Desktop: `pnpm --filter @catapult/desktop build` (needs Rust), then set the server URL in Settings.

Before committing, enable the secret scan once per clone: `git config core.hooksPath .githooks` (needs [gitleaks](https://github.com/gitleaks/gitleaks)).

## License

MIT. See [LICENSE](LICENSE).
