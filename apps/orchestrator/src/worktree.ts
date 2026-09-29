import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd });

export interface Worktree {
  path: string;
  branch: string;
}

/** Create a fresh worktree on a new branch off `base`. The main clone is never modified. */
export async function createWorktree(o: {
  repo: string; root: string; project: string; jobId: string; branch: string; base: string;
}): Promise<Worktree> {
  const path = join(o.root, o.project, o.jobId);
  await mkdir(dirname(path), { recursive: true });
  await git(o.repo, "worktree", "add", "-b", o.branch, path, o.base);
  return { path, branch: o.branch };
}

/**
 * Remove the worktree only when it holds nothing worth keeping: no uncommitted changes and no
 * commits beyond `base`. Returns true if removed. A kept worktree is the job's output.
 */
export async function removeWorktree(repo: string, wt: Worktree, base: string): Promise<boolean> {
  const { stdout: dirty } = await git(wt.path, "status", "--porcelain").catch(() => ({ stdout: "?" }));
  const { stdout: ahead } = await git(repo, "rev-list", "--count", `${base}..${wt.branch}`).catch(() => ({ stdout: "?" }));
  if (dirty.trim() !== "" || ahead.trim() !== "0") return false;
  await git(repo, "worktree", "remove", "--force", wt.path).catch(() => rm(wt.path, { recursive: true, force: true }));
  await git(repo, "worktree", "prune").catch(() => {});
  await git(repo, "branch", "-D", wt.branch).catch(() => {});
  return true;
}
