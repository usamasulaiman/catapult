import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { cancel, enqueue, getJob, listActions, getAction, type ActionStatus, type Approver, type Db, type Tier } from "@catapult/core";
import { claudeTranscriptPath, parseClaudeTranscript } from "@catapult/harness-claude";
import { parsePiTranscript } from "@catapult/harness-pi";
import { decide } from "./actions.ts";
import type { Config } from "./config.ts";
import type { Dispatcher } from "./dispatcher.ts";
import { costToday, queueCounts, workerStats } from "./metrics.ts";
import { nullNotifier } from "./notify/telegram.ts";
import { loadProject, settingsFor } from "./project-config.ts";
import { ingestEvent, release, takeover, type IngestEvent } from "./sessions.ts";
import type { Services } from "./workers/index.ts";

const TIERS = new Set<Tier>(["trusted", "untrusted", "unsandboxed"]);
const ACTION_STATUSES = new Set(["pending", "approved", "rejected", "expired", "executed"]);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json", ".ico": "image/x-icon",
};

/** Who is calling. `tailscale serve` adds the tailnet identity headers; without them it's a local caller. */
export function approverFrom(c: Context, channel: Approver["channel"] = "ui"): Approver {
  return {
    channel,
    id: c.req.header("tailscale-user-login") ?? "local",
    name: c.req.header("tailscale-user-name") ?? c.req.header("tailscale-user-login") ?? "local",
  };
}

type ApiDispatcher = Pick<Dispatcher, "cancel" | "send">;

