import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addNote,
  anchorKeyPath,
  createAnchor,
  initProject,
  insertEvent,
  openDb,
  parseAnchor,
  PcsError,
  verifyAnchor,
  withDb,
} from "../src/core";

let dir: string;
let home: string;
let prevHome: string | undefined;
const extra: string[] = [];

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

beforeEach(async () => {
  prevHome = process.env.PCS_HOME;
  home = mkdtempSync(join(tmpdir(), "pcs-anchorhome-"));
  process.env.PCS_HOME = home;
  dir = mkdtempSync(join(tmpdir(), "pcs-anchor-"));
  extra.push(home, dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.dev");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  await initProject(dir);
  await addNote(dir, "next", "one");
  await addNote(dir, "next", "two");
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.PCS_HOME;
  else process.env.PCS_HOME = prevHome;
  for (const d of extra.splice(0)) rmSync(d, { recursive: true, force: true });
});

function save(a: unknown): string {
  const f = join(home, `a-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(a));
  return f;
}

describe("signed anchor", () => {
  it("creates an anchor and verifies against an untouched log", async () => {
    const a = await createAnchor(dir);
    expect(a.count).toBeGreaterThan(1);
    const r = await verifyAnchor(dir, save(a));
    expect(r.integrity.ok).toBe(true);
    expect(r.anchor.ok).toBe(true);
  });

  it("still passes after the log legitimately grows", async () => {
    const a = await createAnchor(dir);
    await addNote(dir, "next", "three");
    const r = await verifyAnchor(dir, save(a));
    expect(r.anchor.ok).toBe(true);
  });

  it("reuses one key across anchors and writes it into PCS_HOME", async () => {
    const a1 = await createAnchor(dir);
    const a2 = await createAnchor(dir);
    expect(a1.key_id).toBe(a2.key_id);
    expect(anchorKeyPath().startsWith(home)).toBe(true);
    expect(readFileSync(anchorKeyPath(), "utf8")).toContain("PRIVATE KEY");
  });

  it("detects truncation of the newest events (chain alone still passes)", async () => {
    const a = await createAnchor(dir);
    const db = openDb(dir);
    db.exec("DROP TRIGGER events_no_delete");
    db.prepare("DELETE FROM events WHERE id = ?").run(a.last_id);
    db.close();
    const r = await verifyAnchor(dir, save(a));
    expect(r.integrity.ok).toBe(true);
    expect(r.anchor.ok).toBe(false);
    expect(r.anchor.reason).toMatch(/truncated|missing/);
  });

  it("detects truncation followed by new valid events", async () => {
    const a = await createAnchor(dir);
    const db = openDb(dir);
    db.exec("DROP TRIGGER events_no_delete");
    db.prepare("DELETE FROM events WHERE id = ?").run(a.last_id);
    insertEvent(db, { type: "note.added", provenance: "reported", source: "evil", payload: { text: "forged" } });
    db.close();
    const r = await verifyAnchor(dir, save(a));
    expect(r.integrity.ok).toBe(true);
    expect(r.anchor.ok).toBe(false);
  });

  it("rejects a tampered anchor body", async () => {
    const a = await createAnchor(dir);
    const r = await verifyAnchor(dir, save({ ...a, count: a.count - 1 }));
    expect(r.anchor.ok).toBe(false);
    expect(r.anchor.reason).toMatch(/signature/);
  });

  it("rejects an anchor signed by a different key", async () => {
    const a = await createAnchor(dir);
    rmSync(anchorKeyPath());
    const b = await createAnchor(dir); // new key now trusted locally
    expect(b.key_id).not.toBe(a.key_id);
    const r = await verifyAnchor(dir, save(a));
    expect(r.anchor.ok).toBe(false);
    expect(r.anchor.reason).toMatch(/this machine's key/);
  });

  it("rejects missing, malformed and wrong-shape files", async () => {
    await expect(verifyAnchor(dir, join(home, "nope.json"))).rejects.toBeInstanceOf(PcsError);
    const bad = join(home, "bad.json");
    writeFileSync(bad, "not json");
    await expect(verifyAnchor(dir, bad)).rejects.toBeInstanceOf(PcsError);
    expect(() => parseAnchor("{}")).toThrow(PcsError);
  });

  it("refuses to anchor a log that already fails verification", async () => {
    await withDb(dir, (db) => {
      db.exec("DROP TRIGGER events_no_update");
      db.prepare("UPDATE events SET source = 'x' WHERE id = 1").run();
    });
    await expect(createAnchor(dir)).rejects.toMatchObject({ code: "INTEGRITY_FAILURE" });
  });
});
