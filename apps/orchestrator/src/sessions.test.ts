import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "@catapult/core";
import { ingestEvent, projectForCwd, pruneEvents, release, takeover } from "./sessions.ts";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  db.prepare("INSERT INTO projects (id, local_path, created_at) VALUES ('web', '/repos/web', 0)").run();
  db.prepare("INSERT INTO projects (id, local_path, created_at) VALUES ('web-admin', '/repos/web/admin', 0)").run();
});
const sess = (id: string) => db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(id) as any;

describe("projectForCwd", () => {
  it("prefers the most specific clone and understands worktrees", () => {
    expect(projectForCwd(db, "/repos/web/src")).toBe("web");
    expect(projectForCwd(db, "/repos/web/admin/x")).toBe("web-admin");
    expect(projectForCwd(db, "/srv/w/web/job1", "/srv/w")).toBe("web");
    expect(projectForCwd(db, "/elsewhere")).toBeNull();
  });
});

describe("ingestEvent", () => {
  it("tracks an interactive session lifecycle", () => {
    const base = { harness: "claude" as const, session_id: "s1", cwd: "/repos/web", transcript_path: "/t.jsonl" };
    ingestEvent(db, { ...base, event: "SessionStart" });
    expect(sess("s1")).toMatchObject({ status: "idle", origin: "interactive", driver: "terminal", project_id: "web" });
    ingestEvent(db, { ...base, event: "UserPromptSubmit" });
    expect(sess("s1").status).toBe("working");
    ingestEvent(db, { ...base, event: "Notification" });
    expect(sess("s1").status).toBe("needs_input");
    ingestEvent(db, { ...base, event: "SessionEnd" });
    expect(sess("s1").status).toBe("ended");
    expect(db.prepare("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 4 });
  });
  it("marks sessions in the worktrees dir as job sessions", () => {
    ingestEvent(db, { harness: "pi", session_id: "s2", cwd: "/srv/w/web/j1", event: "SessionStart" }, { worktreesDir: "/srv/w" });
    expect(sess("s2")).toMatchObject({ origin: "job", driver: "runner", project_id: "web" });
  });
  it("records but ignores unknown events and events without a session", () => {
    ingestEvent(db, { harness: "claude", event: "Weird", session_id: "s3" });
    ingestEvent(db, { harness: "claude", event: "Stop" });
    expect(sess("s3")).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 2 });
  });
  it("prunes old events", () => {
    ingestEvent(db, { harness: "claude", event: "Stop" }, { now: 1000 });
    expect(pruneEvents(db, 500, 2000)).toBe(1);
  });
});

describe("takeover / release", () => {
  it("refuses while the runner is working, allows when idle, and hands back", () => {
    db.prepare("INSERT INTO sessions (harness, session_id, origin, status, driver, last_event_at, transcript_path) VALUES ('claude','a','job','working','runner',0,NULL)").run();
    expect(takeover(db, "claude", "a")).toMatchObject({ ok: false });
    db.prepare("UPDATE sessions SET status='idle' WHERE session_id='a'").run();
    expect(takeover(db, "claude", "a")).toEqual({ ok: true, command: "claude --resume a" });
    expect(sess("a").driver).toBe("terminal");
    expect(release(db, "claude", "a")).toBe(true);
    expect(sess("a").driver).toBe("none");
  });
  it("uses the session file for pi", () => {
    db.prepare("INSERT INTO sessions (harness, session_id, origin, status, driver, last_event_at, transcript_path) VALUES ('pi','p','job','idle','none',0,'/x/p.jsonl')").run();
    expect(takeover(db, "pi", "p")).toEqual({ ok: true, command: "pi --session /x/p.jsonl" });
  });
});
