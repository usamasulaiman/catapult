import type { RunEvent } from "@catapult/core";

type Obj = Record<string, unknown>;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && (c as Obj).type === "text" ? String((c as Obj).text ?? "") : ""))
    .join("");
}

/** Dialog methods block until the client answers; unattended runs surface them as needs_input. */
export const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** Map one pi RPC event to catapult RunEvents. Unknown events are ignored. */
export function mapPiEvent(ev: Obj): RunEvent[] {
  switch (ev.type) {
    case "message_end": {
      const m = ev.message as Obj | undefined;
      if (!m || (m.role !== "assistant" && m.role !== "user")) return [];
      const text = textOf(m.content);
      return text ? [{ kind: "message", role: m.role, text }] : [];
    }
    case "tool_execution_start":
      return [{ kind: "tool", name: String(ev.toolName ?? "?"), phase: "start" }];
    case "tool_execution_end":
      return [{ kind: "tool", name: String(ev.toolName ?? "?"), phase: "end", isError: ev.isError === true }];
    case "extension_ui_request":
      return DIALOG_METHODS.has(String(ev.method))
        ? [{ kind: "needs_input", reason: String(ev.title ?? ev.method) }]
        : [];
    default:
      return [];
  }
}
