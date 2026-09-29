import type { RunEvent } from "@catapult/core";

type Obj = Record<string, any>;

/** Claude Code's on-disk project dir name: every non-alphanumeric char of the cwd becomes "-". */
export function claudeTranscriptPath(home: string, cwd: string, sessionId: string): string {
  return `${home}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}/${sessionId}.jsonl`;
}

/** Map one stream-json line to catapult RunEvents. Unknown types are ignored. */
export function mapClaudeEvent(ev: Obj): RunEvent[] {
  switch (ev.type) {
    case "system":
      return ev.subtype === "init" ? [{ kind: "started", sessionId: ev.session_id }] : [];
    case "assistant": {
      const out: RunEvent[] = [];
      for (const c of (ev.message?.content ?? []) as Obj[]) {
        if (c.type === "text" && c.text) out.push({ kind: "message", role: "assistant", text: String(c.text) });
        else if (c.type === "tool_use") out.push({ kind: "tool", name: String(c.name), phase: "start" });
      }
      return out;
    }
    case "user": {
      const out: RunEvent[] = [];
      const content = ev.message?.content;
      if (Array.isArray(content)) {
        for (const c of content as Obj[]) {
          if (c.type === "tool_result") out.push({ kind: "tool", name: String(c.tool_use_id ?? "?"), phase: "end", isError: c.is_error === true });
        }
      }
      return out;
    }
    case "result":
      return [{
        kind: "usage",
        costUsd: ev.total_cost_usd,
        tokensIn: ev.usage ? (ev.usage.input_tokens ?? 0) + (ev.usage.cache_read_input_tokens ?? 0) + (ev.usage.cache_creation_input_tokens ?? 0) : undefined,
        tokensOut: ev.usage?.output_tokens,
      }];
    default:
      return [];
  }
}

/** Reason for a terminal `result` event. */
export function resultReason(ev: Obj): "completed" | "error" | "max_turns" {
  if (ev.subtype === "error_max_turns") return "max_turns";
  return ev.is_error || (typeof ev.subtype === "string" && ev.subtype !== "success") ? "error" : "completed";
}
