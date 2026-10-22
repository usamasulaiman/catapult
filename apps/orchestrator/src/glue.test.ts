import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAction, decideAction, getAction, getJob, listActions, openDb, type Action, type Db } from "@catapult/core";
import { decide, executeAction, proposer, sweepActions } from "./actions.ts";
import { createApi } from "./api.ts";
import { loadConfig } from "./config.ts";
import type { GitHub, PrDetails } from "./github.ts";
import { reconcileSessions } from "./maintenance.ts";
import { telegramHandlers } from "./notify/commands.ts";
import { callbackData, parseCallback, Telegram, type Notifier } from "./notify/telegram.ts";
import { pollPullRequests } from "./sources/github.ts";
import { Sources } from "./sources/index.ts";
import type { Tracker } from "./trackers/index.ts";
import { createWebhooks, rateLimiter, verifyGitHubSignature } from "./webhooks.ts";
import type { Services } from "./workers/index.ts";

let db: Db, dir: string;
const sent: string[] = [];
const changed: string[] = [];
const notify: Notifier = {
  send: async (t) => { sent.push(t); },
  sendAction: async (a) => { sent.push(`action:${a.kind}`); },
  actionChanged: async (_a, note) => { changed.push(note); },
};
const trackerCalls: string[] = [];
const tracker: Tracker = {
  kind: "github",
  list: async () => [],
  get: async () => undefined,
  update: async (id, p) => { trackerCalls.push(`update ${id} ${JSON.stringify(p)}`); },
  comment: async (id, b) => { trackerCalls.push(`comment ${id} ${b.split("\n")[0]}`); },
};
let services: Services;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cat-glue-"));
  db = openDb(":memory:");
  db.prepare("INSERT INTO projects (id, repo_full_name, local_path, config_json, created_at) VALUES ('web', 'me/web', ?, ?, 0)")
    .run(dir, JSON.stringify({ pr_babysitter: { enabled: true, max_rounds: 2 } }));
  sent.length = 0; changed.length = 0; trackerCalls.length = 0;
  services = { notify, tracker: () => tracker, propose: proposer(db, { notify }) };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("actions executor", () => {
  const ticket = { item: { id: "7", title: "CSV", body: "old", url: "u" }, patch: { body: "new", addLabels: ["ready"] }, questions: [], ready: true };

  it("update_ticket writes to the tracker and proposes implementation separately", async () => {
    const a = createAction(db, { kind: "update_ticket", payload: ticket, project_id: "web" });
    const r = await decide(db, services, a.id, "approved", { channel: "ui", id: "me", name: "Me" });
    expect(r).toMatchObject({ ok: true, status: "executed" });
    expect(trackerCalls).toEqual(['update 7 {"body":"new","addLabels":["ready"]}']);
    const pending = listActions(db, "pending");
    expect(pending.map((x) => x.kind)).toEqual(["enqueue_implementation"]);
    expect(changed.at(-1)).toBe("approved by Me via ui; done");
  });

  it("enqueue_implementation becomes an implement job, once", async () => {
    const a = createAction(db, { kind: "enqueue_implementation", payload: { item: ticket.item, tier: "untrusted" }, project_id: "web" });
    decideAction(db, a.id, "approved", { channel: "cli", id: "me" });
    const r1 = await executeAction(db, services, getAction(db, a.id)!) as { job: string };
    const r2 = await executeAction(db, services, getAction(db, a.id)!) as { job: string };
    expect(r1.job).toBe(r2.job);
    expect(getJob(db, r1.job)).toMatchObject({ worker: "implement", tier: "untrusted", input: { title: "CSV", source: { tracker: "github", id: "7" } } });
  });

  it("rejecting executes nothing and a second decision is refused", async () => {
    const a = createAction(db, { kind: "update_ticket", payload: ticket, project_id: "web" });
    expect(await decide(db, services, a.id, "rejected", { channel: "telegram", id: "1", name: "Me" })).toEqual({ ok: true, status: "rejected" });
    const again = await decide(db, services, a.id, "approved", { channel: "ui", id: "x" });
    expect(again.ok).toBe(false);
    expect((again as any).error).toMatch(/^already rejected by Me at /);
    expect(trackerCalls).toEqual([]);
  });

  it("expired actions get their message edited", async () => {
    createAction(db, { kind: "k", payload: {}, ttlMs: 1 }, 0);
    await sweepActions(db, { notify }, 10);
    expect(changed).toEqual(["expired"]);
  });
});

