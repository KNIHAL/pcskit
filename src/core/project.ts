import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { secureDir } from "./acl";
import { basename, dirname, isAbsolute, join } from "node:path";
import { requireInitializedRoot, withDb } from "./context";
import { inTransaction, openDb, PCS_DIR, pcsDir, type Db } from "./db";
import { PcsError } from "./errors";
import { insertEvent, recentEvents, type ChainReport, type EventRow } from "./events";
import { findGitRoot, getGitState, type GitState } from "./git";
import { verifyIntegrity } from "./integrity";
import { activeSession, type Session } from "./sessions";
import { openTasks, type Task } from "./tasks";
import { readWatcherState, type WatcherState } from "./watcher";

export interface ProjectInfo {
  name: string;
  root: string;
  created_at: string;
}

export interface Status {
  project: ProjectInfo;
  git: Extract<GitState, { isRepo: true }>;
  session: Session | null;
  openTasks: Task[];
  recentEvents: EventRow[];
  integrity: ChainReport;
  watcher: WatcherState;
}

export interface InitResult {
  project: ProjectInfo;
  alreadyInitialized: boolean;
}

function readProject(db: Db): ProjectInfo | undefined {
  return db.prepare("SELECT name, root, created_at FROM project WHERE id = 1").get() as
    | ProjectInfo
    | undefined;
}

/**
 * Where git reads its per-repository ignore rules. In a linked worktree or a submodule `.git` is a FILE, so the
 * path is asked from git itself (`--git-path` resolves the shared info directory); the plain layout is the fallback.
 */
function excludeFile(root: string): string {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) return isAbsolute(out) ? out : join(root, out);
  } catch {
    /* fall through to the usual location */
  }
  return join(root, ".git", "info", "exclude");
}

/** Keep a path out of the user's repo (the repository's info/exclude) without touching any tracked file. */
export function addGitExclude(root: string, line: string): void {
  const file = excludeFile(root);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!current.split(/\r?\n/).includes(line)) {
      appendFileSync(file, `${current.endsWith("\n") || current === "" ? "" : "\n"}${line}\n`);
    }
  } catch {
    // Not writable: the path is simply left untracked.
  }
}

function excludeFromGit(root: string): void {
  addGitExclude(root, `${PCS_DIR}/`);
}

export async function initProject(cwd: string): Promise<InitResult> {
  const root = await findGitRoot(cwd);
  if (!root) throw new PcsError("NOT_GIT_REPO", "Not inside a git repository. Run `git init` first.");

  if (!existsSync(pcsDir(root))) {
    mkdirSync(pcsDir(root), { recursive: true, mode: 0o700 });
    secureDir(pcsDir(root)); // new files inherit owner-only access (Windows ACL; POSIX modes are set by openDb)
  }
  const db = openDb(root);
  try {
    const existing = readProject(db);
    if (existing) return { project: existing, alreadyInitialized: true };

    const project: ProjectInfo = {
      name: basename(root),
      root,
      created_at: new Date().toISOString(),
    };
    inTransaction(db, () => {
      db.prepare("INSERT INTO project (id, name, root, created_at) VALUES (1, ?, ?, ?)").run(
        project.name,
        project.root,
        project.created_at,
      );
      insertEvent(db, {
        type: "project.init",
        provenance: "verified",
        source: "pcs",
        payload: { name: project.name },
      });
    });
    excludeFromGit(root);
    return { project, alreadyInitialized: false };
  } finally {
    db.close();
  }
}

export async function getStatus(cwd: string): Promise<Status> {
  const root = await requireInitializedRoot(cwd);
  const git = await getGitState(root);
  if (!git.isRepo) throw new PcsError("NOT_GIT_REPO", "Not inside a git repository.");

  return withDb(root, (db) => {
    const project = readProject(db);
    if (!project) throw new PcsError("NOT_INITIALIZED", "PCS is not initialized here. Run `pcs init` first.");
    return {
      project,
      git,
      session: activeSession(db),
      openTasks: openTasks(db),
      recentEvents: recentEvents(db, 5),
      integrity: verifyIntegrity(db),
      watcher: readWatcherState(root),
    };
  });
}

export async function verifyProject(cwd: string): Promise<ChainReport> {
  return withDb(cwd, (db) => verifyIntegrity(db));
}

