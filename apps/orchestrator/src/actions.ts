import {
  createAction, decideAction, enqueue, expireActions, markExecuted, setActionMessage,
  type Action, type Approver, type Db, type Tier,
} from "@catapult/core";
import { loadProject, settingsFor } from "./project-config.ts";
import type { Services } from "./workers/index.ts";

/**
 * Carry out an approved action. An approved action becomes a job or a single tracker write;
 * there is no other execution path (guide §5).
 */
export async function executeAction(db: Db, services: Services, a: Action): Promise<unknown> {
  switch (a.kind) {
    case "update_ticket": {
      const project = loadProject(db, a.project_id!);
      const tracker = services.tracker(project, settingsFor(project));
      if (!tracker) throw new Error("no tracker for project");
      const { item, patch, questions, ready } = a.payload;
      await tracker.update(item.id, patch);
      if (questions?.length) await tracker.comment(item.id, `Open questions before this is ready:\n${questions.map((q: string) => `- ${q}`).join("\n")}`);
      // Implementing a ready item is a separate approval (plan: Groomer).
      if (ready) {
        await services.propose({
          kind: "enqueue_implementation", project_id: project.id, job_id: a.job_id ?? undefined,
          summary: `Implement #${item.id} ${item.title} and open a draft PR?\n${item.url}`,
          payload: { item: { ...item, body: patch.body ?? item.body }, tier: a.payload.tier ?? "trusted" },
        });
      }
      return { updated: item.id };
    }
    case "enqueue_implementation": {
      const { item, tier } = a.payload;
      const { job } = enqueue(db, {
        project_id: a.project_id!, worker: "implement", tier: (tier as Tier) ?? "trusted",
        input: { title: item.title, body: item.body, source: { tracker: "github", id: item.id, url: item.url } },
        idempotency_key: `action:${a.id}`, parent_job_id: a.job_id ?? undefined,
      });
      return { job: job.id };
    }
    default:
      throw new Error(`unknown action kind '${a.kind}'`);
  }
}

export type DecisionReply = { ok: true; status: string; result?: unknown } | { ok: false; error: string };

/** One decision path for Telegram, the UI and the CLI: record, update the message, execute if approved. */
export async function decide(
  db: Db, services: Services, id: string, decision: "approved" | "rejected", who: Approver, nonce?: string,
): Promise<DecisionReply> {
  const r = decideAction(db, id, decision, who, { nonce });
  if (!r.ok) {
    if (r.reason === "already_decided" && r.prior) {
      return { ok: false, error: `already ${r.prior.decision} by ${r.prior.approver_name ?? r.prior.approver_id} at ${new Date(r.prior.decided_at).toISOString()}` };
    }
    return { ok: false, error: r.reason.replace("_", " ") };
  }
  const by = `${decision} by ${who.name ?? who.id} via ${who.channel}`;
  if (decision === "rejected") {
    await services.notify.actionChanged(r.action, by);
    return { ok: true, status: "rejected" };
  }
  try {
    const result = await executeAction(db, services, r.action);
    markExecuted(db, id, result);
    await services.notify.actionChanged(r.action, `${by}; done`);
    return { ok: true, status: "executed", result };
  } catch (e) {
    await services.notify.actionChanged(r.action, `${by}; failed: ${(e as Error).message}`);
    return { ok: false, error: `approved, but executing failed: ${(e as Error).message}` };
  }
}

export function proposer(db: Db, services: Pick<Services, "notify">): Services["propose"] {
  return async (o) => {
    const a = createAction(db, o);
    await services.notify.sendAction(a);
    return a;
  };
}

/** Expire overdue actions and edit their messages to say so. */
export async function sweepActions(db: Db, services: Pick<Services, "notify">, now = Date.now()): Promise<void> {
  for (const a of expireActions(db, now)) await services.notify.actionChanged(a, "expired");
}

export { setActionMessage };
