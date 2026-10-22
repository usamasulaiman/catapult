import { parseLine, type NormalizedMessage } from "@catapult/core";

type Obj = Record<string, any>;

/** Parse a pi session file (`{type: "message", message: {role, content}}` records) into display messages. */
export function parsePiTranscript(jsonl: string): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const line of jsonl.split("\n")) {
    const r = parseLine(line) as Obj | undefined;
    if (!r || r.type !== "message" || !r.message) continue;
    const m = r.message as Obj;
    const id = String(r.id ?? out.length);
    const ts = r.timestamp as string | undefined;
    const blocks: Obj[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
    if (m.role === "toolResult") {
      const text = blocks.map((b) => (b.type === "text" ? String(b.text ?? "") : "")).join("");
      out.push({ id, role: "tool", text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text, tool: { name: String(m.toolName ?? "tool"), isError: m.isError === true }, ts });
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") continue;
    blocks.forEach((b, i) => {
      const bid = `${id}:${i}`;
      if (b.type === "text" && b.text) out.push({ id: bid, role: m.role, text: String(b.text), ts });
      else if (b.type === "toolCall") {
        const a = (b.arguments ?? {}) as Obj;
        const s = a.command ?? a.path ?? a.pattern;
        out.push({ id: bid, role: "tool", text: typeof s === "string" ? s : JSON.stringify(a).slice(0, 500), tool: { name: String(b.name ?? "tool") }, ts });
      }
    });
  }
  return out;
}
