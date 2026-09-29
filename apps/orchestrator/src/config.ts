import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  dataDir: string;
  worktreesDir: string;
  home: string;
  port: number;
  host: string;
  owner: string;
  globalCap: number;
  perProjectCap: number;
  leaseMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const root = env.CATAPULT_ROOT ?? "/srv/catapult";
  return {
    dataDir: env.CATAPULT_DATA ?? join(root, "data"),
    worktreesDir: env.CATAPULT_WORKTREES ?? join(root, "worktrees"),
    home: env.HOME ?? homedir(),
    port: Number(env.CATAPULT_PORT ?? 7700),
    host: env.CATAPULT_HOST ?? "127.0.0.1",
    owner: `${env.HOSTNAME ?? "catapult"}:${process.pid}`,
    globalCap: Number(env.CATAPULT_GLOBAL_CAP ?? 3),
    perProjectCap: Number(env.CATAPULT_PROJECT_CAP ?? 1),
    leaseMs: Number(env.CATAPULT_LEASE_MS ?? 60_000),
  };
}
