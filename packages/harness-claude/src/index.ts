import { spawn } from "node:child_process";
import {
  AsyncQueue, LineSplitter, parseLine,
  type ExitReason, type HarnessAdapter, type RunEvent, type RunHandle, type RunResult, type StartOpts,
} from "@catapult/core";
import { mapClaudeEvent, resultReason } from "./events.ts";

export { claudeTranscriptPath, mapClaudeEvent, resultReason } from "./events.ts";

const KILL_GRACE_MS = 3000;

export function claudeArgv(o: StartOpts): string[] {
  const a = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  if (o.resume) a.push("--resume", o.resume);
  if (o.model) a.push("--model", o.model);
  if (o.budget?.max_turns) a.push("--max-turns", String(o.budget.max_turns));
  if (o.budget?.max_cost_usd) a.push("--max-budget-usd", String(o.budget.max_cost_usd));
  if (o.systemAppend) a.push("--append-system-prompt", o.systemAppend);
  if (o.unattended) a.push("--dangerously-skip-permissions");
  return a;
}

export const claudeAdapter: HarnessAdapter = { name: "claude", start };

const userLine = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";

function start(o: StartOpts): RunHandle {
  const argv = (o.wrap ?? ((a) => a))(o.bin ?? claudeArgv(o));
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: o.cwd,
    env: { ...process.env, ...o.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const events = new AsyncQueue<RunEvent>();
  const result: RunResult = { reason: "completed", finalText: "" };
  const splitter = new LineSplitter();
  let stderr = "";
  let settled = false;

  const finish = (reason: ExitReason, error?: string) => {
    if (settled) return;
    settled = true;
    result.reason = reason;
    if (error) result.error = error;
    events.push({ kind: "finished", reason });
    child.stdin.end();
    const t = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    t.unref();
    child.once("exit", () => clearTimeout(t));
    child.kill("SIGTERM");
  };

  const handle = (line: string) => {
    const ev = parseLine(line);
    if (!ev) return;
    if (ev.type === "system" && ev.subtype === "init") result.sessionId = ev.session_id as string;
    for (const e of mapClaudeEvent(ev)) {
      if (e.kind === "message" && e.role === "assistant") result.finalText = e.text;
      if (e.kind === "usage") { result.costUsd = e.costUsd; result.tokensIn = e.tokensIn; result.tokensOut = e.tokensOut; }
      events.push(e);
    }
    if (ev.type === "result") {
      if (typeof ev.result === "string" && ev.result) result.finalText = ev.result;
      const reason = resultReason(ev);
      finish(reason, reason === "completed" ? undefined : String(ev.subtype ?? "error"));
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c: string) => splitter.push(c).forEach(handle));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => { stderr = (stderr + c).slice(-4000); });

  const done = new Promise<RunResult>((resolve) => {
    child.on("error", (err) => finish("error", err.message));
    child.on("close", (code) => {
      splitter.flush().forEach(handle);
      if (!settled) {
        settled = true;
        result.reason = "error";
        result.error = `claude exited with code ${code}: ${stderr.trim()}`;
        events.push({ kind: "finished", reason: "error" });
      }
      events.close();
      resolve(result);
    });
  });

  child.stdin.write(userLine(o.prompt));

  const wall = o.budget?.max_wall_seconds;
  if (wall) {
    const t = setTimeout(() => finish("timeout", `exceeded ${wall}s`), wall * 1000);
    t.unref();
    void done.then(() => clearTimeout(t));
  }

  return {
    events,
    done,
    send: async (message) => { if (!child.stdin.destroyed) child.stdin.write(userLine(message)); },
    cancel: async () => { finish("cancelled"); await done; },
  };
}
