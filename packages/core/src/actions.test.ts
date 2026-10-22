import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db.ts";
import { createAction, decideAction, expireActions, getAction, listActions, markExecuted } from "./actions.ts";

let db: Db;
beforeEach(() => { db = openDb(":memory:"); });
const me = { channel: "telegram" as const, id: "42", name: "me", messageId: "m1" };

describe("actions", () => {
  it("first decision wins and is recorded with who and when", () => {
    const a = createAction(db, { kind: "open_draft_pr", payload: { x: 1 }, summary: "fix it" }, 1000);
    const r = decideAction(db, a.id, "approved", me, { nonce: a.nonce, now: 2000 });
    expect(r).toMatchObject({ ok: true, action: { status: "approved" } });
    const again = decideAction(db, a.id, "rejected", { channel: "ui", id: "x" }, { now: 3000 });
    expect(again).toEqual({ ok: false, reason: "already_decided", prior: { decision: "approved", approver_name: "me", approver_id: "42", decided_at: 2000 } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 1 });
  });

  it("rejects a wrong nonce without deciding", () => {
    const a = createAction(db, { kind: "k", payload: {} });
    expect(decideAction(db, a.id, "approved", me, { nonce: "nope" })).toEqual({ ok: false, reason: "bad_nonce" });
    expect(getAction(db, a.id)!.status).toBe("pending");
  });

  it("expires unanswered actions and refuses late decisions", () => {
    const a = createAction(db, { kind: "k", payload: {}, ttlMs: 10 }, 1000);
    expect(expireActions(db, 1005)).toHaveLength(0);
    expect(expireActions(db, 1010).map((x) => x.id)).toEqual([a.id]);
    expect(decideAction(db, a.id, "approved", me, { now: 1011 })).toMatchObject({ ok: false, reason: "expired" });
  });

  it("a decision past the deadline expires the action even before the sweep", () => {
    const a = createAction(db, { kind: "k", payload: {}, ttlMs: 10 }, 1000);
    expect(decideAction(db, a.id, "approved", me, { now: 2000 })).toEqual({ ok: false, reason: "expired" });
    expect(getAction(db, a.id)!.status).toBe("expired");
  });

  it("marks approved actions executed with a result", () => {
    const a = createAction(db, { kind: "k", payload: {} });
    expect(markExecuted(db, a.id, { job: "j" })).toBe(false);
    decideAction(db, a.id, "approved", me);
    expect(markExecuted(db, a.id, { job: "j" })).toBe(true);
    expect(listActions(db, "executed")[0]).toMatchObject({ id: a.id, result: { job: "j" } });
  });
});
