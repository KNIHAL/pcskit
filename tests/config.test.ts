import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addNote,
  globalConfigPath,
  globToRegExp,
  initConfig,
  initProject,
  isSensitivePath,
  listNotes,
  loadPolicy,
  isCommandAllowed,
  projectConfigPath,
  runTest,
} from "../src/core";
import { createMcpServer } from "../src/mcp/server";

let dir: string;
let home: string;
let prevHome: string | undefined;
let client: Client | null = null;
const extra: string[] = [];

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
const project = (cfg: unknown) => writeFileSync(projectConfigPath(dir), typeof cfg === "string" ? cfg : JSON.stringify(cfg));
const global = (cfg: unknown) => writeFileSync(globalConfigPath(), JSON.stringify(cfg));

beforeEach(async () => {
  prevHome = process.env.PCS_HOME;
  home = mkdtempSync(join(tmpdir(), "pcs-cfghome-"));
  process.env.PCS_HOME = home;
  dir = mkdtempSync(join(tmpdir(), "pcs-cfg-"));
  extra.push(home, dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.dev");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  await initProject(dir);
});

afterEach(async () => {
  await client?.close();
  client = null;
  if (prevHome === undefined) delete process.env.PCS_HOME;
  else process.env.PCS_HOME = prevHome;
  for (const d of extra.splice(0)) rmSync(d, { recursive: true, force: true });
  // Policy rules are per-root and in-process: reset them so other tests see only the defaults.
  await Promise.resolve();
});

describe("config: redaction and sensitive paths", () => {
  it("redacts a custom pattern in notes", async () => {
    project({ redaction: { patterns: [{ name: "acme-key", pattern: "ACME-[A-Z0-9]{12}" }] } });
    const n = await addNote(dir, "next", "use ACME-ABCDEF123456 for staging");
    expect(n.text).toContain("[REDACTED:acme-key]");
    expect(n.text).not.toContain("ABCDEF123456");
    expect((await listNotes(dir))[0]?.text).not.toContain("ABCDEF123456");
  });

  it("flags custom sensitive paths", async () => {
    project({ sensitivePaths: ["**/secrets/**", "*.vault"] });
    loadPolicy(dir);
    expect(isSensitivePath("config/secrets/db.txt")).toBe(true);
    expect(isSensitivePath("prod.vault")).toBe(true);
    expect(isSensitivePath("src/index.ts")).toBe(false);
    expect(isSensitivePath(".env")).toBe(true); // built-ins stay
  });

  it("converts globs sanely", () => {
    expect(globToRegExp("*.vault").test("a/b/x.vault")).toBe(true);
    expect(globToRegExp("*.vault").test("x.vault.txt")).toBe(false);
    expect(globToRegExp("a/*/c").test("a/b/c")).toBe(true);
    expect(globToRegExp("a/*/c").test("a/b/d/c")).toBe(false);
    expect(globToRegExp("a/**/c").test("a/b/d/c")).toBe(true);
  });

  it("works with the global file too, and merges both", async () => {
    global({ redaction: { patterns: [{ name: "g-key", pattern: "GKEY-[0-9]{6}" }] } });
    project({ redaction: { patterns: [{ name: "p-key", pattern: "PKEY-[0-9]{6}" }] } });
    const n = await addNote(dir, "next", "GKEY-123456 and PKEY-654321");
    expect(n.text).toBe("[REDACTED:g-key] and [REDACTED:p-key]");
  });
});

describe("config: validation (fails loudly, never silently ignored)", () => {
  it.each([
    ["bad JSON", "{not json"],
    ["unknown key", { nope: 1 }],
    ["invalid regex", { redaction: { patterns: [{ name: "x", pattern: "(" }] } }],
    ["pattern matching empty text", { redaction: { patterns: [{ name: "x", pattern: "a*" }] } }],
    ["bad flags", { redaction: { patterns: [{ name: "x", pattern: "a", flags: "g" }] } }],
    ["cap above the default", { caps: { maxNoteChars: 999999 } }],
    ["cap too small", { caps: { maxNoteChars: 1 } }],
  ])("rejects %s", async (_n, cfg) => {
    project(cfg);
    await expect(addNote(dir, "next", "hello")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("config: test allowlist and caps", () => {
  it("only runs allowlisted commands", async () => {
    project({ test: { allow: ["node -e"] } });
    await expect(runTest(dir, ["git", "status"])).rejects.toThrow(/allowlist/);
    const r = await runTest(dir, ["node", "-e", "console.log(1)"]);
    expect(r.run.outcome).toBe("passed");
  });

  it("requires both the global and the project allowlist to pass", () => {
    global({ test: { allow: ["npm test", "node"] } });
    project({ test: { allow: ["node -e", "git"] } });
    const p = loadPolicy(dir);
    expect(isCommandAllowed(p, ["node", "-e", "1"])).toBe(true);
    expect(isCommandAllowed(p, ["npm", "test"])).toBe(false);
    expect(isCommandAllowed(p, ["git", "status"])).toBe(false);
    expect(isCommandAllowed(p, ["node"])).toBe(false);
  });

  it("matches whole tokens, not string prefixes", () => {
    project({ test: { allow: ["npm test"] } });
    const p = loadPolicy(dir);
    expect(isCommandAllowed(p, ["npm", "test", "--silent"])).toBe(true);
    expect(isCommandAllowed(p, ["npm", "testing"])).toBe(false);
    expect(isCommandAllowed(p, ["npmx", "test"])).toBe(false);
  });

  it("lowers the note and test-output caps", async () => {
    project({ caps: { maxNoteChars: 100, maxTestOutputChars: 500 } });
    await expect(addNote(dir, "next", "x".repeat(101))).rejects.toThrow(/100/);
    await addNote(dir, "next", "x".repeat(100));
    const r = await runTest(dir, ["node", "-e", "console.log('y'.repeat(2000))"]);
    expect(r.run.output.length).toBeLessThanOrEqual(500);
    expect(r.run.output_truncated).toBe(true);
  });

  it("has no restrictions without a config", () => {
    const p = loadPolicy(dir);
    expect(p.testAllow).toEqual([]);
    expect(isCommandAllowed(p, ["anything"])).toBe(true);
  });

  it("picks up edits to the file", async () => {
    project({ caps: { maxNoteChars: 100 } });
    await expect(addNote(dir, "next", "x".repeat(150))).rejects.toThrow();
    project({ caps: { maxNoteChars: 200 } });
    await addNote(dir, "next", "x".repeat(150));
  });

  it("initConfig writes a valid sample and refuses to overwrite", async () => {
    initConfig(dir);
    expect(() => initConfig(dir)).toThrow(/already exists/);
    await addNote(dir, "next", "still works");
  });
});

describe("mcp --read-only", () => {
  async function connect(opts: { readOnly?: boolean; allowTest?: boolean }) {
    const server = createMcpServer({ project: dir, ...opts });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    client = new Client({ name: "test", version: "1" });
    await client.connect(a);
    return client;
  }

  it("registers only tools that cannot change anything, even with --allow-test", async () => {
    const tools = (await (await connect({ readOnly: true, allowTest: true })).listTools()).tools;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["pcs_status", "pcs_verify", "pcs_task_list", "pcs_note_list", "pcs_evidence_list"]));
    for (const w of ["pcs_test", "pcs_note_add", "pcs_task_add", "pcs_session_start", "pcs_handoff", "pcs_resume", "pcs_snapshot"]) {
      expect(names).not.toContain(w);
    }
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("is off by default", async () => {
    const names = (await (await connect({})).listTools()).tools.map((t) => t.name);
    expect(names).toContain("pcs_note_add");
  });
});
