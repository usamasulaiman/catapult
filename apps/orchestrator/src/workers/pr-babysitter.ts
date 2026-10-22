import { getRounds, recordRound, type Db, type Project, type Tier } from "@catapult/core";
import {
  buildPrompt, collectComments, decide, idempotencyKey, parseSummary,
  type BabysitterPolicy, type Decision, type PrState, type ReviewComment,
} from "@catapult/worker-pr-babysitter";
import { CATAPULT_MARKER, gitFetch, gitPush, type GitHub, type PrDetails } from "../github.ts";
import { esc } from "../notify/telegram.ts";
import type { ProjectSettings } from "../project-config.ts";
import { countCommits, headSha } from "../worktree.ts";
import type { Worker } from "./index.ts";

export const WORKER = "pr-babysitter";

export interface BabysitterInput {
  repo: string;
  number: number;
  title: string;
  headRef: string;
  headSha: string;
  ciFailing: boolean;
  comments: ReviewComment[];
  tier: Tier;
  /** When this round's input was read; conversation comments up to here count as handled afterwards. */
  roundStartedAt: string;
}

const subject = (repo: string, n: number) => `${repo}#${n}`;
const cursorKey = (project: string, repo: string, n: number) => [WORKER, `${project}:${subject(repo, n)}`] as const;

export function getCursor(db: Db, source: string, key: string): string | undefined {
  return (db.prepare("SELECT cursor FROM source_cursors WHERE source = ? AND project_id = ?").get(source, key) as any)?.cursor ?? undefined;
}
export function setCursor(db: Db, source: string, key: string, cursor: string): void {
  db.prepare(
    `INSERT INTO source_cursors (source, project_id, cursor, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (source, project_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
  ).run(source, key, cursor, Date.now());
}

export async function policyFor(gh: GitHub, settings: ProjectSettings): Promise<BabysitterPolicy> {
  const cfg = settings.pr_babysitter ?? {};
  return {
    maxRounds: cfg.max_rounds ?? 5,
    trustedAuthors: [await gh.viewer(), ...(cfg.trusted_authors ?? [])],
    ignoredAuthors: cfg.ignored_authors ?? [],
  };
}

/** Read a PR and apply the stop rules. Shared by the poller (enqueue) and the worker (re-check before running). */
export async function assess(db: Db, gh: GitHub, project: Project, settings: ProjectSettings, pr: PrDetails, now = new Date()) {
  const repo = project.repo_full_name!;
  const policy = await policyFor(gh, settings);
  const since = getCursor(db, ...cursorKey(project.id, repo, pr.number));
  const comments = collectComments(pr.threads, pr.issueComments, { marker: CATAPULT_MARKER, since });
  const state: PrState = { number: pr.number, title: pr.title, state: pr.state, headSha: pr.headSha, comments, ciFailing: pr.ciFailing };
  const rounds = getRounds(db, project.id, WORKER, subject(repo, pr.number));
  const decision: Decision = decide(state, rounds, policy);
  const input: BabysitterInput | undefined = decision.action === "run" ? {
    repo, number: pr.number, title: pr.title, headRef: pr.headRef, headSha: pr.headSha, ciFailing: pr.ciFailing,
    comments: decision.comments, tier: decision.tier, roundStartedAt: now.toISOString(),
  } : undefined;
  return { decision, input, state, policy, rounds, key: decision.action === "run" ? idempotencyKey(repo, state, decision.comments) : undefined };
}

export function prBabysitter(gh: GitHub | undefined): Worker<BabysitterInput> {
  const need = () => { if (!gh) throw new Error("pr-babysitter needs GITHUB_TOKEN"); return gh; };
  return {
    name: WORKER,
    tier: (input) => input.tier,

    // Re-read the PR right before running: it may have moved, closed or been answered since it was queued.
    async prepare(input, ctx) {
      const pr = await need().pr(input.repo, input.number);
      const a = await assess(ctx.db, need(), ctx.project, ctx.settings, pr);
      return a.input ?? null;
    },

    async checkout(input, ctx) {
      await gitFetch(need(), ctx.project.local_path, input.repo, input.headRef);
      return { branch: `catapult/${WORKER}/${input.number}-${ctx.job.id.slice(0, 8)}`, base: input.headSha };
    },

    prompt: (input, _project, settings) => buildPrompt(
      input.repo,
      { number: input.number, title: input.title, state: "open", headSha: input.headSha, comments: input.comments, ciFailing: input.ciFailing },
      input.comments, settings?.test,
    ),

    async evaluate(e) {
      const { input, settings, project, db } = e;
      const github = need();
      const pr = `${input.repo}#${input.number}`;
      if (settings.test) {
        const t = await e.exec(settings.test);
        if (!t.ok) {
          await e.services.notify.send(`🧪 ${esc(pr)}: tests failed after the agent's changes; nothing pushed.\n<pre>${esc(t.output.slice(-1500))}</pre>`);
          return { status: "needs_input", reason: "tests failed; not pushed" };
        }
      }
      const commits = await countCommits(e.worktree.path, input.headSha);
      let head = input.headSha;
      if (commits > 0) {
        await gitPush(github, e.worktree.path, input.repo, input.headRef);
        head = await headSha(e.worktree.path);
      }

      const outcomes = parseSummary(e.result.finalText);
      const lines: string[] = [];
      for (const c of input.comments) {
        const o = outcomes.get(c.id);
        const text = o ? `**${o.verdict}**: ${o.note}` : "Looked at this but did not report an outcome; a human should check.";
        if (c.thread) await github.replyToThread(c.id, `${text}${commits > 0 ? ` (in ${head.slice(0, 7)})` : ""}`);
        else lines.push(`- @${c.author}: ${text}`);
      }
      if (lines.length) await github.comment(input.repo, input.number, `Addressed conversation comments:\n${lines.join("\n")}`);

      // A round with no new commits leaves the head where it was, so the next poll stops with no_progress.
      const r = recordRound(db, project.id, WORKER, subject(input.repo, input.number), head);
      setCursor(db, ...cursorKey(project.id, input.repo, input.number), input.roundStartedAt);

      const counts = [...outcomes.values()].reduce((m, o) => ({ ...m, [o.verdict]: (m[o.verdict] ?? 0) + 1 }), {} as Record<string, number>);
      const summary = `${commits} commit(s) pushed; ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "no per-comment report"}; round ${r.rounds}`;
      await e.services.notify.send(`🔁 <b>${esc(pr)}</b> ${esc(input.title)}\n${esc(summary)}`);
      return { status: "succeeded", summary, keepWorktree: false };
    },
  };
}
