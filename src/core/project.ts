import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { addEvent, dbPath, openDb, PCS_DIR } from "./db";
import { findGitRoot, getGitState, type GitState } from "./git";

export interface ProjectInfo {
  name: string;
  root: string;
  created_at: string;
}

export interface EventRow {
  id: number;
  ts: string;
  type: string;
  payload: string;
}

export interface Status {
  project: ProjectInfo;
  git: Extract<GitState, { isRepo: true }>;
  recentEvents: EventRow[];
}

export interface InitResult {
  project: ProjectInfo;
  alreadyInitialized: boolean;
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

export async function initProject(cwd: string): Promise<InitResult> {
  const root = await findGitRoot(cwd);
  if (!root) throw new Error("Not inside a git repository. Run `git init` first.");

  const db = openDb(root);
  try {
    const existing = db.prepare("SELECT name, root, created_at FROM project WHERE id = 1").get() as
      | ProjectInfo
      | undefined;
    if (existing) return { project: existing, alreadyInitialized: true };

    const project: ProjectInfo = {
      name: basename(root),
      root,
      created_at: new Date().toISOString(),
    };
    db.prepare("INSERT INTO project (id, name, root, created_at) VALUES (1, ?, ?, ?)").run(
      project.name,
      project.root,
      project.created_at,
    );
    addEvent(db, "project.init", { name: project.name });
    excludeFromGit(root);
    return { project, alreadyInitialized: false };
  } finally {
    db.close();
  }
}

export async function getStatus(cwd: string): Promise<Status> {
  const git = await getGitState(cwd);
  if (!git.isRepo) throw new Error("Not inside a git repository.");
  if (!existsSync(dbPath(git.root))) {
    throw new Error("PCS is not initialized here. Run `pcs init` first.");
  }

  const db = openDb(git.root);
  try {
    const project = db.prepare("SELECT name, root, created_at FROM project WHERE id = 1").get() as
      | ProjectInfo
      | undefined;
    if (!project) throw new Error("PCS is not initialized here. Run `pcs init` first.");
    const recentEvents = db
      .prepare("SELECT id, ts, type, payload FROM events ORDER BY id DESC LIMIT 5")
      .all() as unknown as EventRow[];
    return { project, git, recentEvents };
  } finally {
    db.close();
  }
}
