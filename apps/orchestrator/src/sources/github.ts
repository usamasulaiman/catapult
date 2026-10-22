import { enqueue, type Db } from "@catapult/core";
import type { GitHub } from "../github.ts";
import { esc, type Notifier } from "../notify/telegram.ts";
import { listProjects, settingsFor } from "../project-config.ts";
import { assess, getCursor, setCursor, WORKER } from "../workers/pr-babysitter.ts";

/**
 * Poll open PRs by you (the token's user) in every project with pr_babysitter enabled, and enqueue a
 * round when there is review input. This is the source of truth; the GitHub webhook only triggers it sooner.
 */
export async function pollPullRequests(db: Db, gh: GitHub, notify: Notifier, o: { repo?: string } = {}): Promise<string[]> {
  const enqueued: string[] = [];
  const me = await gh.viewer();
  for (const project of listProjects(db)) {
    const settings = settingsFor(project);
    const repo = project.repo_full_name;
    if (!repo || !settings.pr_babysitter?.enabled || (o.repo && o.repo !== repo)) continue;
    for (const { number, author } of await gh.openPrs(repo)) {
      if (author !== me) continue;
      const pr = await gh.pr(repo, number);
      if (pr.crossRepo) continue; // can't push to a fork's branch
      const a = await assess(db, gh, project, settings, pr);
      if (a.decision.action === "run") {
        const { job, created } = enqueue(db, {
          project_id: project.id, worker: WORKER, tier: a.decision.tier, input: a.input,
          idempotency_key: a.key, budget: { max_rounds: a.policy.maxRounds },
        });
        if (created) enqueued.push(job.id);
      } else if (a.decision.escalate) {
        // Escalate once per PR head and reason.
        const key = `${project.id}:${repo}#${number}`;
        const mark = `${a.decision.reason}:${pr.headSha}`;
        if (getCursor(db, "pr-babysitter-escalated", key) !== mark) {
          setCursor(db, "pr-babysitter-escalated", key, mark);
          const why = a.decision.reason === "max_rounds" ? `reached max_rounds (${a.policy.maxRounds})` : "the last round produced no changes";
          await notify.send(`🛑 <b>${esc(`${repo}#${number}`)}</b> ${esc(pr.title)}\nStopped: ${why}. It needs a human.`);
        }
      }
    }
  }
  return enqueued;
}
