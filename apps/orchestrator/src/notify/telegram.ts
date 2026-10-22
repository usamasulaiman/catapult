import type { Action, Db } from "@catapult/core";

/** Where workers and the approval flow report to. Telegram today; a no-op when unconfigured. */
export interface Notifier {
  send(text: string): Promise<void>;
  /** Post an action with Approve / Reject / Details buttons. */
  sendAction(a: Action): Promise<void>;
  /** Replace an action message's buttons with its outcome (decided, expired). */
  actionChanged(a: Action, note: string): Promise<void>;
}

export const nullNotifier: Notifier = {
  send: async () => {},
  sendAction: async () => {},
  actionChanged: async () => {},
};

export interface TelegramUser { id: string; name: string }

export interface TelegramHandlers {
  /** `/status`, `/jobs`, `/cancel <job>`, `/run <worker> <project>`. Returns the reply (HTML). */
  command(name: string, args: string[], from: TelegramUser): Promise<string>;
  /** First decision wins; returns the toast text for the tapper. */
  decide(actionId: string, nonce: string, decision: "approved" | "rejected", from: TelegramUser, messageId: string): Promise<string>;
  details(actionId: string): string;
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const MAX_TEXT = 4000;
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

/** callback_data is limited to 64 bytes: `<y|n|d>:<action uuid>:<8-hex nonce>` is 47. */
export function callbackData(choice: "y" | "n" | "d", a: Pick<Action, "id" | "nonce">): string {
  return `${choice}:${a.id}:${a.nonce}`;
}
export function parseCallback(data: string): { choice: "y" | "n" | "d"; id: string; nonce: string } | undefined {
  const m = /^([ynd]):([0-9a-f-]{36}):([0-9a-f]{8})$/.exec(data);
  return m ? { choice: m[1] as "y" | "n" | "d", id: m[2]!, nonce: m[3]! } : undefined;
}

export function actionText(a: Action): string {
  return `<b>Approval needed</b> · ${esc(a.kind)}${a.project_id ? ` · ${esc(a.project_id)}` : ""}\n\n${esc(a.summary ?? "")}`;
}

/**
 * Telegram bot over long polling (getUpdates), so the dev host needs no inbound port (guide D7).
 * Updates from users outside the allowlist are ignored.
 */
export class Telegram implements Notifier {
  private stopped = false;
  private abort?: AbortController;
  private o: { token: string; chatId: string; allowedUserIds: string[]; api?: string; fetch?: typeof fetch };

  constructor(o: Telegram["o"]) { this.o = o; }

  private async call<T = any>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await (this.o.fetch ?? fetch)(`${this.o.api ?? "https://api.telegram.org"}/bot${this.o.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
    });
    const data = await res.json() as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
    return data.result;
  }

  async send(text: string): Promise<void> {
    await this.call("sendMessage", { chat_id: this.o.chatId, text: clip(text), parse_mode: "HTML", link_preview_options: { is_disabled: true } })
      .catch((e) => console.error(e.message));
  }

  /** Sends the action and returns its message id (stored so the message can be edited later). */
  async postAction(a: Action): Promise<string | undefined> {
    const r = await this.call<{ message_id: number }>("sendMessage", {
      chat_id: this.o.chatId, text: clip(actionText(a)), parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[
        { text: "Approve", callback_data: callbackData("y", a) },
        { text: "Reject", callback_data: callbackData("n", a) },
        { text: "Details", callback_data: callbackData("d", a) },
      ]] },
    }).catch((e) => { console.error(e.message); return undefined; });
    return r ? String(r.message_id) : undefined;
  }

  onActionPosted?: (a: Action, messageId: string) => void;

  async sendAction(a: Action): Promise<void> {
    const id = await this.postAction(a);
    if (id) this.onActionPosted?.(a, id);
  }

  async actionChanged(a: Action, note: string): Promise<void> {
    if (!a.channel_message_id) return;
    await this.call("editMessageText", {
      chat_id: this.o.chatId, message_id: Number(a.channel_message_id), parse_mode: "HTML",
      text: clip(`${actionText(a)}\n\n<i>${esc(note)}</i>`),
    }).catch((e) => console.error(e.message));
  }

  allowed(userId: number | string): boolean {
    return this.o.allowedUserIds.includes(String(userId));
  }

  /** Handle one update. Exposed for tests. */
  async handleUpdate(u: any, h: TelegramHandlers): Promise<void> {
    if (u.callback_query) {
      const q = u.callback_query;
      if (!this.allowed(q.from?.id)) return;
      const from = { id: String(q.from.id), name: [q.from.first_name, q.from.last_name].filter(Boolean).join(" ") || q.from.username || "" };
      const cb = parseCallback(String(q.data ?? ""));
      let toast = "unknown button";
      if (cb?.choice === "d") {
        await this.call("sendMessage", { chat_id: this.o.chatId, text: clip(h.details(cb.id)), parse_mode: "HTML", reply_to_message_id: q.message?.message_id })
          .catch((e) => console.error(e.message));
        toast = "";
      } else if (cb) {
        toast = await h.decide(cb.id, cb.nonce, cb.choice === "y" ? "approved" : "rejected", from, String(q.message?.message_id ?? ""));
      }
      await this.call("answerCallbackQuery", { callback_query_id: q.id, text: toast }).catch(() => {});
      return;
    }
    const m = u.message;
    if (!m?.text || !this.allowed(m.from?.id)) return;
    const [cmd, ...args] = String(m.text).trim().split(/\s+/);
    if (!cmd?.startsWith("/")) return;
    const name = cmd.slice(1).split("@")[0]!;
    const from = { id: String(m.from.id), name: m.from.first_name ?? "" };
    const reply = await h.command(name, args, from).catch((e: Error) => `error: ${esc(e.message)}`);
    await this.call("sendMessage", { chat_id: m.chat.id, text: clip(reply), parse_mode: "HTML" }).catch((e) => console.error(e.message));
  }

  /** Long-poll until stop(). The update offset is kept in source_cursors so a restart doesn't replay taps. */
  async run(db: Db, h: TelegramHandlers): Promise<void> {
    const getOffset = () => Number((db.prepare("SELECT cursor FROM source_cursors WHERE source = 'telegram' AND project_id = '*'").get() as any)?.cursor ?? 0);
    const setOffset = (n: number) => db.prepare(
      "INSERT INTO source_cursors (source, project_id, cursor, updated_at) VALUES ('telegram', '*', ?, ?) ON CONFLICT (source, project_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at",
    ).run(String(n), Date.now());
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const updates = await this.call<any[]>("getUpdates", { offset: getOffset(), timeout: 30, allowed_updates: ["message", "callback_query"] }, this.abort.signal);
        for (const u of updates) {
          setOffset(u.update_id + 1);
          await this.handleUpdate(u, h).catch((e) => console.error("telegram update:", e.message));
        }
      } catch (e) {
        if (this.stopped) break;
        console.error((e as Error).message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }
}
