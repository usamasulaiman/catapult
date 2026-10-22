import { cancel, enqueue, getAction, type Db } from "@catapult/core";
import { decide } from "../actions.ts";
import type { Dispatcher } from "../dispatcher.ts";
import { costToday, queueCounts, workerStats } from "../metrics.ts";
import type { Services } from "../workers/index.ts";
import { esc, type TelegramHandlers } from "./telegram.ts";

/** Telegram commands and approval taps, routed to the same functions the API uses. */
export function telegramHandlers(db: Db, services: Services, dispatcher: Pick<Dispatcher, "cancel">, workers: string[]): TelegramHandlers {
  return {
    async command(name, args) {
      switch (name) {
        case "status": {
          const q = queueCounts(db);
          const w = workerStats(db).map((s) =>
            `${esc(s.worker)}: ${s.succeeded}/${s.runs} ok, median $${(s.median_cost_usd ?? 0).toFixed(2)}, 7d $${s.cost_usd_7d.toFixed(2)}`);
          return [`<b>Queue</b> ${esc(Object.entries(q).map(([k, v]) => `${k} ${v}`).join(", ") || "empty")}`,
            `<b>Today</b> $${costToday(db).toFixed(2)}`, ...(w.length ? ["<b>Workers (7d)</b>", ...w] : [])].join("\n");
        }
        case "jobs": {
          const rows = db.prepare("SELECT id, project_id, worker, status FROM jobs ORDER BY created_at DESC LIMIT 10").all() as any[];
          return rows.map((j) => `<code>${j.id.slice(0, 8)}</code> ${esc(j.project_id)} ${esc(j.worker)} — ${j.status}`).join("\n") || "no jobs";
        }
        case "cancel": {
          const prefix = args[0];
          if (!prefix) return "usage: /cancel &lt;job&gt;";
          const matches = db.prepare("SELECT id FROM jobs WHERE id LIKE ? LIMIT 2").all(`${prefix}%`) as { id: string }[];
          if (matches.length !== 1) return matches.length ? "ambiguous job id" : "no such job";
          const id = matches[0]!.id;
          if (!cancel(db, id)) return "not cancellable";
          await dispatcher.cancel(id);
          return `cancelled <code>${id.slice(0, 8)}</code>`;
        }
        case "run": {
          const [worker, project] = args;
          if (!worker || !project) return "usage: /run &lt;worker&gt; &lt;project&gt;";
          if (!workers.includes(worker)) return `unknown worker; one of ${esc(workers.join(", "))}`;
          if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(project)) return "unknown project";
          const { job } = enqueue(db, { project_id: project, worker, tier: "trusted" });
          return `queued <code>${job.id.slice(0, 8)}</code>`;
        }
        default:
          return "commands: /status /jobs /cancel &lt;job&gt; /run &lt;worker&gt; &lt;project&gt;";
      }
    },
    async decide(actionId, nonce, decision, from, messageId) {
      const r = await decide(db, services, actionId, decision, { channel: "telegram", id: from.id, name: from.name, messageId }, nonce);
      return r.ok ? (r.status === "rejected" ? "rejected" : "approved") : r.error;
    },
    details(actionId) {
      const a = getAction(db, actionId);
      if (!a) return "no such action";
      return `<b>${esc(a.kind)}</b> (${a.status})\n<pre>${esc(JSON.stringify(a.payload, null, 2).slice(0, 3500))}</pre>`;
    },
  };
}