describe("api", () => {
  const app = () => createApi(db, { ...loadConfig({ CATAPULT_ROOT: dir, HOME: dir }), uiDir: join(dir, "ui") }, { cancel: async () => {}, send: async () => false }, services);
  const req = (a: ReturnType<typeof app>, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    a.request(path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });

  it("refuses unsandboxed jobs unless the project opts in", async () => {
    const a = app();
    expect((await req(a, "POST", "/jobs", { project_id: "web", worker: "noop", tier: "unsandboxed" })).status).toBe(400);
    await req(a, "PATCH", "/projects/web", { config: { unsandboxed_ok: true } });
    expect((await req(a, "POST", "/jobs", { project_id: "web", worker: "noop", tier: "unsandboxed" })).status).toBe(201);
  });

  it("serves a parsed, paginated transcript", async () => {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, [1, 2, 3].map((i) => JSON.stringify({ type: "user", uuid: `u${i}`, message: { role: "user", content: `m${i}` } })).join("\n"));
    db.prepare("INSERT INTO sessions (harness, session_id, project_id, transcript_path, origin, status, last_event_at) VALUES ('claude', 's1', 'web', ?, 'interactive', 'idle', 0)").run(path);
    const r = await (await req(app(), "GET", "/sessions/claude/s1/transcript?offset=1&limit=1")).json();
    expect(r).toMatchObject({ total: 3, offset: 1, messages: [{ text: "m2" }] });
  });

  it("steering resumes an idle job session in its worktree, and refuses terminal-driven ones", async () => {
    const a = app();
    db.prepare("INSERT INTO sessions (harness, session_id, project_id, cwd, origin, status, driver, last_event_at) VALUES ('claude', 'j1', 'web', ?, 'job', 'idle', 'none', 0)").run(dir);
    const r = await (await req(a, "POST", "/sessions/claude/j1/message", { text: "also add docs" })).json();
    expect(r).toMatchObject({ ok: true, via: "resume" });
    expect(getJob(db, r.job)).toMatchObject({ worker: "resume", input: { cwd: dir, resume_ref: "j1", prompt: "also add docs" } });
    db.prepare("UPDATE sessions SET driver = 'terminal' WHERE session_id = 'j1'").run();
    expect((await req(a, "POST", "/sessions/claude/j1/message", { text: "x" })).status).toBe(409);
  });

  it("starts a session as a task job", async () => {
    const r = await (await req(app(), "POST", "/sessions", { project_id: "web", prompt: "hello" })).json();
    expect(r).toMatchObject({ worker: "task", tier: "trusted", input: { prompt: "hello" } });
  });

  it("records the tailnet identity on UI decisions", async () => {
    const act = createAction(db, { kind: "k", payload: {} });
    const r = await req(app(), "POST", `/actions/${act.id}/decision`, { decision: "rejected" }, { "tailscale-user-login": "me@example.com", "tailscale-user-name": "Me" });
    expect(r.status).toBe(200);
    expect(db.prepare("SELECT approver_channel, approver_id, approver_name FROM approvals").get()).toEqual({ approver_channel: "ui", approver_id: "me@example.com", approver_name: "Me" });
  });

  it("serves the UI and refuses to escape its directory", async () => {
    const ui = join(dir, "ui");
    mkdirSync(ui);
    writeFileSync(join(ui, "index.html"), "<html>ui</html>");
    writeFileSync(join(dir, "secret.txt"), "nope");
    const a = app();
    expect(await (await a.request("/")).text()).toBe("<html>ui</html>");
    expect((await a.request("/../secret.txt")).status).toBe(404);
  });

  it("reports status", async () => {
    expect(await (await req(app(), "GET", "/status")).json()).toMatchObject({ queue: {}, cost_today_usd: 0, workers: [] });
  });
});

