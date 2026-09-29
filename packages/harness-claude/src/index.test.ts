import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { RunEvent } from "@catapult/core";
import { claudeAdapter, claudeArgv, claudeTranscriptPath, mapClaudeEvent } from "./index.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const fake = here("./fake-claude.mjs");
const run = (mode: string, extra: Partial<Parameters<typeof claudeAdapter.start>[0]> = {}) =>
  claudeAdapter.start({ cwd: process.cwd(), prompt: "hi", env: { FAKE_MODE: mode }, bin: ["node", fake], ...extra });
const collect = async (h: ReturnType<typeof run>) => { const l: RunEvent[] = []; for await (const e of h.events) l.push(e); return l; };

describe("claudeArgv", () => {
  it("maps budget and flags", () => {
    const a = claudeArgv({ cwd: "/", prompt: "", resume: "abc", budget: { max_turns: 5, max_cost_usd: 2 }, unattended: true });
    expect(a).toEqual(expect.arrayContaining(["--resume", "abc", "--max-turns", "5", "--max-budget-usd", "2", "--dangerously-skip-permissions"]));
    expect(claudeArgv({ cwd: "/", prompt: "" })).not.toContain("--dangerously-skip-permissions");
  });
});

describe("claudeTranscriptPath", () => {
  it("mangles the cwd like Claude Code does", () => {
    expect(claudeTranscriptPath("/home/dev", "/srv/catapult/worktrees/p.1/j_1", "s1"))
      .toBe("/home/dev/.claude/projects/-srv-catapult-worktrees-p-1-j-1/s1.jsonl");
  });
});

describe("real fixture", () => {
  it("maps a captured session to start, message and usage", async () => {
    const h = run(`replay:${here("../fixtures/basic.jsonl")}`);
    const evs = await collect(h);
    const r = await h.done;
    expect(r).toMatchObject({ reason: "completed", finalText: "pong", sessionId: "32087ec1-9ea0-4eaf-a759-9f85a7bd6ac3" });
    expect(r.costUsd).toBeGreaterThan(0);
    expect(evs[0]).toMatchObject({ kind: "started" });
  });
  it("every line of the fixture maps without throwing", () => {
    for (const l of readFileSync(here("../fixtures/basic.jsonl"), "utf8").split("\n").filter(Boolean)) mapClaudeEvent(JSON.parse(l));
  });
});

describe("claude driver", () => {
  it("completes, collecting tools, final text, usage", async () => {
    const h = run("ok");
    const evs = await collect(h);
    const r = await h.done;
    expect(r).toMatchObject({ reason: "completed", finalText: "done: hi", costUsd: 0.05, tokensIn: 100, tokensOut: 7 });
    expect(evs.filter((e) => e.kind === "tool")).toHaveLength(2);
  });
  it("maps error_max_turns", async () => {
    const h = run("fail");
    await collect(h);
    expect((await h.done).reason).toBe("max_turns");
  });
  it("reports a crash with stderr", async () => {
    const h = run("crash");
    await collect(h);
    const r = await h.done;
    expect(r.reason).toBe("error");
    expect(r.error).toContain("boom");
  });
  it("enforces wall time and supports cancel", async () => {
    const t = run("hang", { budget: { max_wall_seconds: 0.3 } });
    await collect(t);
    expect((await t.done).reason).toBe("timeout");
    const c = run("hang");
    setTimeout(() => void c.cancel(), 200);
    await collect(c);
    expect((await c.done).reason).toBe("cancelled");
  });
});
