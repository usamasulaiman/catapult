import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve as honoServe } from "@hono/node-server";
import { openDb } from "@catapult/core";
import { claudeAdapter } from "@catapult/harness-claude";
import { piAdapter } from "@catapult/harness-pi";
import { proposer, setActionMessage, sweepActions } from "./actions.ts";
import { createApi } from "./api.ts";
import type { Config } from "./config.ts";
import { Dispatcher } from "./dispatcher.ts";
import { GitHub } from "./github.ts";
import { reconcileSessions, sweepWorktrees } from "./maintenance.ts";
import { telegramHandlers } from "./notify/commands.ts";
import { nullNotifier, Telegram } from "./notify/telegram.ts";
import { pruneEvents } from "./sessions.ts";
import { pollPullRequests } from "./sources/github.ts";
import { Sources } from "./sources/index.ts";
import { githubTracker } from "./trackers/index.ts";
import { createWebhooks } from "./webhooks.ts";
import { groomer } from "./workers/groomer.ts";
import { implement } from "./workers/implement.ts";
import { builtinWorkers, type Services } from "./workers/index.ts";
import { prBabysitter } from "./workers/pr-babysitter.ts";

const MINUTE = 60_000;

export function serve(config: Config) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o750 });
  mkdirSync(config.worktreesDir, { recursive: true });
  const db = openDb(join(config.dataDir, "catapult.db"));

  const gh = config.githubToken ? new GitHub(config.githubToken) : undefined;
  const telegram = config.telegram ? new Telegram(config.telegram) : undefined;
  if (telegram) telegram.onActionPosted = (a, messageId) => setActionMessage(db, a.id, messageId);
  const notify = telegram ?? nullNotifier;
  const services: Services = {
    github: gh, notify,
    tracker: (project) => (gh && project.repo_full_name ? githubTracker(gh, project.repo_full_name) : undefined),
    propose: proposer(db, { notify }),
  };
  const workers = { ...builtinWorkers, "pr-babysitter": prBabysitter(gh), groomer: groomer(gh), implement: implement(gh) };

  const dispatcher = new Dispatcher({
    db, config, workers, services,
    adapters: { claude: claudeAdapter, pi: piAdapter },
  });

  const sources = new Sources();
  if (gh) sources.add("github-prs", 3 * MINUTE, () => pollPullRequests(db, gh, notify));
  sources.add("maintenance", 5 * MINUTE, async () => {
    await sweepActions(db, { notify });
    reconcileSessions(db, dispatcher.liveSessions());
    await sweepWorktrees(db, config.worktreesDir);
  });
  const sourceTimer = setInterval(() => sources.tick(), 5000);
  sourceTimer.unref();

  const server = honoServe({ fetch: createApi(db, config, dispatcher, services).fetch, port: config.port, hostname: config.host });
  const hooks = config.githubWebhookSecret
    ? honoServe({ fetch: createWebhooks({ githubSecret: config.githubWebhookSecret, nudge: (s) => sources.nudge(s) }).fetch, port: config.webhookPort, hostname: config.host })
    : undefined;
  dispatcher.start();
  if (telegram) void telegram.run(db, telegramHandlers(db, services, dispatcher, Object.keys(workers)));
  const prune = setInterval(() => pruneEvents(db, 30 * 86_400_000), 3_600_000);
  prune.unref();
  console.log(`catapult listening on http://${config.host}:${config.port} (owner ${config.owner})`
    + `${hooks ? `, webhooks on :${config.webhookPort}` : ""}; github ${gh ? "on" : "off"}, telegram ${telegram ? "on" : "off"}`);

  const shutdown = async () => {
    telegram?.stop();
    clearInterval(sourceTimer);
    server.close();
    hooks?.close();
    await dispatcher.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
