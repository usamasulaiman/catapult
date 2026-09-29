import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "@catapult/core";
import { createApi } from "./api.ts";
import { loadConfig } from "./config.ts";

let db: Db, app: ReturnType<typeof createApi>;
const req = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

beforeEach(async () => {
  db = openDb(":memory:");
  app = createApi(db, loadConfig({ CATAPULT_ROOT: "/srv/catapult" }));
  await req("POST", "/projects", { id: "web", local_path: "/repos/web" });
});

describe("api", () => {
  it("creates jobs, validates input, and cancels", async () => {
    expect((await req("POST", "/jobs", { project_id: "nope", worker: "noop" })).status).toBe(404);
    expect((await req("POST", "/jobs", { project_id: "web", worker: "noop", tier: "interactive" })).status).toBe(400);
    const job = await (await req("POST", "/jobs", { project_id: "web", worker: "noop", input: { prompt: "x" } })).json();
    expect(job).toMatchObject({ status: "queued", tier: "trusted" });
    expect((await (await req("GET", "/jobs?status=queued")).json())).toHaveLength(1);
    expect((await req("POST", `/jobs/${job.id}/cancel`)).status).toBe(200);
    expect((await req("POST", `/jobs/${job.id}/cancel`)).status).toBe(409);
  });

  it("indexes sessions from /ingest and supports takeover", async () => {
    await req("POST", "/ingest", { harness: "claude", event: "SessionStart", session_id: "abc", cwd: "/repos/web" });
    await req("POST", "/ingest", { harness: "claude", event: "Stop", session_id: "abc", cwd: "/repos/web" });
    const list = await (await req("GET", "/sessions?project=web")).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "idle", driver: "terminal" });
    expect((await req("POST", "/sessions/claude/abc/release")).status).toBe(200);
    expect(await (await req("POST", "/sessions/claude/abc/takeover")).json()).toEqual({ ok: true, command: "claude --resume abc" });
  });

  it("ingest tolerates garbage", async () => {
    expect((await req("POST", "/ingest", { nope: 1 })).status).toBe(200);
    expect((await app.request("/ingest", { method: "POST", body: "not json" })).status).toBe(200);
  });

  it("manages schedules per project", async () => {
    const { id } = await (await req("POST", "/projects/web/schedules", { worker: "groomer", cron: "0 8 * * *" })).json();
    await req("PATCH", `/schedules/${id}`, { enabled: false });
    const list = await (await req("GET", "/projects/web/schedules")).json();
    expect(list[0]).toMatchObject({ worker: "groomer", enabled: 0 });
    expect((await req("PATCH", "/schedules/missing", { enabled: true })).status).toBe(404);
  });
});
