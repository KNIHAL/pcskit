import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PcsError } from "./errors";
import { isSensitivePath } from "./redact";

const run = promisify(execFile);

export interface ChangedFile {
  path: string;
  /** Index (staged) status char from `git status --porcelain`. */
  index: string;
  /** Working-tree status char. */
  worktree: string;
  untracked: boolean;
  /** Commonly holds secrets (.env, keys...). Content must never be read into a handoff. */
  sensitive: boolean;
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

/**
 * PCS is a read-only observer of repositories it does not trust.
 * - core.fsmonitor=false: a repo's config can name a command that git runs on `status`.
 * - --no-optional-locks: never write to the repo (index refresh) just by looking.
 * - no prompts, no pager, stable C locale for parsing.
 */
const HARDENING_ARGS = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const GIT_TIMEOUT_MS = 30_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", [...HARDENING_ARGS, ...args], {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      LC_ALL: "C",
    },
  });
  return stdout;
}

export async function findGitRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch (err) {
    const e = err as { code?: string; stderr?: string };
    if (e.code === "ENOENT") throw new PcsError("GIT_FAILURE", "git executable not found in PATH.");
    if (/dubious ownership/i.test(e.stderr ?? "")) {
      throw new PcsError(
        "GIT_FAILURE",
        "git refuses this repository (unsafe ownership). PCS will not bypass this; review it and fix ownership or safe.directory yourself.",
      );
    }
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
    files.push({
      path,
      index,
      worktree,
      untracked: index === "?" && worktree === "?",
      sensitive: isSensitivePath(path),
    });
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
