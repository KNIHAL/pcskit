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

export interface CommittedFile {
  /** git name-status letter: A, M, D, T... */
  status: string;
  path: string;
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
const MAX_COMMITS = 200;
const MAX_COMMITTED_FILES = 2000;
const HASH_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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

  // --untracked-files=all lists files inside new directories individually, so content changes there are visible.
  const changed = parsePorcelainZ(await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  return { isRepo: true, root, branch, head, changed };
}

/** Directory of `cwd` relative to the repository root, with "/" separators ("" at the root). */
export async function relativeToRoot(cwd: string): Promise<string> {
  const out = (await git(cwd, ["rev-parse", "--show-prefix"])).trim();
  return out.replace(/\/+$/, "");
}

function assertHash(h: string): void {
  if (!HASH_RE.test(h)) throw new PcsError("INVALID_INPUT", "Invalid commit hash.");
}

/** Commits reachable from `to` but not from `from` (all of `to`'s history, capped, when `from` is null). */
export async function commitsBetween(root: string, from: string | null, to: string): Promise<CommitInfo[]> {
  assertHash(to);
  if (from !== null) assertHash(from);
  const range = from ? `${from}..${to}` : to;
  const raw = await git(root, ["log", `--max-count=${MAX_COMMITS}`, "--format=%H%x1f%s%x1f%cI", range, "--"]);
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((line) => {
      const [hash = "", subject = "", date = ""] = line.split("\x1f");
      return { hash, subject, date };
    });
}

/** Files that differ between two commits (what the commits in between changed). */
export async function changedFilesBetween(root: string, from: string, to: string): Promise<CommittedFile[]> {
  assertHash(from);
  assertHash(to);
  const raw = await git(root, [
    "diff",
    "--name-status",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    from,
    to,
    "--",
  ]);
  const tokens = raw.split("\0").filter((t) => t.length > 0);
  const files: CommittedFile[] = [];
  for (let i = 0; i + 1 < tokens.length && files.length < MAX_COMMITTED_FILES; i += 2) {
    files.push({ status: tokens[i]!, path: tokens[i + 1]! });
  }
  return files;
}
