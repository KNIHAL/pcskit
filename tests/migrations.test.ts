import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEvent,
  computeHash,
  dbPath,
  GENESIS_HASH,
  MIGRATIONS,
  openDb,
  pcsDir,
  verifyChain,
} from "../src/core";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pcs-mig-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("upgrading an existing database", () => {
  it("migrates a v2 database to the latest schema without breaking its event chain", () => {
    // Build a database exactly as PCS v2 left it, with a real chain written the v2 way.
    mkdirSync(pcsDir(dir), { recursive: true });
    const old = new DatabaseSync(dbPath(dir));
    old.exec(MIGRATIONS[0]!);
    old.exec(MIGRATIONS[1]!);
    old.exec("PRAGMA user_version = 2");
    let prev = GENESIS_HASH;
    for (const type of ["project.init", "task.created"]) {
      const body = {
        ts: new Date().toISOString(),
        type,
        provenance: "verified" as const,
        source: "pcs",
        payload: "{}",
      };
      const hash = computeHash(prev, body);
      old
        .prepare(
          "INSERT INTO events (ts, type, provenance, source, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(body.ts, body.type, body.provenance, body.source, body.payload, prev, hash);
      prev = hash;
    }
    old.close();

    const db = openDb(dir);
    try {
      const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      expect(version).toBe(MIGRATIONS.length);
      expect(verifyChain(db)).toEqual({ ok: true, count: 2 });

      // New events (with and without a session) continue the same chain.
      appendEvent(db, { type: "session.started", provenance: "reported", source: "claude", sessionId: 1 });
      appendEvent(db, { type: "other", provenance: "verified", source: "pcs" });
      expect(verifyChain(db)).toEqual({ ok: true, count: 4 });
    } finally {
      db.close();
    }
  });
});
