import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "@catapult/core";
import { cronMatches, fireDueSchedules } from "./cron.ts";

const at = (s: string) => new Date(s); // local time
describe("cronMatches", () => {
  it("handles wildcards, lists, ranges and steps", () => {
    expect(cronMatches("* * * * *", at("2026-03-04T05:06:00"))).toBe(true);
    expect(cronMatches("*/15 * * * *", at("2026-03-04T05:30:00"))).toBe(true);
    expect(cronMatches("*/15 * * * *", at("2026-03-04T05:31:00"))).toBe(false);
    expect(cronMatches("0 9-17 * * 1-5", at("2026-03-04T10:00:00"))).toBe(true); // Wed
    expect(cronMatches("0 9-17 * * 1-5", at("2026-03-08T10:00:00"))).toBe(false); // Sun
    expect(cronMatches("0 0 1,15 * *", at("2026-03-15T00:00:00"))).toBe(true);
    expect(cronMatches("0 0 * * 7", at("2026-03-08T00:00:00"))).toBe(true); // 7 = Sunday
  });
  it("rejects malformed expressions", () => {
    expect(() => cronMatches("* * *", new Date())).toThrow();
    expect(() => cronMatches("61 * * * *", new Date())).toThrow();
  });
});

describe("fireDueSchedules", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
    db.prepare("INSERT INTO projects (id, local_path, created_at) VALUES ('p','/x',0)").run();
    db.prepare("INSERT INTO schedules (id, project_id, worker, cron, enabled, created_at, updated_at) VALUES ('s1','p','groomer','0 8 * * *',1,0,0)").run();
    db.prepare("INSERT INTO schedules (id, project_id, worker, cron, enabled, created_at, updated_at) VALUES ('s2','p','groomer','0 8 * * *',0,0,0)").run();
    db.prepare("INSERT INTO schedules (id, project_id, worker, cron, enabled, created_at, updated_at) VALUES ('s3','p','x','garbage',1,0,0)").run();
  });
  it("fires enabled due schedules once per minute", () => {
    expect(fireDueSchedules(db, at("2026-03-04T08:00:10"))).toHaveLength(1);
    expect(fireDueSchedules(db, at("2026-03-04T08:00:50"))).toHaveLength(0);
    expect(fireDueSchedules(db, at("2026-03-04T08:01:00"))).toHaveLength(0);
    expect(fireDueSchedules(db, at("2026-03-05T08:00:00"))).toHaveLength(1);
  });
});
