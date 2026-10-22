import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve as honoServe } from "@hono/node-server";
import { openDb } from "@catapult/core";
import { claudeAdapter } from "@catapult/harness-claude";
import { piAdapter } from "@catapult/harness-pi";
import { createApi } from "./api.ts";
import type { Config } from "./config.ts";
import { Dispatcher } from "./dispatcher.ts";
import { pruneEvents } from "./sessions.ts";
import { builtinWorkers } from "./workers/index.ts";

export function serve(config: Config) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o750 });
  mkdirSync(config.worktreesDir, { recursive: true });
  const db = openDb(join(config.dataDir, "catapult.db"));

  const dispatcher = new Dispatcher({
    db, config, workers: builtinWorkers,
    adapters: { claude: claudeAdapter, pi: piAdapter },
  });
  const server = honoServe({ fetch: createApi(db, config, dispatcher).fetch, port: config.port, hostname: config.host });
  dispatcher.start();
  const prune = setInterval(() => pruneEvents(db, 30 * 86_400_000), 3_600_000);
  prune.unref();
  console.log(`catapult listening on http://${config.host}:${config.port} (owner ${config.owner})`);

  const shutdown = async () => {
    server.close();
    await dispatcher.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
