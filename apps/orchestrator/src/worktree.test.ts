import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, removeWorktree } from "./worktree.ts";

let dir: string, repo: string, root: string;
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cat-wt-"));
  repo = join(dir, "repo"); root = join(dir, "wt");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a");
  git(repo, "add", "."); git(repo, "commit", "-qm", "init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("worktree", () => {
  it("keeps a worktree with uncommitted changes", async () => {
    const wt = await createWorktree({ repo, root, project: "p", jobId: "j3", branch: "catapult/noop/j3", base: "main" });
    writeFileSync(join(wt.path, "hello.txt"), "hi");
    expect(await removeWorktree(repo, wt, "main")).toBe(false);
    expect(existsSync(join(wt.path, "hello.txt"))).toBe(true);
  });
  it("creates an isolated worktree and cleans it up with its unused branch", async () => {
    const wt = await createWorktree({ repo, root, project: "p", jobId: "j1", branch: "catapult/noop/j1", base: "main" });
    expect(existsSync(join(wt.path, "a.txt"))).toBe(true);
    expect(await removeWorktree(repo, wt, "main")).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
    expect(git(repo, "branch", "--list", "catapult/*").trim()).toBe("");
  });
  it("keeps the branch when the job committed", async () => {
    const wt = await createWorktree({ repo, root, project: "p", jobId: "j2", branch: "catapult/noop/j2", base: "main" });
    writeFileSync(join(wt.path, "b.txt"), "b");
    git(wt.path, "add", "."); git(wt.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "work");
    await removeWorktree(repo, wt, "main");
    expect(git(repo, "branch", "--list", "catapult/*")).toContain("catapult/noop/j2");
  });
});
