import type { Action, Db, HarnessName, Job, Project, RunResult, Tier } from "@catapult/core";
import type { GitHub } from "../github.ts";
import type { Notifier } from "../notify/telegram.ts";
import type { ProjectSettings } from "../project-config.ts";
import type { Tracker } from "../trackers/index.ts";
import type { Worktree } from "../worktree.ts";

/** What workers may touch outside the sandbox. Only the orchestrator holds these credentials. */
export interface Services {
  github?: GitHub;
  notify: Notifier;
  tracker(project: Project, settings: ProjectSettings): Tracker | undefined;
  /** Record an action and post it for approval. */
  propose(o: { kind: string; payload: unknown; summary: string; project_id: string; job_id?: string; run_id?: string }): Promise<Action>;
}

export interface WorkerContext {
  db: Db;
  job: Job;
  project: Project;
  settings: ProjectSettings;
  services: Services;
}

/** Where the agent works: a new branch off `base` (default), or an existing directory (resume). */
export type Checkout = { branch: string; base: string } | { reuse: string };

export interface EvalContext<I = any> extends WorkerContext {
  input: I;
  runId: string;
  worktree: Worktree;
  result: RunResult;
  /** Run a shell command in the worktree under the job's sandbox. */
  exec(command: string): Promise<{ ok: boolean; output: string }>;
}

export type Outcome =
  | { status: "succeeded"; summary?: string; /** false: remove the worktree even though it has commits (pushed). */ keepWorktree?: boolean }
  | { status: "needs_input"; reason: string }
  | { status: "failed"; error: string };

/**
 * A worker turns a job's input into a prompt and decides how to judge the result.
 * The runner is generic; workers hold no process logic (plan: Workers).
 */
export interface Worker<I = any> {
  name: string;
  /** Deterministic work before the agent (fetch PR state, list tickets). null = nothing to do; the job succeeds without a run. */
  prepare?(input: I, ctx: WorkerContext): Promise<I | null>;
  checkout?(input: I, ctx: WorkerContext): Promise<Checkout>;
  prompt(input: I, project: Project, settings?: ProjectSettings): string;
  /** Tier is decided by who wrote the input; workers may only tighten it. */
  tier?(input: I): Tier;
  harness?(input: I): HarnessName | undefined;
  /** Session to resume instead of starting a new one. */
  resume?(input: I): string | undefined;
  /** Check evidence and perform approved-by-design side effects (push to a branch, reply on a PR). */
  evaluate?(e: EvalContext<I>): Promise<Outcome>;
}

export const noop: Worker = {
  name: "noop",
  prompt: (input) => String(input?.prompt ?? "Create a file named NOOP.md containing the word ok."),
};

/** A free-form agent session started from the CLI or UI. */
export const task: Worker<{ prompt: string; harness?: HarnessName }> = {
  name: "task",
  prompt: (input) => {
    if (!input?.prompt) throw new Error("task needs input.prompt");
    return input.prompt;
  },
  harness: (input) => input?.harness,
};

/** Continue an existing job session in its own worktree (steer from the UI/CLI after the run ended). */
export const resume: Worker<{ harness: HarnessName; session_id: string; resume_ref: string; cwd: string; prompt: string }> = {
  name: "resume",
  checkout: async (input) => ({ reuse: input.cwd }),
  prompt: (input) => input.prompt,
  harness: (input) => input.harness,
  resume: (input) => input.resume_ref,
};

export const builtinWorkers: Record<string, Worker> = { noop, task, resume };
