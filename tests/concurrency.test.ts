import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, listNotes, recentEvents, verifyProject, withDb } from "../src/core";

let dir: string;
const WRITER = resolve(__dirname, "helpers", "writer.ts");

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pcs-conc-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.dev");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  await initProject(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface Report {
  label: string;
  written: number;
  errors: string[];
}

/** Start one writer process; resolves with what it reported. */
function runWriter(label: string, count: number): Promise<Report> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ["--import", "tsx", WRITER, dir, label, String(count)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", rej);
    child.on("close", (code) => {
      try {
        res(JSON.parse(out.trim().split("\n").pop() as string) as Report);
      } catch {
        rej(new Error(`writer ${label} exited ${code}: ${err || out}`));
      }
    });
  });
}

describe("several agents writing at once", () => {
  it("keeps one valid hash chain with no lost or duplicated events", async () => {
    const agents = ["alpha", "beta", "gamma", "delta"];
    const per = 15;
    const reports = await Promise.all(agents.map((a) => runWriter(a, per)));

    for (const r of reports) expect(r.errors, `${r.label} errors`).toEqual([]);
    const expected = reports.reduce((n, r) => n + r.written, 0);

    const report = await verifyProject(dir);
    expect(report.ok, report.reason).toBe(true);

    const notes = await listNotes(dir, { all: true });
    expect(notes).toHaveLength(agents.length * per);
    for (const a of agents) expect(notes.filter((n) => n.source === a)).toHaveLength(per);

    const ids = await withDb(dir, (db) => (db.prepare("SELECT id, prev_hash, hash FROM events ORDER BY id").all() as unknown as { id: number; prev_hash: string; hash: string }[]));
    expect(new Set(ids.map((e) => e.id)).size).toBe(ids.length);
    expect(new Set(ids.map((e) => e.hash)).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i++) expect(ids[i]?.prev_hash).toBe(ids[i - 1]?.hash);
    // project.init + every write, nothing else lost
    expect(ids.length).toBeGreaterThanOrEqual(expected + 1);
    expect((await withDb(dir, (db) => recentEvents(db, 1)))[0]?.id).toBe(ids[ids.length - 1]?.id);
  }, 180_000);

  it("survives a writer being killed mid-run", async () => {
    const victim = spawn(process.execPath, ["--import", "tsx", WRITER, dir, "victim", "200"], { stdio: "ignore", windowsHide: true });
    const other = runWriter("steady", 12);
    await new Promise((r) => setTimeout(r, 2500));
    victim.kill("SIGKILL");
    const r = await other;
    expect(r.errors).toEqual([]);
    const report = await verifyProject(dir);
    expect(report.ok, report.reason).toBe(true);
    expect((await listNotes(dir, { all: true })).filter((n) => n.source === "steady")).toHaveLength(12);
  }, 180_000);
});
