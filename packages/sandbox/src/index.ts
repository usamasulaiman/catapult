import type { Tier } from "@catapult/core";

/** The subset of srt's settings file that catapult produces. */
export interface SrtSettings {
  filesystem: { denyRead: string[]; allowRead?: string[]; allowWrite: string[]; denyWrite: string[] };
  network: { allowedDomains: string[]; deniedDomains: string[] };
}

export interface ProfileOpts {
  tier: Tier;
  /** Absolute path of the job's worktree: the only project path that is writable. */
  worktree: string;
  home: string;
  /** Catapult's data dir (DB, tokens). Always unreadable. */
  dataDir?: string;
  /** Domains from the project's .catapult.yml (trusted tier only). */
  projectDomains?: string[];
  /** LLM API hosts for the harness in use. */
  llmDomains?: string[];
  /** Extra writable paths, e.g. the harness's session dir. */
  extraWrite?: string[];
}

export const DEFAULT_LLM_DOMAINS = ["api.anthropic.com", "*.anthropic.com"];
export const GITHUB_DOMAINS = ["github.com", "api.github.com", "*.githubusercontent.com"];
export const REGISTRY_DOMAINS = ["registry.npmjs.org", "*.npmjs.org", "registry.yarnpkg.com"];

/** Secret locations denied in every sandboxed tier (guide §6). */
export function secretPaths(home: string, dataDir = "/srv/catapult/data"): string[] {
  return [
    `${home}/.ssh`, `${home}/.config/gh`, `${home}/.doppler`, `${home}/.aws`, `${home}/.config/doppler`,
    dataDir, "/var/run/docker.sock", "/run/docker.sock",
  ];
}

/** Whether a tier runs under srt at all. */
export function isSandboxed(tier: Tier): boolean {
  return tier === "trusted" || tier === "untrusted";
}

export function buildSettings(o: ProfileOpts): SrtSettings {
  if (!isSandboxed(o.tier)) throw new Error(`tier '${o.tier}' does not run under srt`);
  const llm = o.llmDomains ?? DEFAULT_LLM_DOMAINS;
  const trusted = o.tier === "trusted";
  const allowedDomains = trusted
    ? [...llm, ...GITHUB_DOMAINS, ...REGISTRY_DOMAINS, ...(o.projectDomains ?? [])]
    : [...llm, "api.github.com", ...REGISTRY_DOMAINS];
  const allowWrite = [
    o.worktree, "/tmp", `${o.home}/.claude`, `${o.home}/.pi`,
    ...(trusted ? [`${o.home}/.cache`, `${o.home}/.npm`, `${o.home}/.local/share/pnpm`] : []),
    ...(o.extraWrite ?? []),
  ];
  return {
    filesystem: {
      denyRead: secretPaths(o.home, o.dataDir),
      allowWrite: [...new Set(allowWrite)],
      denyWrite: [`${o.worktree}/.git/hooks`, `${o.worktree}/.git/config`],
    },
    network: { allowedDomains: [...new Set(allowedDomains)], deniedDomains: [] },
  };
}

/** Wrap argv so it runs under srt with a settings file. Unsandboxed tiers pass through. */
export function wrapCommand(tier: Tier, settingsPath: string, argv: string[]): string[] {
  return isSandboxed(tier) ? ["srt", "--settings", settingsPath, "--", ...argv] : argv;
}
