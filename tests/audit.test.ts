import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addNote,
  addTask,
  buildExport,
  checkExport,
  eventSummary,
  formatExportMarkdown,
  formatLogLine,
  hasInheritedAces,
  initProject,
  isOwnerOnly,
  listEvents,
  openDb,
  runDoctor,
  secureDir,
  startSession,
  type AuditExport,
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
  home = mkdtempSync(join(tmpdir(), "pcs-audhome-"));
  process.env.PCS_HOME = home;
  dir = mkdtempSync(join(tmpdir(), "pcs-aud-"));
  extra.push(home, dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.dev");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  await initProject(dir);
  await startSession(dir, "alpha");
  await addNote(dir, "next", "write the parser");
  await addNote(dir, "avoid", "do not touch | the build");
  await addTask(dir, "ship it");
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.PCS_HOME;
  else process.env.PCS_HOME = prevHome;
  for (const d of extra.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("log", () => {
  it("returns the newest events oldest-first, honouring the limit", async () => {
    const all = await listEvents(dir, { limit: 100 });
    const last2 = await listEvents(dir, { limit: 2 });
    expect(last2.map((e) => e.id)).toEqual(all.slice(-2).map((e) => e.id));
    expect(all.map((e) => e.id)).toEqual([...all.map((e) => e.id)].sort((a, b) => a - b));
  });

  it("filters by type (with wildcard), provenance and id", async () => {
    const notes = await listEvents(dir, { type: "note.*" });
    expect(notes.length).toBe(2);
    expect(notes.every((e) => e.type.startsWith("note."))).toBe(true);
    const exact = await listEvents(dir, { type: "note.added" });
    expect(exact).toHaveLength(2);
    expect((await listEvents(dir, { provenance: "reported" })).every((e) => e.provenance === "reported")).toBe(true);
    const all = await listEvents(dir, { limit: 100 });
    const after = await listEvents(dir, { afterId: all[1]!.id, limit: 100 });
    expect(after.map((e) => e.id)).toEqual(all.slice(2).map((e) => e.id));
  });

  it("treats % and _ in a type filter literally", async () => {
    expect(await listEvents(dir, { type: "note_added" })).toHaveLength(0);
    expect(await listEvents(dir, { type: "%" })).toHaveLength(0);
  });

  it("rejects bad filters", async () => {
    await expect(listEvents(dir, { limit: 0 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(listEvents(dir, { limit: 5000 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(listEvents(dir, { provenance: "bogus" as never })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(listEvents(dir, { afterId: -1 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("summarises on one clean line", async () => {
    const [e] = await listEvents(dir, { type: "note.added", limit: 2 });
    const line = formatLogLine(e!);
    expect(line).toMatch(/^#\d+ \d{4}-.* \[reported\] note\.added \(/);
    expect(line).toContain("write the parser");
    expect(line).not.toMatch(/[\r\n]/);
    expect(eventSummary({ payload: JSON.stringify({ text: "a\nb\u0007c" }) })).toBe("text=a b c");
    expect(eventSummary({ payload: JSON.stringify({ text: "x".repeat(500) }) }, 50)).toHaveLength(50);
    expect(eventSummary({ payload: "not json" })).toBe("");
  });
});

describe("export", () => {
  it("exports the whole log and re-checks cleanly", async () => {
    const x = await buildExport(dir);
    expect(x.format).toBe("pcskit-audit-1");
    expect(x.partial).toBe(false);
    expect(x.integrity.ok).toBe(true);
    expect(x.head?.hash).toBe(x.events[x.events.length - 1]!.hash);
    expect(x.counts["note.added"]).toBe(2);
    const r = checkExport(JSON.stringify(x));
    expect(r).toMatchObject({ ok: true, events: x.events.length, partial: false });
  });

  it("supports a partial range that still checks", async () => {
    const full = await buildExport(dir);
    const from = full.events[2]!.id;
    const x = await buildExport(dir, { from });
    expect(x.partial).toBe(true);
    expect(x.events[0]!.id).toBe(from);
    expect(checkExport(JSON.stringify(x)).ok).toBe(true);
    const mid = await buildExport(dir, { from: full.events[1]!.id, to: full.events[3]!.id });
    expect(mid.events).toHaveLength(3);
    expect(checkExport(JSON.stringify(mid)).ok).toBe(true);
  });

  it("detects a modified, removed, reordered or relinked event", async () => {
    const x = await buildExport(dir);
    const clone = (): AuditExport => JSON.parse(JSON.stringify(x)) as AuditExport;

    const edited = clone();
    (edited.events[2]!.payload as Record<string, unknown>).text = "forged";
    expect(checkExport(JSON.stringify(edited))).toMatchObject({ ok: false, reason: "event content was modified", brokenAt: edited.events[2]!.id });

    const removed = clone();
    removed.events.splice(2, 1);
    expect(checkExport(JSON.stringify(removed))).toMatchObject({ ok: false, reason: expect.stringContaining("chain link") });

    const swapped = clone();
    [swapped.events[1], swapped.events[2]] = [swapped.events[2]!, swapped.events[1]!];
    expect(checkExport(JSON.stringify(swapped)).ok).toBe(false);

    const rehash = clone();
    rehash.events[1]!.hash = "f".repeat(64);
    expect(checkExport(JSON.stringify(rehash)).ok).toBe(false);

    const cutTail = clone();
    cutTail.events.pop();
    expect(checkExport(JSON.stringify(cutTail))).toMatchObject({ ok: false, reason: expect.stringContaining("head hash") });
  });

  it("rejects files that are not exports", () => {
    expect(() => checkExport("nope")).toThrow(/not valid JSON/);
    expect(() => checkExport("{}")).toThrow(/Not a pcskit-audit-1 export/);
    expect(checkExport(JSON.stringify({ format: "pcskit-audit-1", partial: false, events: [{ id: 1 }] })).ok).toBe(false);
  });

  it("carries a failing integrity result when the log was tampered with", async () => {
    const db = openDb(dir);
    db.exec("DROP TRIGGER events_no_update");
    db.prepare("UPDATE events SET source = 'x' WHERE id = 2").run();
    db.close();
    const x = await buildExport(dir);
    expect(x.integrity.ok).toBe(false);
    expect(x.integrity.broken_at).toBe(2);
    expect(checkExport(JSON.stringify(x)).ok).toBe(false);
  });

  it("validates ranges", async () => {
    await expect(buildExport(dir, { from: 0 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(buildExport(dir, { from: 5, to: 2 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("renders Markdown with escaped table cells", async () => {
    const md = formatExportMarkdown(await buildExport(dir));
    expect(md).toContain("# PCS audit trail:");
    expect(md).toContain("## Timeline");
    expect(md).toContain("do not touch \\| the build");
    expect(md).toContain("OK (");
  });
});

describe(".pcs access", () => {
  it("parses inherited ACEs from icacls output", () => {
    expect(hasInheritedAces("C:\\x BUILTIN\\Users:(I)(OI)(CI)(RX)\nSuccessfully processed")).toBe(true);
    expect(hasInheritedAces("C:\\x NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\nSuccessfully processed")).toBe(false);
  });

  it("initialization leaves .pcs owner-only", () => {
    expect(isOwnerOnly(join(dir, ".pcs"))).toBe(true);
  });

  it("secureDir restricts a folder and doctor --fix repairs a loosened one", async () => {
    const d = join(dir, ".pcs");
    if (process.platform === "win32") {
      execFileSync("icacls", [d, "/inheritance:e", "/Q"], { stdio: "ignore" });
    } else {
      chmodSync(d, 0o755);
    }
    expect(isOwnerOnly(d)).toBe(false);
    const warn = await runDoctor(dir, { exec: async () => ({ code: 1, stdout: "", stderr: "" }) });
    expect(warn.checks.find((c) => c.id === "permissions")?.status).toBe("warn");
    const fixed = await runDoctor(dir, { exec: async () => ({ code: 1, stdout: "", stderr: "" }) }, { fix: true });
    expect(fixed.checks.find((c) => c.id === "permissions")?.status).toBe("ok");
    expect(isOwnerOnly(d)).toBe(true);
  });

  it("secureDir keeps existing files usable by the owner (no lock-out)", () => {
    const d = join(dir, "has-files");
    mkdirSync(join(d, "sub"), { recursive: true });
    writeFileSync(join(d, "a.db"), "one");
    writeFileSync(join(d, "sub", "b.db"), "two");
    expect(secureDir(d)).toBe(true);
    expect(readFileSync(join(d, "a.db"), "utf8")).toBe("one");
    writeFileSync(join(d, "sub", "b.db"), "three");
    writeFileSync(join(d, "new.db"), "later");
    expect(isOwnerOnly(d)).toBe(true);
    rmSync(d, { recursive: true });
    expect(existsSync(d)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("a closed folder counts as owner-only even if a file inside is 0644", () => {
    const d = join(dir, "closed");
    mkdirSync(d, { mode: 0o700 });
    writeFileSync(join(d, "f"), "x", { mode: 0o644 });
    chmodSync(d, 0o700);
    expect(isOwnerOnly(d)).toBe(true);
    chmodSync(d, 0o750);
    expect(isOwnerOnly(d)).toBe(false);
  });

  it("secureDir on a missing folder reports false", () => {
    expect(secureDir(join(dir, "nope"))).toBe(false);
    mkdirSync(join(dir, "ok"));
    expect(secureDir(join(dir, "ok"))).toBe(true);
    expect(isOwnerOnly(join(dir, "ok"))).toBe(true);
  });
});
