import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject, recentEvents, verifyProject, withDb } from "../src/core";
import { createMcpServer, type McpOptions } from "../src/mcp/server";

let dir: string;
let client: Client | null = null;

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

async function connect(extra: Partial<McpOptions> = {}): Promise<Client> {
  const server = createMcpServer({ project: dir, ...extra });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  client = new Client({ name: "test", version: "1" });
  await client.connect(a);
  return client;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  return { isError: r.isError === true, text: r.content.map((x) => x.text).join("\n") };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pcs-mcp-"));
  git("init", "-q");
  git("config", "user.email", "t@t.dev");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "x\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
  await initProject(dir);
});

afterEach(async () => {
  await client?.close();
  client = null;
  for (let i = 0; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch (e) {
      if (i > 20) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
});

describe("mcp: tools", () => {
  it("lists the tools, without pcs_test unless the operator allows it", async () => {
    const names = (await (await connect()).listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["pcs_status", "pcs_resume", "pcs_handoff", "pcs_note_add", "pcs_task_add", "pcs_session_start"]));
    expect(names).not.toContain("pcs_test");
    await client!.close();
    const withTest = (await (await connect({ allowTest: true })).listTools()).tools.map((t) => t.name);
    expect(withTest).toContain("pcs_test");
  });

  it("marks read tools read-only and write tools not", async () => {
    const tools = (await (await connect()).listTools()).tools;
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
    expect(by.pcs_status).toBe(true);
    expect(by.pcs_note_list).toBe(true);
    expect(by.pcs_note_add).toBe(false);
    expect(by.pcs_resume).toBe(false);
  });

  it("runs the full continuity loop through tool calls, attributing writes to the agent", async () => {
    const c = await connect({ agent: "claude" });
    expect((await call(c, "pcs_session_start", { agent: "claude" })).isError).toBe(false);
    await call(c, "pcs_note_add", { kind: "task", text: "Build the exporter" });
    await call(c, "pcs_task_add", { title: "write exporter" });
    await call(c, "pcs_note_add", { kind: "next", text: "Wire the flag" });
    expect((await call(c, "pcs_session_end", { reason: "limit", note: "stopped mid-way" })).isError).toBe(false);
    const handoff = await call(c, "pcs_handoff");
    expect(handoff.text).toContain("# PCS handoff");
    expect(handoff.text).toContain("Wire the flag");

    const picked = await call(c, "pcs_resume", { agent: "gpt" });
    expect(picked.isError).toBe(false);
    expect(picked.text).toContain("# PCS resume brief");
    expect(picked.text).toContain("You are session #2 (`gpt`)");

    const events = await withDb(dir, (db) => recentEvents(db, 100));
    const note = events.find((e) => e.type === "note.added")!;
    expect(note.source).toBe("claude");
    expect(events.find((e) => e.type === "handoff.picked_up")!.source).toBe("gpt");
    expect((await verifyProject(dir)).ok).toBe(true);
    expect((await call(c, "pcs_verify")).text).toContain('"ok": true');
  });

  it("keeps results short: no hashes, no raw payloads, no full file records", async () => {
    const c = await connect({ agent: "claude" });
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, `f${i}.ts`), "x\n");
    const start = await call(c, "pcs_session_start", { agent: "claude" });
    const status = await call(c, "pcs_status");
    const snap = await call(c, "pcs_snapshot");
    for (const r of [start, status, snap]) {
      expect(r.text).not.toMatch(/prev_hash|"hash"|"digest"|"sha256"|"payload"/);
      expect(r.text.length).toBeLessThan(3500);
    }
    expect(JSON.parse(snap.text)).toMatchObject({ changedFiles: 40, moreFiles: 15 });
    expect(JSON.parse(status.text).recent[0]).toMatch(/^#\d+ \S+ \[(verified|reported|inferred)\] /);
  });

  it("returns errors as tool errors, not crashes", async () => {
    const c = await connect();
    const r = await call(c, "pcs_resume", { agent: "gpt" }); // no handoff yet
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No handoff exists yet");
    expect((await call(c, "pcs_task_update", { id: 99, status: "done" })).isError).toBe(true);
  });

  it("rejects malformed input before touching the project", async () => {
    const c = await connect();
    const bad = await c.callTool({ name: "pcs_note_add", arguments: { kind: "bogus", text: "x" } }).then(
      (r) => ({ isError: (r as { isError?: boolean }).isError === true }),
      () => ({ isError: true }),
    );
    expect(bad.isError).toBe(true);
    expect(await withDb(dir, (db) => recentEvents(db, 50).some((e) => e.type === "note.added"))).toBe(false);
  });

  it("redacts secrets in notes and keeps control characters out of results", async () => {
    const c = await connect();
    await call(c, "pcs_note_add", { kind: "issue", text: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 \u001b[31mred\u001b[0m" });
    const list = await call(c, "pcs_note_list");
    expect(list.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(list.text).not.toContain("\u001b");
  });
});

describe("mcp: pcs_test (opt-in)", () => {
  it("runs a command as verified evidence and links it to a task", async () => {
    const c = await connect({ allowTest: true, agent: "claude" });
    await call(c, "pcs_task_add", { title: "t" });
    const r = await call(c, "pcs_test", { command: [process.execPath, "-e", "process.exit(0)"], task: 1 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('"linkedTask": 1');
    expect(r.text).toContain('"outcome": "passed"');
    const failing = await call(c, "pcs_test", { command: [process.execPath, "-e", "process.exit(3)"] });
    expect(failing.text).toContain('"outcome": "failed"');
  });
});
