import { spawn } from "node:child_process";
import {
  AsyncQueue, LineSplitter, parseLine,
  type ExitReason, type HarnessAdapter, type RunEvent, type RunHandle, type RunResult, type StartOpts,
} from "@catapult/core";
import { DIALOG_METHODS, mapPiEvent } from "./events.ts";

export { mapPiEvent } from "./events.ts";
export { parsePiTranscript } from "./transcript.ts";

const KILL_GRACE_MS = 3000;

/** pi's argv for RPC mode. */
export function piArgv(o: Pick<StartOpts, "resume" | "model">): string[] {
  return ["pi", "--mode", "rpc", ...(o.resume ? ["--session", o.resume] : []), ...(o.model ? ["--model", o.model] : [])];
}

export const piAdapter: HarnessAdapter = { name: "pi", start };

function start(o: StartOpts): RunHandle {
  const argv = (o.wrap ?? ((a) => a))(o.bin ?? piArgv(o));
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
  let nextId = 1;
  const pending = new Map<string, (r: Record<string, unknown>) => void>();

  const write = (cmd: Record<string, unknown>) => {
    if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(cmd) + "\n");
  };
  const request = (cmd: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const id = `c${nextId++}`;
      pending.set(id, resolve);
      write({ ...cmd, id });
      setTimeout(() => { if (pending.delete(id)) resolve({ success: false }); }, 5000).unref();
    });

  const emit = (e: RunEvent) => {
    if (e.kind === "message" && e.role === "assistant") result.finalText = e.text;
    events.push(e);
  };

  const finish = (reason: ExitReason, error?: string) => {
    if (settled) return;
    settled = true;
    result.reason = reason;
    if (error) result.error = error;
    void (async () => {
      if (reason === "completed") {
        const stats = await request({ type: "get_session_stats" });
        const d = stats.data as Record<string, any> | undefined;
        if (d) {
          result.costUsd = d.cost;
          result.tokensIn = d.tokens?.input;
          result.tokensOut = d.tokens?.output;
          result.sessionId ??= d.sessionId;
          result.transcriptPath ??= d.sessionFile;
          emit({ kind: "usage", costUsd: d.cost, tokensIn: d.tokens?.input, tokensOut: d.tokens?.output });
        }
      }
      emit({ kind: "finished", reason });
      child.stdin.end();
      const t = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      t.unref();
      child.once("exit", () => clearTimeout(t));
      child.kill("SIGTERM");
    })();
  };

  const handle = (line: string) => {
    const ev = parseLine(line);
    if (!ev) return;
    if (ev.type === "response") {
      const cb = pending.get(String(ev.id));
      if (cb) { pending.delete(String(ev.id)); cb(ev); }
      return;
    }
    if (ev.type === "extension_ui_request" && DIALOG_METHODS.has(String(ev.method))) {
      // Nobody is there to answer. Cancel so the agent continues, and record that input was wanted.
      write({ type: "extension_ui_response", id: ev.id, cancelled: true });
    }
    for (const e of mapPiEvent(ev)) emit(e);
    if (ev.type === "agent_settled") finish("completed");
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => splitter.push(chunk).forEach(handle));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => { stderr = (stderr + c).slice(-4000); });

  const done = new Promise<RunResult>((resolve) => {
    child.on("error", (err) => { finish("error", err.message); });
    child.on("close", (code) => {
      splitter.flush().forEach(handle);
      if (!settled) {
        settled = true;
        result.reason = "error";
        result.error = `pi exited with code ${code}: ${stderr.trim()}`;
        emit({ kind: "finished", reason: "error" });
      }
      events.close();
      resolve(result);
    });
  });

  // Learn the session id/file up front so callers can index it while the run is live.
  void request({ type: "get_state" }).then((r) => {
    const d = r.data as Record<string, unknown> | undefined;
    if (!d) return;
    result.sessionId = d.sessionId as string | undefined;
    result.transcriptPath = d.sessionFile as string | undefined;
    emit({ kind: "started", sessionId: result.sessionId, transcriptPath: result.transcriptPath });
  });

  write({ type: "prompt", message: o.prompt });

  const wall = o.budget?.max_wall_seconds;
  if (wall) {
    const t = setTimeout(() => { write({ type: "abort" }); finish("timeout", `exceeded ${wall}s`); }, wall * 1000);
    t.unref();
    void done.then(() => clearTimeout(t));
  }

  return {
    events,
    done,
    send: async (message) => write({ type: "prompt", message, streamingBehavior: "steer" }),
    cancel: async () => { write({ type: "abort" }); finish("cancelled"); await done; },
  };
}
