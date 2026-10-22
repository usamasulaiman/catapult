import type { Budget } from "./types.ts";

export type HarnessName = "claude" | "pi";

export type RunEvent =
  | { kind: "started"; sessionId?: string; transcriptPath?: string }
  | { kind: "message"; role: "user" | "assistant"; text: string }
  | { kind: "tool"; name: string; phase: "start" | "end"; isError?: boolean }
  | { kind: "needs_input"; reason: string }
  | { kind: "usage"; costUsd?: number; tokensIn?: number; tokensOut?: number }
  | { kind: "finished"; reason: ExitReason };

export type ExitReason = "completed" | "error" | "cancelled" | "timeout" | "max_turns" | "needs_input";

export interface RunResult {
  reason: ExitReason;
  sessionId?: string;
  transcriptPath?: string;
  finalText: string;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  error?: string;
}

export interface RunHandle {
  events: AsyncIterable<RunEvent>;
  /** Steer a running session with an extra user message. */
  send(message: string): Promise<void>;
  cancel(): Promise<void>;
  done: Promise<RunResult>;
}

export interface StartOpts {
  cwd: string;
  prompt: string;
  env?: Record<string, string>;
  budget?: Budget;
  /** Resume an existing session (id for claude, session file/id for pi). */
  resume?: string;
  model?: string;
  /** No human present: skip permission prompts. Only safe when the process runs under srt. */
  unattended?: boolean;
  systemAppend?: string;
  /** Wraps the harness argv (e.g. with srt). Identity when omitted. */
  wrap?: (argv: string[]) => string[];
  /** Override the harness binary, e.g. for tests. */
  bin?: string[];
}

export interface HarnessAdapter {
  name: HarnessName;
  start(opts: StartOpts): RunHandle;
}

/** One transcript entry as the UI shows it. Parsed from harness JSONL on demand, never stored. */
export interface NormalizedMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  tool?: { name: string; isError?: boolean };
  ts?: string;
}