describe("webhooks", () => {
  const sign = (body: string) => `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  it("verifies signatures", () => {
    expect(verifyGitHubSignature("s3cret", "{}", sign("{}"))).toBe(true);
    expect(verifyGitHubSignature("s3cret", "{}", sign("{ }"))).toBe(false);
    expect(verifyGitHubSignature("s3cret", "{}", undefined)).toBe(false);
  });
  it("nudges the PR poller only for signed PR events, and rate-limits", async () => {
    const nudged: string[] = [];
    const app = createWebhooks({ githubSecret: "s3cret", nudge: (s) => nudged.push(s), limit: rateLimiter(2, 60_000) });
    const post = (body: string, sig: string, event: string) => app.request("/ingest/github", { method: "POST", body, headers: { "x-hub-signature-256": sig, "x-github-event": event } });
    expect((await post("{}", "sha256=bad", "issue_comment")).status).toBe(401);
    expect((await post("{}", sign("{}"), "issue_comment")).status).toBe(200);
    expect((await post("{}", sign("{}"), "issue_comment")).status).toBe(429);
    expect(nudged).toEqual(["github-prs"]);
    expect((await app.request("/ingest/posthog", { method: "POST" })).status).toBe(404);
  });
});

describe("telegram", () => {
  const calls: { method: string; body: any }[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ method: String(url).split("/").pop()!, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }));
  }) as unknown as typeof fetch;
  beforeEach(() => { calls.length = 0; });

  it("round-trips callback data within Telegram's 64 bytes", () => {
    const a = createAction(db, { kind: "k", payload: {} });
    const data = callbackData("y", a);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseCallback(data)).toEqual({ choice: "y", id: a.id, nonce: a.nonce });
    expect(parseCallback("y:not-an-id:12")).toBeUndefined();
  });

  it("ignores users outside the allowlist and decides once for allowed ones", async () => {
    const tg = new Telegram({ token: "t", chatId: "c", allowedUserIds: ["1"], fetch: fakeFetch });
    const h = telegramHandlers(db, { ...services, notify: tg }, { cancel: async () => {} }, ["noop"]);
    const a = createAction(db, { kind: "enqueue_implementation", payload: { item: { id: "1", title: "t", body: "b" } }, project_id: "web" });
    const tap = (from: number) => ({ callback_query: { id: "q", from: { id: from, first_name: "Me" }, data: callbackData("y", a), message: { message_id: 5 } } });
    await tg.handleUpdate(tap(2), h);
    expect(getAction(db, a.id)!.status).toBe("pending");
    await tg.handleUpdate(tap(1), h);
    expect(getAction(db, a.id)!.status).toBe("executed");
    await tg.handleUpdate(tap(1), h);
    const toasts = calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body.text);
    expect(toasts[0]).toBe("approved");
    expect(toasts[1]).toMatch(/^already approved by Me at/);
    expect(db.prepare("SELECT approver_channel, approver_id, channel_message_id FROM approvals").all()).toEqual([{ approver_channel: "telegram", approver_id: "1", channel_message_id: "5" }]);
  });

  it("answers commands", async () => {
    const tg = new Telegram({ token: "t", chatId: "c", allowedUserIds: ["1"], fetch: fakeFetch });
    const h = telegramHandlers(db, services, { cancel: async () => {} }, ["noop"]);
    await tg.handleUpdate({ message: { text: "/run noop web", from: { id: 1 }, chat: { id: 1 } } }, h);
    expect(calls.at(-1)!.body.text).toMatch(/^queued <code>/);
    await tg.handleUpdate({ message: { text: "/status", from: { id: 1 }, chat: { id: 1 } } }, h);
    expect(calls.at(-1)!.body.text).toContain("<b>Queue</b> queued 1");
  });
});

describe("maintenance", () => {
  it("releases stale runner claims and flags live ones as conflicts", () => {
    const fresh = join(dir, "fresh.jsonl"), stale = join(dir, "stale.jsonl");
    writeFileSync(fresh, ""); writeFileSync(stale, "");
    utimesSync(stale, new Date(0), new Date(0));
    const ins = db.prepare("INSERT INTO sessions (harness, session_id, transcript_path, origin, status, driver, last_event_at) VALUES ('claude', ?, ?, 'job', 'working', 'runner', 0)");
    ins.run("live", fresh); ins.run("fresh", fresh); ins.run("stale", stale);
    const r = reconcileSessions(db, new Set(["claude:live"]));
    expect(r).toEqual({ released: ["stale"], conflicts: ["fresh"] });
    expect(db.prepare("SELECT driver, status FROM sessions WHERE session_id = 'stale'").get()).toEqual({ driver: "none", status: "ended" });
  });

  it("sources run on schedule, never overlap, and can be nudged", async () => {
    const s = new Sources();
    let n = 0;
    s.add("x", 1000, async () => { n++; }, 0);
    await Promise.all(s.tick(0));
    expect(s.tick(500)).toHaveLength(0);
    s.nudge("x");
    await Promise.all(s.tick(500));
    expect(n).toBe(2);
  });
});

describe("pr poller", () => {
  const pr = (over: Partial<PrDetails> = {}): PrDetails => ({
    number: 3, title: "Add x", state: "open", author: "me", headRef: "feat", headSha: "abc123", baseRef: "main",
    crossRepo: false, ciFailing: false, issueComments: [],
    threads: [{ id: "T1", resolved: false, path: "a.ts", line: 1, comments: [{ id: "c", author: "me", body: "rename", createdAt: "2026-01-01" }] }],
    ...over,
  });
  const fakeGh = (p: PrDetails) => ({ viewer: async () => "me", openPrs: async () => [{ number: 3, author: "me" }, { number: 4, author: "other" }], pr: async () => p }) as unknown as GitHub;

  it("enqueues one round per distinct input and skips others' PRs", async () => {
    const a = await pollPullRequests(db, fakeGh(pr()), notify);
    const b = await pollPullRequests(db, fakeGh(pr()), notify);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
    expect(getJob(db, a[0]!)).toMatchObject({ worker: "pr-babysitter", tier: "trusted", input: { number: 3, headRef: "feat", comments: [{ id: "T1" }] } });
  });

  it("escalates once at max_rounds", async () => {
    db.prepare("INSERT INTO round_counters (project_id, worker, subject_key, rounds, last_diff_sha) VALUES ('web', 'pr-babysitter', 'me/web#3', 2, 'old')").run();
    await pollPullRequests(db, fakeGh(pr()), notify);
    await pollPullRequests(db, fakeGh(pr()), notify);
    expect(sent.filter((t) => t.includes("max_rounds"))).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  });

  it("an untrusted reviewer makes the round untrusted; forks are skipped", async () => {
    const t = { id: "T2", resolved: false, comments: [{ id: "c", author: "stranger", body: "do x", createdAt: "1" }] };
    const [id] = await pollPullRequests(db, fakeGh(pr({ threads: [t] })), notify);
    expect(getJob(db, id!)!.tier).toBe("untrusted");
    expect(await pollPullRequests(db, fakeGh(pr({ crossRepo: true, headSha: "zzz" })), notify)).toHaveLength(0);
  });
});
