import type { Project, Tier } from "@catapult/core";

/** A worker turns a job's input into a prompt and decides how to judge the result. */
export interface Worker {
  name: string;
  prompt(input: any, project: Project): string;
  /** Tier is decided by who wrote the input; workers may tighten it. */
  tier?(input: any): Tier;
}

export const noop: Worker = {
  name: "noop",
  prompt: (input) => String(input?.prompt ?? "Create a file named NOOP.md containing the word ok."),
};

export const builtinWorkers: Record<string, Worker> = { noop };
