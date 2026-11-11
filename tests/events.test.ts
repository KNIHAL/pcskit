import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEvent,
  canonicalJson,
  GENESIS_HASH,  MIGRATIONS,
  openDb,
  PcsError,
  verifyChain,
  type Db,
} from "../src/core";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pcs-ev-"));
  db = openDb(dir);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

const ev = (type: string, payload: unknown = {}) =>
  appendEvent(db, { type, provenance: "verified", source: "test", payload });

describe("hash chain", () => {
  it("links events from genesis and verifies", () => {
    const a = ev("a");
    const b = ev("b");
    expect(a.prev_hash).toBe(GENESIS_HASH);
    expect(b.prev_hash).toBe(a.hash);
    expect(verifyChain(db)).toEqual({ ok: true, count: 2 });
  });

  it("an empty log verifies", () => {
    expect(verifyChain(db)).toEqual({ ok: true, count: 0 });
  });

  it("is independent of payload key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: 1 }, b: 1 }));
  });

  it("append-only triggers block update and delete", () => {
    ev("a");
    expect(() => db.exec("UPDATE events SET type = 'x'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM events")).toThrow(/append-only/);
  });

  it("detects a modified event even if the triggers are dropped", () => {
    ev("a");
    const b = ev("b");
    ev("c");
    db.exec("DROP TRIGGER events_no_update");
    db.prepare("UPDATE events SET payload = ? WHERE id = ?").run('{"forged":true}', b.id);
    expect(verifyChain(db)).toMatchObject({ ok: false, brokenAt: b.id, reason: expect.stringMatching(/modified/) });
  });

  it("detects a removed event even if the triggers are dropped", () => {
    ev("a");
    const b = ev("b");
    const c = ev("c");
    db.exec("DROP TRIGGER events_no_delete");
    db.prepare("DELETE FROM events WHERE id = ?").run(b.id);
    expect(verifyChain(db)).toMatchObject({ ok: false, brokenAt: c.id, reason: expect.stringMatching(/removed/) });
  });

  it("rejects an unknown provenance value", () => {
    expect(() =>
      appendEvent(db, { type: "x", provenance: "trust-me" as never, source: "test" }),
    ).toThrow();
    expect(verifyChain(db).count).toBe(0);
  });
});

describe("redaction on write", () => {
  it("never persists credential-looking values", () => {
    const secret = "ghp_" + "a1B2".repeat(9);
    const e = ev("note", { text: `deploy with token=${secret}`, nested: { key: "AKIA" + "ABCDEFGHIJKLMNOP" } });
    expect(e.payload).not.toContain(secret);
    expect(e.payload).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(e.payload).toContain("[REDACTED");
    expect(verifyChain(db).ok).toBe(true);
  });
});

describe("migrations", () => {
  it("sets the schema version and reopens cleanly", () => {
    const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(v).toBe(MIGRATIONS.length);
    ev("a");
    db.close();
    db = openDb(dir);
    expect(verifyChain(db)).toEqual({ ok: true, count: 1 });
  });

  it("refuses a database from a newer PCS", () => {
    db.exec("PRAGMA user_version = 99");
    db.close();
    let caught: unknown;
    try {
      db = openDb(dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PcsError);
    expect((caught as PcsError).code).toBe("SCHEMA_TOO_NEW");
  });
});

