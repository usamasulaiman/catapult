import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Marker on every comment catapult posts, so its own replies never count as new review input. */
export const CATAPULT_MARKER = "<!-- catapult -->";

export interface PrThread {
  id: string;
  resolved: boolean;
  path?: string;
  line?: number;
  comments: { id: string; author: string; body: string; createdAt: string }[];
}

export interface PrDetails {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  author: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  crossRepo: boolean;
  ciFailing: boolean;
  threads: PrThread[];
  issueComments: { id: string; author: string; body: string; createdAt: string }[];
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: string;
  url: string;
}

type Fetch = typeof fetch;

/** Thin GitHub REST + GraphQL client. The token never enters a sandbox; only the orchestrator holds it. */
export class GitHub {
  private viewerLogin?: string;
  private token: string;
  private api: string;
  private fetch: Fetch;

  constructor(token: string, o: { api?: string; fetch?: Fetch } = {}) {
    this.token = token;
    this.api = o.api ?? "https://api.github.com";
    this.fetch = o.fetch ?? fetch;
  }

  async rest<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(this.api + path, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`, accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? (undefined as T) : res.json() as Promise<T>;
  }

  async graphql<T = any>(query: string, variables: Record<string, unknown>): Promise<T> {
    const r = await this.rest<{ data?: T; errors?: { message: string }[] }>("POST", "/graphql", { query, variables });
    if (r.errors?.length) throw new Error(`GitHub GraphQL: ${r.errors.map((e) => e.message).join("; ")}`);
    return r.data!;
  }

  async viewer(): Promise<string> {
    this.viewerLogin ??= (await this.graphql<{ viewer: { login: string } }>("query { viewer { login } }", {})).viewer.login;
    return this.viewerLogin;
  }

  async openPrs(repo: string): Promise<{ number: number; author: string }[]> {
    const prs = await this.rest<any[]>("GET", `/repos/${repo}/pulls?state=open&per_page=100`);
    return prs.map((p) => ({ number: p.number, author: p.user?.login ?? "" }));
  }

  async pr(repo: string, number: number): Promise<PrDetails> {
    const [owner, name] = repo.split("/");
    const d = await this.graphql<any>(PR_QUERY, { owner, name, number });
    const p = d.repository.pullRequest;
    const rollup = p.commits.nodes[0]?.commit?.statusCheckRollup?.state;
    return {
      number: p.number, title: p.title, author: p.author?.login ?? "",
      state: p.merged ? "merged" : p.state === "OPEN" ? "open" : "closed",
      headRef: p.headRefName, headSha: p.headRefOid, baseRef: p.baseRefName, crossRepo: p.isCrossRepository,
      ciFailing: rollup === "FAILURE" || rollup === "ERROR",
      threads: p.reviewThreads.nodes.map((t: any) => ({
        id: t.id, resolved: t.isResolved, path: t.path ?? undefined, line: t.line ?? undefined,
        comments: t.comments.nodes.map((c: any) => ({ id: c.id, author: c.author?.login ?? "ghost", body: c.body, createdAt: c.createdAt })),
      })),
      issueComments: p.comments.nodes.map((c: any) => ({ id: c.id, author: c.author?.login ?? "ghost", body: c.body, createdAt: c.createdAt })),
    };
  }

  async replyToThread(threadId: string, body: string): Promise<void> {
    await this.graphql(
      "mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { id } } }",
      { id: threadId, body: `${body}\n\n${CATAPULT_MARKER}` },
    );
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    await this.rest("POST", `/repos/${repo}/issues/${number}/comments`, { body: `${body}\n\n${CATAPULT_MARKER}` });
  }

  async createDraftPr(repo: string, o: { head: string; base: string; title: string; body: string }): Promise<{ number: number; url: string }> {
    const r = await this.rest<any>("POST", `/repos/${repo}/pulls`, { ...o, draft: true });
    return { number: r.number, url: r.html_url };
  }

  async issues(repo: string): Promise<Issue[]> {
    const rows = await this.rest<any[]>("GET", `/repos/${repo}/issues?state=open&per_page=50`);
    return rows.filter((i) => !i.pull_request).map((i) => ({
      number: i.number, title: i.title, body: i.body ?? "", labels: i.labels.map((l: any) => (typeof l === "string" ? l : l.name)),
      author: i.user?.login ?? "", url: i.html_url,
    }));
  }

  async updateIssue(repo: string, number: number, patch: { body?: string; addLabels?: string[] }): Promise<void> {
    if (patch.body !== undefined) await this.rest("PATCH", `/repos/${repo}/issues/${number}`, { body: patch.body });
    if (patch.addLabels?.length) await this.rest("POST", `/repos/${repo}/issues/${number}/labels`, { labels: patch.addLabels });
  }

  /** Git credential env for pushing over HTTPS without putting the token in argv or the remote URL. */
  gitEnv(): Record<string, string> {
    return {
      GIT_TERMINAL_PROMPT: "0",
      CATAPULT_GH_TOKEN: this.token,
    };
  }
}

/** git argv prefix that authenticates https://github.com with CATAPULT_GH_TOKEN from the environment. */
export const GIT_AUTH = [
  "-c", "credential.helper=",
  "-c", "credential.helper=!f() { echo username=x-access-token; echo \"password=$CATAPULT_GH_TOKEN\"; }; f",
];

export async function gitPush(gh: GitHub, cwd: string, repo: string, ref: string): Promise<void> {
  await exec("git", [...GIT_AUTH, "push", `https://github.com/${repo}.git`, `HEAD:refs/heads/${ref}`], {
    cwd, env: { ...process.env, ...gh.gitEnv() },
  });
}

export async function gitFetch(gh: GitHub | undefined, cwd: string, repo: string, ref: string): Promise<void> {
  await exec("git", [...(gh ? GIT_AUTH : []), "fetch", "-q", `https://github.com/${repo}.git`, `+refs/heads/${ref}:refs/catapult/${ref}`], {
    cwd, env: { ...process.env, ...gh?.gitEnv() },
  });
}

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title state merged isCrossRepository headRefName headRefOid baseRefName
      author { login }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      reviewThreads(first: 100) { nodes {
        id isResolved path line
        comments(first: 50) { nodes { id body createdAt author { login } } }
      } }
      comments(last: 50) { nodes { id body createdAt author { login } } }
    }
  }
}`;
