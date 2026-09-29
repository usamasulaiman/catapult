// Stand-in for `claude -p --input-format stream-json`. FAKE_MODE: ok | fail | hang | crash | replay:<file>
import { readFileSync } from "node:fs";
const mode = process.env.FAKE_MODE ?? "ok";
let buf = ""; let started = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { buf += c; if (!started && buf.includes("\n")) { started = true; go(JSON.parse(buf.split("\n")[0])); } });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
function go(msg) {
  if (mode === "crash") { console.error("boom"); process.exit(4); }
  if (mode === "hang") { out({ type: "system", subtype: "init", session_id: "c-1" }); return; }
  if (mode.startsWith("replay:")) { for (const l of readFileSync(mode.slice(7), "utf8").split("\n").filter(Boolean)) process.stdout.write(l + "\n"); return; }
  out({ type: "system", subtype: "init", session_id: "c-1" });
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } });
  out({ type: "assistant", message: { content: [{ type: "text", text: `got: ${msg.message.content}` }] } });
  if (mode === "fail") return out({ type: "result", subtype: "error_max_turns", is_error: false, session_id: "c-1", total_cost_usd: 0.5 });
  out({ type: "result", subtype: "success", is_error: false, result: `done: ${msg.message.content}`, session_id: "c-1", total_cost_usd: 0.05, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 7 } });
}
