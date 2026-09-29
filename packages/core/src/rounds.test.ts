import { expect, it } from "vitest";
import { openDb } from "./db.ts";
import { getRounds, recordRound } from "./rounds.ts";

it("counts rounds per subject", () => {
  const db = openDb(":memory:");
  expect(getRounds(db, "p", "w", "#1")).toEqual({ rounds: 0, last_diff_sha: null });
  recordRound(db, "p", "w", "#1", "aaa");
  expect(recordRound(db, "p", "w", "#1", "bbb")).toEqual({ rounds: 2, last_diff_sha: "bbb" });
  expect(getRounds(db, "p", "w", "#2").rounds).toBe(0);
});
