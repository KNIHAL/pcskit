import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// Loaded via require: esbuild strips the "node:" prefix from "node:sqlite" in bundles.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export const PCS_DIR = ".pcs";
export const DB_FILE = "pcs.db";

export type Db = DatabaseSyncType;

export function pcsDir(root: string): string {
  return join(root, PCS_DIR);
}

export function dbPath(root: string): string {
  return join(pcsDir(root), DB_FILE);
}

export function openDb(root: string): Db {
  mkdirSync(pcsDir(root), { recursive: true });
  const db = new DatabaseSync(dbPath(root));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS project (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL,
      root TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}'
    );
  `);
  return db;
}

export function addEvent(db: Db, type: string, payload: unknown = {}): void {
  db.prepare("INSERT INTO events (ts, type, payload) VALUES (?, ?, ?)").run(
    new Date().toISOString(),
    type,
    JSON.stringify(payload),
  );
}
