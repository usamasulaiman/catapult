import { parseLine, type NormalizedMessage } from "@catapult/core";

type Obj = Record<string, any>;

/**
 * Parse a Claude Code session file into display messages. Defensive: only user/assistant records
 * with known content blocks are kept; bookkeeping records (snapshots, titles, api blobs) are skipped.
 */
export function parseClaudeTranscript(jsonl: string): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  const toolNames = new Map<string, string>();
  for (const line of jsonl.split("\n")) {
    const r = parseLine(line) as Obj | undefined;
    if (!r || (r.type !== "user" && r.type !== "assistant") || r.isSidechain || r.isMeta) continue;
    const id = String(r.uuid ?? out.length);
    const ts = r.timestamp as string | undefined;
    const content = r.message?.content;
    if (typeof content === "string") {
      if (content) out.push({ id, role: r.type, text: content, ts });
      continue;
    }
    if (!Array.isArray(content)) continue;
    content.forEach((c: Obj, i: number) => {
      const cid = `${id}:${i}`;
      if (c.type === "text" && c.text) out.push({ id: cid, role: r.type, text: String(c.text), ts });
      else if (c.type === "tool_use") {
        toolNames.set(String(c.id), String(c.name));
        out.push({ id: cid, role: "tool", text: summarizeInput(c.input), tool: { name: String(c.name) }, ts });
      } else if (c.type === "tool_result") {
        const name = toolNames.get(String(c.tool_use_id)) ?? "tool";
        out.push({ id: cid, role: "tool", text: resultText(c.content), tool: { name, isError: c.is_error === true }, ts });
      }
    });
  }
  return out;
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Obj;
  const s = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.description;
  return typeof s === "string" ? s : JSON.stringify(input).slice(0, 500);
}

function resultText(content: unknown): string {
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.map((c: Obj) => (c?.type === "text" ? String(c.text ?? "") : "")).join("") : "";
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}
