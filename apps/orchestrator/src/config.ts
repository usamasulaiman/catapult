import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  /** Listener for signed webhooks (exposed through Funnel). Separate from the API so the two can't be confused. */
  webhookPort: number;
  /** Stop leasing new jobs once today's runs cost this much (USD). 0 = no cap. */
  dailyCostUsd: number;
  /** Built PWA served at / (apps/ui/dist). */
  uiDir: string;
  githubToken?: string;
  githubWebhookSecret?: string;
  telegram?: { token: string; chatId: string; allowedUserIds: string[] };
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
    webhookPort: Number(env.CATAPULT_WEBHOOK_PORT ?? 7701),
    dailyCostUsd: Number(env.CATAPULT_DAILY_COST_USD ?? 0),
    uiDir: env.CATAPULT_UI_DIR ?? fileURLToPath(new URL("../../ui/dist", import.meta.url)),
    githubToken: env.GITHUB_TOKEN || undefined,
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET || undefined,
    telegram: env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? {
      token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID,
      allowedUserIds: (env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    } : undefined,
  };
}
