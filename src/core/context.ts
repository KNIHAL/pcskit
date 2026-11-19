import { existsSync } from "node:fs";
import { loadPolicy } from "./config";
import { dbPath, openDb, type Db } from "./db";
import { PcsError } from "./errors";
import { findGitRoot } from "./git";

/** Resolve the git root of `cwd` and require that PCS was initialized there. */
export async function requireInitializedRoot(cwd: string): Promise<string> {
  const root = await findGitRoot(cwd);
  if (!root) throw new PcsError("NOT_GIT_REPO", "Not inside a git repository.");
  if (!existsSync(dbPath(root))) {
    throw new PcsError("NOT_INITIALIZED", "PCS is not initialized here. Run `pcs init` first.");
  }
  loadPolicy(root);
  return root;
}

/** Open the project database for the duration of `fn`, always closing it. */
export async function withDb<T>(cwd: string, fn: (db: Db, root: string) => T): Promise<T> {
  const root = await requireInitializedRoot(cwd);
  const db = openDb(root);
  try {
    return fn(db, root);
  } finally {
    db.close();
  }
}
