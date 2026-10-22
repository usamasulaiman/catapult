import { describe, expect, it } from "vitest";
import { parsePiTranscript } from "./transcript.ts";

const lines = [
  { type: "session", version: 3, id: "s1", cwd: "/w" },
  { type: "model_change", id: "m", modelId: "x" },
  { type: "message", id: "1", timestamp: "t", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
  { type: "message", id: "2", message: { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "reading" }, { type: "toolCall", name: "read", arguments: { path: "a.ts" } }] } },
  { type: "message", id: "3", message: { role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "contents" }] } },
].map((l) => JSON.stringify(l)).join("\n");

describe("parsePiTranscript", () => {
  it("maps messages, tool calls and tool results", () => {
    expect(parsePiTranscript(lines)).toEqual([
      { id: "1:0", role: "user", text: "hi", ts: "t" },
      { id: "2:1", role: "assistant", text: "reading", ts: undefined },
      { id: "2:2", role: "tool", text: "a.ts", tool: { name: "read" }, ts: undefined },
      { id: "3", role: "tool", text: "contents", tool: { name: "read", isError: false }, ts: undefined },
    ]);
  });
});
