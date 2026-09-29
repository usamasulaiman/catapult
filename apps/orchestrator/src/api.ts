import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { cancel, enqueue, getJob, type Db, type Tier } from "@catapult/core";
import type { Config } from "./config.ts";
import type { Dispatcher } from "./dispatcher.ts";
import { ingestEvent, release, takeover, type IngestEvent } from "./sessions.ts";

const TIERS = new Set<Tier>(["trusted", "untrusted", "unsandboxed"]);

export function createApi(db: Db, config: Config, dispatcher?: Pick<Dispatcher, "cancel">) {
  const app = new Hono();
  const rows = (sql: string, ...args: any[]) => db.prepare(sql).all(...args);

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
    const { job } = enqueue(db, { project_id: b.project_id, worker: b.worker, input: b.input, tier, budget: b.budget, idempotency_key: b.idempotency_key });
    return c.json(job, 201);
  });
  app.get("/jobs/:id", (c) => {
    const j = getJob(db, c.req.param("id"));
    return j ? c.json(j) : c.json({ error: "not found" }, 404);
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
  app.post("/sessions/:harness/:id/takeover", (c) => {
    const r = takeover(db, c.req.param("harness"), c.req.param("id"));
    return c.json(r, r.ok ? 200 : 409);
  });
  app.post("/sessions/:harness/:id/release", (c) =>
    release(db, c.req.param("harness"), c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not taken over" }, 409));

  return app;
}
