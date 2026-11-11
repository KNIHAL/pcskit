import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { dbPath, inTransaction, openDb, PCS_DIR, type Db } from "./db";
import { PcsError } from "./errors";
import { insertEvent, recentEvents, verifyChain, type ChainReport, type EventRow } from "./events";
import { findGitRoot, getGitState, type GitState } from "./git";

export interface ProjectInfo {
  name: string;
  root: string;
  created_at: string;
}

export interface Status {
  project: ProjectInfo;
  git: Extract<GitState, { isRepo: true }>;
  recentEvents: EventRow[];
  integrity: ChainReport;
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

/** Keep .pcs/ out of the user's repo without touching any tracked file. */
function excludeFromGit(root: string): void {
  const file = join(root, ".git", "info", "exclude");
  try {
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!current.split(/\r?\n/).includes(`${PCS_DIR}/`)) {
      appendFileSync(file, `${current.endsWith("\n") || current === "" ? "" : "\n"}${PCS_DIR}/\n`);
    }
  } catch {
    // .git may be a file (worktree/submodule); skip silently, .pcs/ is just untracked then.
  }
}

async function requireInitializedRoot(cwd: string): Promise<string> {
  const root = await findGitRoot(cwd);
  if (!root) throw new PcsError("NOT_GIT_REPO", "Not inside a git repository.");
  if (!existsSync(dbPath(root))) {
    throw new PcsError("NOT_INITIALIZED", "PCS is not initialized here. Run `pcs init` first.");
  }
  return root;
}

export async function initProject(cwd: string): Promise<InitResult> {
  const root = await findGitRoot(cwd);
  if (!root) throw new PcsError("NOT_GIT_REPO", "Not inside a git repository. Run `git init` first.");

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

  const db = openDb(root);
  try {
    const project = readProject(db);
    if (!project) throw new PcsError("NOT_INITIALIZED", "PCS is not initialized here. Run `pcs init` first.");
    return { project, git, recentEvents: recentEvents(db, 5), integrity: verifyChain(db) };
  } finally {
    db.close();
  }
}

export async function verifyProject(cwd: string): Promise<ChainReport> {
  const root = await requireInitializedRoot(cwd);
  const db = openDb(root);
  try {
    return verifyChain(db);
  } finally {
    db.close();
  }
}
