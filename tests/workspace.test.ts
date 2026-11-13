import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addProject,
  createHandoff,
  initProject,
  listTasks,
  loadWorkspace,
  pickProject,
  PcsError,
  removeProject,
  startSession,
  workspaceFile,
  workspaceStatus,
} from "../src/core";
import { createMcpServer } from "../src/mcp/server";

let base: string;
let client: Client | null = null;
const oldHome = process.env.PCS_HOME;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

async function makeProject(parent: string, name: string): Promise<string> {
  const dir = join(base, parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.dev");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  await initProject(dir);
  return dir;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "pcs-ws-"));
  process.env.PCS_HOME = join(base, "home");
});

afterEach(async () => {
  await client?.close();
  client = null;
  if (oldHome === undefined) delete process.env.PCS_HOME;
  else process.env.PCS_HOME = oldHome;
  for (let i = 0; ; i++) {
    try {
      rmSync(base, { recursive: true, force: true });
      break;
    } catch (e) {
      if (i > 20) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
});

async function expectCode(p: Promise<unknown> | (() => unknown), code = "INVALID_INPUT") {
  const err = await (typeof p === "function" ? Promise.resolve().then(p) : p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PcsError);
  expect((err as PcsError).code).toBe(code);
}

describe("workspace: registry", () => {
  it("registers projects, is idempotent, and gives clashing folder names distinct names", async () => {
    const a = await makeProject("one", "app");
    const b = await makeProject("two", "app");
    const r1 = await addProject(a);
    expect(r1).toMatchObject({ added: true, entry: { name: "app" } });
    expect((await addProject(a)).added).toBe(false);
    expect((await addProject(b)).entry.name).toBe("app-2");
    expect(loadWorkspace().map((p) => p.name)).toEqual(["app", "app-2"]);
  });

  it("refuses projects that are not initialized, and bad or duplicate names", async () => {
    const plain = join(base, "plain");
    mkdirSync(plain);
    git(plain, "init", "-q");
    await expectCode(addProject(plain), "NOT_INITIALIZED");
    const a = await makeProject("x", "a");
    const b = await makeProject("x", "b");
    await expectCode(addProject(a, "bad name!"));
    await addProject(a, "alpha");
    await expectCode(addProject(b, "alpha"));
  });

  it("removes by name or path and leaves the project's own .pcs alone", async () => {
    const a = await makeProject("x", "a");
    await addProject(a, "alpha");
    removeProject("alpha");
    expect(loadWorkspace()).toEqual([]);
    expect(existsSync(join(a, ".pcs", "pcs.db"))).toBe(true);
    await addProject(a, "alpha");
    removeProject(a);
    expect(loadWorkspace()).toEqual([]);
    expect(() => removeProject("ghost")).toThrow(PcsError);
  });

  it("rejects a corrupt registry file instead of guessing", async () => {
    mkdirSync(join(base, "home"), { recursive: true });
    writeFileSync(workspaceFile(), "{ not json");
    expect(() => loadWorkspace()).toThrow(PcsError);
  });

  it("picks a project by name, or the only one; refuses ambiguity", () => {
    const one = [{ name: "a", root: "/a" }];
    const two = [...one, { name: "b", root: "/b" }];
    expect(pickProject(one).name).toBe("a");
    expect(pickProject(two, "b").root).toBe("/b");
    expect(() => pickProject(two)).toThrow(/Several projects/);
    expect(() => pickProject(two, "zzz")).toThrow(/Unknown project/);
    expect(() => pickProject([])).toThrow(/No projects registered/);
  });
});

describe("workspace: status across projects", () => {
  it("summarizes each project, and one broken project does not hide the others", async () => {
    const a = await makeProject("x", "a");
    const b = await makeProject("x", "b");
    await addProject(a, "alpha");
    await addProject(b, "beta");
    await startSession(a, "claude");
    await createHandoff(a, { noFile: true });
    writeFileSync(join(a, "wip.ts"), "w\n");
    rmSync(join(b, ".pcs"), { recursive: true, force: true }); // beta lost its data

    const rows = await workspaceStatus();
    const alpha = rows.find((r) => r.name === "alpha")!;
    expect(alpha).toMatchObject({ ok: true, branch: expect.any(String), changedFiles: 1, integrity: true });
    expect(alpha.session).toMatchObject({ agent: "claude" });
    expect(alpha.lastHandoff).not.toBeNull();
    expect(rows.find((r) => r.name === "beta")).toMatchObject({ ok: false });
  });
});

describe("workspace: MCP with several projects", () => {
  async function connect() {
    const server = createMcpServer({ project: base, workspace: true });
    const [x, y] = InMemoryTransport.createLinkedPair();
    await server.connect(y);
    client = new Client({ name: "t", version: "1" });
    await client.connect(x);
    return client;
  }
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: r.isError === true, text: r.content.map((p) => p.text).join("\n") };
  };

  it("needs a project name when several are registered, and writes only to the one named", async () => {
    const a = await makeProject("x", "a");
    const b = await makeProject("x", "b");
    await addProject(a, "alpha");
    await addProject(b, "beta");
    const c = await connect();

    expect((await c.listTools()).tools.map((t) => t.name)).toContain("pcs_workspace_status");
    const ambiguous = await call(c, "pcs_task_add", { title: "t" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toMatch(/alpha, beta/);

    expect((await call(c, "pcs_task_add", { title: "only in beta", project: "beta" })).isError).toBe(false);
    expect((await listTasks(b)).map((t) => t.title)).toEqual(["only in beta"]);
    expect(await listTasks(a)).toEqual([]);

    const unknown = await call(c, "pcs_status", { project: "../../etc" });
    expect(unknown.isError).toBe(true);

    const overview = JSON.parse((await call(c, "pcs_workspace_status")).text) as { name: string }[];
    expect(overview.map((p) => p.name)).toEqual(["alpha", "beta"]);
  });

  it("sees a project registered after the server started", async () => {
    const a = await makeProject("x", "a");
    const c = await connect();
    expect((await call(c, "pcs_status")).isError).toBe(true); // nothing registered yet
    await addProject(a, "alpha");
    const ok = await call(c, "pcs_status"); // one project: no name needed
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain('"changedFiles"');
  });
});

describe("workspace: dashboard", () => {
  it("lists the projects and shows the one picked, rejecting unknown names", async () => {
    const { startDashboard } = await import("../src/dashboard/server");
    const a = await makeProject("x", "a");
    const b = await makeProject("x", "b");
    await addProject(a, "alpha");
    await addProject(b, "beta");
    await startSession(b, "gpt");
    const d = await startDashboard({ project: base, port: 0, workspace: true });
    try {
      const get = async (path: string) => {
        const r = await fetch(`http://127.0.0.1:${d.port}${path}`, { headers: { cookie: `pcs_dash=${d.token}` } });
        return { status: r.status, body: (await r.json()) as any };
      };
      const projects = await get("/api/projects");
      expect(projects.status).toBe(200);
      expect(projects.body.map((p: { name: string }) => p.name)).toEqual(["alpha", "beta"]);
      const beta = await get("/api/overview?project=beta");
      expect(beta.body.status.project.name).toBe("b");
      expect(beta.body.sessions[0].agent).toBe("gpt");
      expect((await get("/api/overview?project=nope")).status).toBe(400);
      expect((await get("/api/overview")).status).toBe(400); // two projects: must say which
    } finally {
      await d.close();
    }
  });
});
