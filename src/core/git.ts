import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ChangedFile {
  path: string;
  /** Index (staged) status char from `git status --porcelain`. */
  index: string;
  /** Working-tree status char. */
  worktree: string;
  untracked: boolean;
}

export interface CommitInfo {
  hash: string;
  subject: string;
  date: string;
}

export type GitState =
  | { isRepo: false }
  | {
      isRepo: true;
      root: string;
      branch: string;
      head: CommitInfo | null;
      changed: ChangedFile[];
    };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

export async function findGitRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
}

export function parsePorcelainZ(out: string): ChangedFile[] {
  const parts = out.split("\0").filter((p) => p.length > 0);
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    const index = entry[0] ?? " ";
    const worktree = entry[1] ?? " ";
    const path = entry.slice(3);
    // Renames/copies are followed by an extra entry holding the original path.
    if (index === "R" || index === "C") i++;
    files.push({ path, index, worktree, untracked: index === "?" && worktree === "?" });
  }
  return files;
}

export async function getGitState(cwd: string): Promise<GitState> {
  const root = await findGitRoot(cwd);
  if (!root) return { isRepo: false };

  let head: CommitInfo | null = null;
  try {
    const raw = (await git(root, ["log", "-1", "--format=%H%x1f%s%x1f%cI"])).trim();
    const [hash = "", subject = "", date = ""] = raw.split("\x1f");
    if (hash) head = { hash, subject, date };
  } catch {
    head = null; // repo with no commits yet
  }

  let branch = (await git(root, ["branch", "--show-current"])).trim();
  if (!branch) branch = head ? `(detached at ${head.hash.slice(0, 7)})` : "(no commits)";

  const changed = parsePorcelainZ(await git(root, ["status", "--porcelain=v1", "-z"]));
  return { isRepo: true, root, branch, head, changed };
}
