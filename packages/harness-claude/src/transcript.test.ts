import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./transcript.ts";

const lines = [
  { type: "permission-mode", permissionMode: "default", sessionId: "s" },
  { type: "user", uuid: "u1", timestamp: "t1", message: { role: "user", content: "add a test" } },
  { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "On it." }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "pnpm test" } }] } },
  { type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "1 failed" }], is_error: true }] } },
  { type: "assistant", uuid: "a2", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent" }] } },
  { type: "file-history-snapshot", messageId: "x" },
].map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n";

describe("parseClaudeTranscript", () => {
  it("keeps user text, assistant text and tool calls/results; skips bookkeeping and sidechains", () => {
    expect(parseClaudeTranscript(lines)).toEqual([
      { id: "u1", role: "user", text: "add a test", ts: "t1" },
      { id: "a1:1", role: "assistant", text: "On it.", ts: undefined },
      { id: "a1:2", role: "tool", text: "pnpm test", tool: { name: "Bash" }, ts: undefined },
      { id: "u2:0", role: "tool", text: "1 failed", tool: { name: "Bash", isError: true }, ts: undefined },
    ]);
  });
});
