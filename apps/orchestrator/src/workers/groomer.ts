import { buildPrompt, describe, parseProposals, type BacklogItem } from "@catapult/worker-groomer";
import type { GitHub } from "../github.ts";
import type { Worker } from "./index.ts";

export interface GroomerInput {
  limit?: number;
  items?: BacklogItem[];
  /** Set by prepare: any item written by someone outside the trusted list. */
  untrusted?: boolean;
}

export const readyLabel = (s: { ready_label?: string }) => s.ready_label ?? "ready";

/** Proposes refinements for backlog items that aren't ready. Every change is an action that needs approval. */
export function groomer(gh: GitHub | undefined): Worker<GroomerInput> {
  return {
    name: "groomer",
    async prepare(input, ctx) {
      const tracker = ctx.services.tracker(ctx.project, ctx.settings);
      if (!tracker) throw new Error(`project ${ctx.project.id} has no usable tracker (set repo_full_name and GITHUB_TOKEN)`);
      const items = await tracker.list({ excludeLabel: readyLabel(ctx.settings), limit: input?.limit ?? 5 });
      if (items.length === 0) return null;
      const trusted = new Set([...(gh ? [await gh.viewer()] : []), ...(ctx.settings.pr_babysitter?.trusted_authors ?? [])]);
      return { ...input, items, untrusted: items.some((i) => !trusted.has(i.author)) };
    },
    tier: (input) => (input.untrusted ? "untrusted" : "trusted"),
    prompt: (input, _p, settings) => buildPrompt(input.items ?? [], readyLabel(settings ?? {})),
    async evaluate(e) {
      const items = e.input.items ?? [];
      const proposals = parseProposals(e.result.finalText, items.map((i) => i.id));
      const label = readyLabel(e.settings);
      for (const p of proposals) {
        const item = items.find((i) => i.id === p.id)!;
        if (!p.ready && !p.body && p.questions.length === 0) continue;
        await e.services.propose({
          kind: "update_ticket", project_id: e.project.id, job_id: e.job.id, run_id: e.runId,
          summary: describe(item, p, label),
          payload: {
            item, patch: { body: p.body, addLabels: p.ready ? [label] : [] }, questions: p.questions, ready: p.ready,
            tier: e.input.untrusted ? "untrusted" : "trusted",
          },
        });
      }
      if (proposals.length === 0) return { status: "needs_input", reason: "groomer produced no parseable proposals" };
      return { status: "succeeded", summary: `${proposals.length} proposal(s) for ${items.length} item(s)` };
    },
  };
}
