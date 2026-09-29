import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { RunEvent } from "@catapult/core";
import { mapPiEvent, piAdapter, piArgv } from "./index.ts";

const fake = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));
const run = (mode: string, extra: Partial<Parameters<typeof piAdapter.start>[0]> = {}) =>
  piAdapter.start({ cwd: process.cwd(), prompt: "hello", env: { FAKE_MODE: mode }, bin: ["node", fake], ...extra });
const collect = async (h: ReturnType<typeof run>) => { const l: RunEvent[] = []; for await (const e of h.events) l.push(e); return l; };

describe("piArgv", () => {
  it("adds session and model", () => {
    expect(piArgv({})).toEqual(["pi", "--mode", "rpc"]);
    expect(piArgv({ resume: "/s.jsonl", model: "m" })).toEqual(["pi", "--mode", "rpc", "--session", "/s.jsonl", "--model", "m"]);
  });
});

describe("mapPiEvent", () => {
  it("extracts assistant text and ignores empty or unknown events", () => {
    expect(mapPiEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } })).toEqual([{ kind: "message", role: "assistant", text: "hi" }]);
    expect(mapPiEvent({ type: "message_end", message: { role: "toolResult", content: [] } })).toEqual([]);
    expect(mapPiEvent({ type: "whatever" })).toEqual([]);
  });
  it("flags dialog UI requests as needs_input but not notifications", () => {
    expect(mapPiEvent({ type: "extension_ui_request", method: "confirm", title: "ok?" })).toEqual([{ kind: "needs_input", reason: "ok?" }]);
    expect(mapPiEvent({ type: "extension_ui_request", method: "notify" })).toEqual([]);
  });
});

describe("pi driver", () => {
  it("runs a prompt to completion with session, usage and unicode-safe framing", async () => {
    const h = run("ok");
    const evs = await collect(h);
    const r = await h.done;
    expect(r.reason).toBe("completed");
    expect(r.finalText).toBe("echo: hello ok");
    expect(r).toMatchObject({ sessionId: "sess-1", transcriptPath: "/tmp/sess-1.jsonl", costUsd: 0.12, tokensIn: 100, tokensOut: 20 });
    expect(evs.map((e) => e.kind)).toEqual(expect.arrayContaining(["started", "tool", "message", "usage", "finished"]));
  });
  it("cancels dialogs and reports needs_input", async () => {
    const h = run("ask");
    const evs = await collect(h);
    expect(evs.some((e) => e.kind === "needs_input")).toBe(true);
    expect((await h.done).finalText).toBe("continued after cancel");
  });
  it("reports a crash as an error with stderr", async () => {
    const h = run("crash");
    await collect(h);
    const r = await h.done;
    expect(r.reason).toBe("error");
    expect(r.error).toContain("boom");
  });
  it("enforces the wall-clock budget", async () => {
    const h = run("hang", { budget: { max_wall_seconds: 0.3 } });
    await collect(h);
    expect((await h.done).reason).toBe("timeout");
  });
  it("cancel stops a hung run", async () => {
    const h = run("hang");
    setTimeout(() => void h.cancel(), 200);
    await collect(h);
    expect((await h.done).reason).toBe("cancelled");
  });
});
