import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Db, HarnessName, Project } from "@catapult/core";

/**
 * Effective per-project settings: facts from the repo's `.catapult.yml` (setup, test, harness, tracker…)
 * overlaid with what the DB holds (edited through the API/UI). The DB wins on conflict.
 */
export interface ProjectSettings {
  setup?: string;
  test?: string;
  lint?: string;
  harness: HarnessName;
  tracker?: "linear" | "github" | "jira";
  tracker_options?: Record<string, string>;
  allow_domains: string[];
  unsandboxed_ok: boolean;
  pr_babysitter?: { enabled?: boolean; max_rounds?: number; trusted_authors?: string[]; ignored_authors?: string[] };
  posthog?: { project_id: string; host?: string };
  ready_label?: string;
}

export function readRepoConfig(dir: string): Record<string, unknown> {
  try {
    const v = parse(readFileSync(join(dir, ".catapult.yml"), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function settingsFor(project: Project, repoDir = project.local_path): ProjectSettings {
  const merged = { ...readRepoConfig(repoDir), ...project.config } as Record<string, any>;
  return {
    ...merged,
    harness: merged.harness === "pi" ? "pi" : "claude",
    allow_domains: Array.isArray(merged.allow_domains) ? merged.allow_domains.map(String) : [],
    unsandboxed_ok: merged.unsandboxed_ok === true,
  };
}

export function loadProject(db: Db, id: string): Project {
  const r = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as any;
  if (!r) throw new Error(`unknown project ${id}`);
  return { ...r, config: JSON.parse(r.config_json) };
}

export function listProjects(db: Db): Project[] {
  return (db.prepare("SELECT * FROM projects ORDER BY id").all() as any[]).map((r) => ({ ...r, config: JSON.parse(r.config_json) }));
}
