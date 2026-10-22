import type { GitHub } from "../github.ts";

export interface TrackerItem {
  id: string;
  title: string;
  body: string;
  labels: string[];
  author: string;
  url: string;
}

export interface TrackerPatch {
  body?: string;
  addLabels?: string[];
}

/**
 * Backlog source for a project (plan: Groomer). Workers stay tracker-agnostic.
 * Only GitHub Issues is implemented: no extra SaaS beyond the code host.
 */
export interface Tracker {
  kind: string;
  list(filter: { excludeLabel?: string; limit?: number }): Promise<TrackerItem[]>;
  get(id: string): Promise<TrackerItem | undefined>;
  update(id: string, patch: TrackerPatch): Promise<void>;
  comment(id: string, body: string): Promise<void>;
}

export function githubTracker(gh: GitHub, repo: string): Tracker {
  const toItem = (i: Awaited<ReturnType<GitHub["issues"]>>[number]): TrackerItem =>
    ({ id: String(i.number), title: i.title, body: i.body, labels: i.labels, author: i.author, url: i.url });
  return {
    kind: "github",
    async list({ excludeLabel, limit = 10 }) {
      const all = await gh.issues(repo);
      return all.filter((i) => !excludeLabel || !i.labels.includes(excludeLabel)).slice(0, limit).map(toItem);
    },
    async get(id) {
      const i = await gh.rest<any>("GET", `/repos/${repo}/issues/${Number(id)}`).catch(() => undefined);
      return i && !i.pull_request
        ? toItem({ number: i.number, title: i.title, body: i.body ?? "", labels: i.labels.map((l: any) => l.name ?? l), author: i.user?.login ?? "", url: i.html_url })
        : undefined;
    },
    update: (id, patch) => gh.updateIssue(repo, Number(id), patch),
    comment: (id, body) => gh.comment(repo, Number(id), body),
  };
}
