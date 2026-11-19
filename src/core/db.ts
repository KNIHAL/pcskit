import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PcsError } from "./errors";
import { MIGRATIONS } from "./migrations";

// Loaded via require: esbuild strips the "node:" prefix from "node:sqlite" in bundles.
// Node 22 prints "ExperimentalWarning: SQLite is an experimental feature" to stderr on load. That is noise for a CLI
// whose hooks and MCP server run unattended, so exactly that one warning is dropped; all others pass through.
const { DatabaseSync } = (() => {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(text)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
})();

export const PCS_DIR = ".pcs";
export const DB_FILE = "pcs.db";

export type Db = DatabaseSyncType;

export function pcsDir(root: string): string {
  return join(root, PCS_DIR);
}

export function dbPath(root: string): string {
  return join(pcsDir(root), DB_FILE);
}

export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

function userVersion(db: Db): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function migrate(db: Db): void {
  const target = MIGRATIONS.length;
  const check = (v: number) => {
    if (v > target) {
      throw new PcsError(
        "SCHEMA_TOO_NEW",
        `This .pcs database was created by a newer PCS (schema v${v}, this build supports v${target}). Upgrade PCS.`,
      );
    }
  };
  const before = userVersion(db);
  check(before);
  if (before === target) return;

  inTransaction(db, () => {
    const current = userVersion(db); // re-read under the write lock (concurrent processes)
    check(current);
    for (let v = current; v < target; v++) db.exec(MIGRATIONS[v]!);
    if (current < target) db.exec(`PRAGMA user_version = ${target}`);
  });
}

export function openDb(root: string): Db {
  mkdirSync(pcsDir(root), { recursive: true, mode: 0o700 });
  const file = dbPath(root);
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  try {
    chmodSync(file, 0o600); // owner-only; no-op semantics on Windows
  } catch {
    /* best effort */
  }
  return db;
}