export function createApi(db: Db, config: Config, dispatcher?: ApiDispatcher, services?: Services) {
  const app = new Hono();
  const rows = (sql: string, ...args: any[]) => db.prepare(sql).all(...args);
  const svc: Services = services ?? { notify: nullNotifier, tracker: () => undefined, propose: async () => { throw new Error("actions unavailable"); } };

  // The desktop app loads the bundled UI from its own origin and talks to this API.
  app.use("*", cors({ origin: ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"] }));

  app.get("/health", (c) => c.json({ ok: true }));

  // Hooks and pi extension post here. Loopback only (the server binds 127.0.0.1); always 200 so hooks stay quiet.
  app.post("/ingest", async (c) => {
    const e = (await c.req.json().catch(() => undefined)) as IngestEvent | undefined;
    if (e && (e.harness === "claude" || e.harness === "pi") && typeof e.event === "string") {
      ingestEvent(db, e, { worktreesDir: config.worktreesDir });
    }
    return c.json({ ok: true });
  });

  app.get("/projects", (c) => c.json(rows("SELECT * FROM projects ORDER BY id")));
  app.post("/projects", async (c) => {
    const b = await c.req.json();
    if (!b?.id || !b?.local_path) return c.json({ error: "id and local_path required" }, 400);
    db.prepare(
      "INSERT INTO projects (id, repo_full_name, default_branch, local_path, config_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(b.id, b.repo_full_name ?? null, b.default_branch ?? "main", b.local_path, JSON.stringify(b.config ?? {}), Date.now());
    return c.json({ ok: true }, 201);
  });
  app.get("/projects/:id", (c) => {
    try {
      const p = loadProject(db, c.req.param("id"));
      return c.json({ ...p, settings: settingsFor(p) });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });
  // Merge keys into the DB config (the UI's per-project settings, e.g. pr_babysitter).
  app.patch("/projects/:id", async (c) => {
    const b = await c.req.json();
    const r = db.prepare("SELECT config_json FROM projects WHERE id = ?").get(c.req.param("id")) as { config_json: string } | undefined;
    if (!r) return c.json({ error: "not found" }, 404);
    const config = { ...JSON.parse(r.config_json), ...(b?.config ?? {}) };
    db.prepare("UPDATE projects SET config_json = ? WHERE id = ?").run(JSON.stringify(config), c.req.param("id"));
    return c.json({ ok: true, config });
  });

  app.get("/projects/:id/schedules", (c) => c.json(rows("SELECT * FROM schedules WHERE project_id = ?", c.req.param("id"))));
  app.post("/projects/:id/schedules", async (c) => {
    const b = await c.req.json();
    if (!b?.worker || !b?.cron) return c.json({ error: "worker and cron required" }, 400);
    const id = randomUUID(), now = Date.now();
    db.prepare("INSERT INTO schedules (id, project_id, worker, cron, input_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
      .run(id, c.req.param("id"), b.worker, b.cron, JSON.stringify(b.input ?? {}), now, now);
    return c.json({ id }, 201);
  });
  app.patch("/schedules/:id", async (c) => {
    const b = await c.req.json();
    const r = db.prepare("UPDATE schedules SET enabled = COALESCE(?, enabled), cron = COALESCE(?, cron), updated_at = ? WHERE id = ?")
      .run(b.enabled === undefined ? null : b.enabled ? 1 : 0, b.cron ?? null, Date.now(), c.req.param("id"));
    return Number(r.changes) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });
  app.delete("/schedules/:id", (c) =>
    Number(db.prepare("DELETE FROM schedules WHERE id = ?").run(c.req.param("id")).changes) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404));

  app.get("/jobs", (c) => {
    const { project, status } = c.req.query();
    return c.json(rows(
      "SELECT * FROM jobs WHERE (?1 IS NULL OR project_id = ?1) AND (?2 IS NULL OR status = ?2) ORDER BY created_at DESC LIMIT 200",
      project ?? null, status ?? null,
    ));
  });
  app.get("/projects/:id/jobs", (c) => c.json(rows("SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 200", c.req.param("id"))));
  app.post("/jobs", async (c) => {
    const b = await c.req.json();
    if (!b?.project_id || !b?.worker) return c.json({ error: "project_id and worker required" }, 400);
    const tier: Tier = b.tier ?? "trusted";
    if (!TIERS.has(tier)) return c.json({ error: `bad tier '${tier}'` }, 400);
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(b.project_id)) return c.json({ error: "unknown project" }, 404);
    if (tier === "unsandboxed" && !settingsFor(loadProject(db, b.project_id)).unsandboxed_ok) {
      return c.json({ error: "project does not allow unsandboxed jobs (set unsandboxed_ok)" }, 400);
    }
    const { job } = enqueue(db, { project_id: b.project_id, worker: b.worker, input: b.input, tier, budget: b.budget, idempotency_key: b.idempotency_key });
    return c.json(job, 201);
  });
  app.get("/jobs/:id", (c) => {
    const j = getJob(db, c.req.param("id"));
    return j ? c.json({ ...j, runs: rows("SELECT * FROM runs WHERE job_id = ? ORDER BY started_at", j.id) }) : c.json({ error: "not found" }, 404);
  });
  app.post("/jobs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const prev = cancel(db, id);
    if (!prev) return c.json({ error: "not cancellable" }, 409);
    await dispatcher?.cancel(id);
    return c.json({ ok: true, previous: prev });
  });

  app.get("/sessions", (c) => {
    const { project, status } = c.req.query();
    return c.json(rows(
      "SELECT * FROM sessions WHERE (?1 IS NULL OR project_id = ?1) AND (?2 IS NULL OR status = ?2) ORDER BY last_event_at DESC LIMIT 200",
      project ?? null, status ?? null,
    ));
  });
  // Start a new agent session as a job (it shows up in /sessions once the harness reports its id).
  app.post("/sessions", async (c) => {
    const b = await c.req.json();
    if (!b?.project_id || !b?.prompt) return c.json({ error: "project_id and prompt required" }, 400);
    if (!db.prepare("SELECT 1 FROM projects WHERE id = ?").get(b.project_id)) return c.json({ error: "unknown project" }, 404);
    const { job } = enqueue(db, { project_id: b.project_id, worker: "task", tier: "trusted", input: { prompt: b.prompt, harness: b.harness } });
    return c.json(job, 201);
  });
  app.get("/sessions/:harness/:id/transcript", async (c) => {
    const { harness, id } = c.req.param();
    const s = db.prepare("SELECT * FROM sessions WHERE harness = ? AND session_id = ?").get(harness, id) as any;
    if (!s) return c.json({ error: "no such session" }, 404);
    const path = s.transcript_path ?? (harness === "claude" && s.cwd ? claudeTranscriptPath(config.home, s.cwd, id) : null);
    const text = path ? await readFile(path, "utf8").catch(() => "") : "";
    const all = harness === "pi" ? parsePiTranscript(text) : parseClaudeTranscript(text);
    const limit = Math.min(Number(c.req.query("limit") ?? 200), 1000);
    const offset = c.req.query("offset") === undefined ? Math.max(0, all.length - limit) : Number(c.req.query("offset"));
    return c.json({ session: s, total: all.length, offset, messages: all.slice(offset, offset + limit) });
  });
  // Steer: a live run gets the message directly; an idle job session is resumed in its worktree.
  app.post("/sessions/:harness/:id/message", async (c) => {
    const { harness, id } = c.req.param();
    const text = (await c.req.json().catch(() => ({})))?.text;
    if (!text) return c.json({ error: "text required" }, 400);
    const s = db.prepare("SELECT * FROM sessions WHERE harness = ? AND session_id = ?").get(harness, id) as any;
    if (!s) return c.json({ error: "no such session" }, 404);
    if (s.driver === "terminal") return c.json({ error: "session is taken over in a terminal; release it first" }, 409);
    if (s.driver === "runner") {
      if (await dispatcher?.send(id, text)) return c.json({ ok: true, via: "live" });
      return c.json({ error: "runner holds the session but no process is live; try again shortly" }, 409);
    }
    if (s.origin !== "job" || !s.cwd || !existsSync(s.cwd)) return c.json({ error: "only job sessions with a worktree can be resumed from here" }, 409);
    const run = db.prepare("SELECT j.tier FROM runs r JOIN jobs j ON j.id = r.job_id WHERE r.session_id = ? ORDER BY r.started_at DESC LIMIT 1").get(id) as { tier: Tier } | undefined;
    const { job } = enqueue(db, {
      project_id: s.project_id, worker: "resume", tier: run?.tier ?? "trusted",
      input: { harness, session_id: id, resume_ref: harness === "pi" ? s.transcript_path ?? id : id, cwd: s.cwd, prompt: text },
    });
    return c.json({ ok: true, via: "resume", job: job.id }, 202);
  });
  app.post("/sessions/:harness/:id/takeover", (c) => {
    const r = takeover(db, c.req.param("harness"), c.req.param("id"));
    return c.json(r, r.ok ? 200 : 409);
  });
  app.post("/sessions/:harness/:id/release", (c) =>
    release(db, c.req.param("harness"), c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not taken over" }, 409));

  app.get("/actions", (c) => {
    const status = c.req.query("status");
    if (status && !ACTION_STATUSES.has(status)) return c.json({ error: "bad status" }, 400);
    return c.json(listActions(db, status as ActionStatus | undefined));
  });
  app.get("/actions/:id", (c) => {
    const a = getAction(db, c.req.param("id"));
    return a ? c.json({ ...a, approvals: rows("SELECT * FROM approvals WHERE action_id = ?", a.id) }) : c.json({ error: "not found" }, 404);
  });
  app.post("/actions/:id/decision", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (b?.decision !== "approved" && b?.decision !== "rejected") return c.json({ error: "decision must be approved or rejected" }, 400);
    const who = approverFrom(c, b.channel === "cli" ? "cli" : "ui");
    if (b.channel === "cli" && b.approver) { who.id = String(b.approver); who.name = String(b.approver); }
    const r = await decide(db, svc, c.req.param("id"), b.decision, who);
    return c.json(r, r.ok ? 200 : 409);
  });

  app.get("/status", (c) => c.json({ queue: queueCounts(db), cost_today_usd: costToday(db), daily_cap_usd: config.dailyCostUsd || null, workers: workerStats(db) }));

  // Live changes for the UI. Polls the DB (the single writer is this process) and pushes what moved.
  app.get("/stream", (c) => streamSSE(c, async (stream) => {
    let since = Date.now();
    let actionsSig = "";
    let open = true;
    stream.onAbort(() => { open = false; });
    while (open) {
      const now = Date.now();
      const jobs = rows("SELECT id, project_id, worker, status, tier, updated_at FROM jobs WHERE updated_at > ? ORDER BY updated_at", since);
      const sessions = rows("SELECT harness, session_id, project_id, status, driver, conflict, last_event_at FROM sessions WHERE last_event_at > ? ORDER BY last_event_at", since);
      const sig = JSON.stringify(db.prepare("SELECT COUNT(*) AS n, MAX(created_at) AS m FROM actions WHERE status = 'pending'").get());
      const actionsChanged = sig !== actionsSig && actionsSig !== "";
      actionsSig = sig;
      if (jobs.length || sessions.length || actionsChanged) {
        await stream.writeSSE({ event: "change", data: JSON.stringify({ jobs, sessions, actions: actionsChanged }) });
      } else {
        await stream.writeSSE({ event: "ping", data: "" });
      }
      since = now;
      await stream.sleep(1000);
    }
  }));

  // The PWA. Hash routing keeps its routes clear of the API's.
  app.get("*", async (c) => {
    if (!existsSync(config.uiDir)) return c.json({ error: "not found" }, 404);
    const rel = normalize(c.req.path).replace(/^(\.\.[/\\])+/, "");
    const file = join(config.uiDir, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(config.uiDir)) return c.json({ error: "not found" }, 404);
    const body = await readFile(file).catch(() => undefined);
    if (!body) return c.json({ error: "not found" }, 404);
    return c.body(body, 200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  });

  return app;
}
