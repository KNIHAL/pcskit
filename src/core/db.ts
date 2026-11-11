import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PcsError } from "./errors";

// Loaded via require: esbuild strips the "node:" prefix from "node:sqlite" in bundles.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export const PCS_DIR = ".pcs";
export const DB_FILE = "pcs.db";

export type Db = DatabaseSyncType;

/**
 * Append-only list of schema migrations. Never edit an entry that has shipped;
 * add a new one. PRAGMA user_version records how many have been applied.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE project (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    root TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    provenance TEXT NOT NULL CHECK (provenance IN ('verified', 'reported', 'inferred')),
    source TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE
  );
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  `,
];

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
