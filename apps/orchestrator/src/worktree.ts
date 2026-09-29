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

/** Remove the worktree, and the branch too when it has no commits beyond `base`. */
export async function removeWorktree(repo: string, wt: Worktree, base: string): Promise<void> {
  await git(repo, "worktree", "remove", "--force", wt.path).catch(() => rm(wt.path, { recursive: true, force: true }));
  await git(repo, "worktree", "prune").catch(() => {});
  const { stdout } = await git(repo, "rev-list", "--count", `${base}..${wt.branch}`).catch(() => ({ stdout: "0" }));
  if (stdout.trim() === "0") await git(repo, "branch", "-D", wt.branch).catch(() => {});
}
