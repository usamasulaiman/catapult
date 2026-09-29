// Minimal stand-in for `pi --mode rpc`, used by tests. FAKE_MODE: ok | ask | hang | crash
import { createInterface } from "node:readline";
const mode = process.env.FAKE_MODE ?? "ok";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    onCmd(JSON.parse(line));
  }
});
function onCmd(c) {
  if (c.type === "get_state") out({ type: "response", id: c.id, command: "get_state", success: true, data: { sessionId: "sess-1", sessionFile: "/tmp/sess-1.jsonl" } });
  if (c.type === "get_session_stats") out({ type: "response", id: c.id, command: "get_session_stats", success: true, data: { sessionId: "sess-1", sessionFile: "/tmp/sess-1.jsonl", cost: 0.12, tokens: { input: 100, output: 20 } } });
  if (c.type === "abort") { /* ignore */ }
  if (c.type === "extension_ui_response") out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "continued after cancel" }] } }), out({ type: "agent_settled" });
  if (c.type === "prompt" && !c.streamingBehavior) {
    out({ type: "response", command: "prompt", success: true });
    if (mode === "crash") { console.error("boom"); process.exit(3); }
    if (mode === "hang") return;
    out({ type: "agent_start" });
    out({ type: "tool_execution_start", toolName: "bash" });
    out({ type: "tool_execution_end", toolName: "bash", isError: false });
    if (mode === "ask") return out({ type: "extension_ui_request", id: "u1", method: "confirm", title: "Proceed?" });
    out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `echo: ${c.message} ok` }] } });
    out({ type: "agent_settled" });
  }
}
