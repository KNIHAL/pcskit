import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addNote, addTask, createHandoff, initProject, runTest, startSession, updateTask } from "../src/core";
import { startDashboard, type DashboardHandle } from "../src/dashboard/server";
import { PAGE } from "../src/dashboard/page";

let dir: string;
let dash: DashboardHandle | null = null;

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

interface Resp {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function http(path: string, opts: { method?: string; host?: string; cookie?: string } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: dash!.port,
        path,
        method: opts.method ?? "GET",
        headers: { ...(opts.host !== undefined ? { host: opts.host } : {}), ...(opts.cookie ? { cookie: opts.cookie } : {}) },
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const cookie = () => `pcs_dash=${dash!.token}`;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pcs-dash-"));
  git("init", "-q");
  git("config", "user.email", "t@t.dev");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "x\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
  await initProject(dir);
  dash = await startDashboard({ project: dir, port: 0 });
});

afterEach(async () => {
  await dash?.close();
  dash = null;
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

describe("dashboard: access control", () => {
  it("binds to loopback and prints a URL with the token", () => {
    expect(dash!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{48}$/);
  });

  it("refuses requests without the token, with a wrong token, and exchanges a good one for a strict cookie", async () => {
    expect((await http("/api/overview")).status).toBe(401);
    expect((await http("/?t=wrong")).status).toBe(401);
    expect((await http("/", { cookie: "pcs_dash=wrong" })).status).toBe(401);
    const r = await http(`/?t=${dash!.token}`);
    expect(r.status).toBe(302);
    const set = String(r.headers["set-cookie"]);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
  });

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    expect((await http("/", { host: "evil.example.com", cookie: cookie() })).status).toBe(403);
    expect((await http("/", { host: `localhost:${dash!.port}`, cookie: cookie() })).status).toBe(200);
  });

  it("is read-only: only GET and HEAD are served", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect((await http("/api/overview", { method, cookie: cookie() })).status).toBe(405);
    }
  });

  it("sets a strict CSP with a nonce and no data in the page itself", async () => {
    const r = await http("/", { cookie: cookie() });
    expect(r.status).toBe(200);
    const csp = String(r.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    expect(r.body).toContain("PCS dashboard");
    expect(PAGE).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });

  it("returns 404 for unknown paths", async () => {
    expect((await http("/nope", { cookie: cookie() })).status).toBe(404);
  });
});

describe("dashboard: data", () => {
  it("shows sessions, tasks with evidence, notes, runs, events and the last handoff, all tagged", async () => {
    await startSession(dir, "claude");
    await addNote(dir, "next", "Wire the flag");
    await addTask(dir, "write exporter");
    await runTest(dir, [process.execPath, "-e", "console.error('boom');process.exit(3)"], { taskId: 1 });
    await updateTask(dir, 1, { status: "done" });
    await createHandoff(dir, { noFile: true });

    const r = await http("/api/overview", { cookie: cookie() });
    expect(r.status).toBe(200);
    const d = JSON.parse(r.body);
    expect(d.status.project.name).toBeTruthy();
    expect(d.status.integrity.ok).toBe(true);
    expect(d.sessions[0]).toMatchObject({ agent: "claude" });
    expect(d.tasks[0]).toMatchObject({ title: "write exporter", status: "done" });
    expect(d.evidence["1"]).toMatchObject({ outcome: "failed" });
    expect(d.notes[0]).toMatchObject({ kind: "next" });
    expect(d.runs[0]).toMatchObject({ outcome: "failed", exit_code: 3 });
    expect(d.runs[0].output).toContain("boom");
    expect(d.lastHandoff).not.toBeNull();
    expect(d.events.length).toBeGreaterThan(5);
    expect(d.events.every((e: { provenance: string }) => ["verified", "reported", "inferred"].includes(e.provenance))).toBe(true);
  });

  it("keeps hostile recorded text as data: control characters are stripped from event summaries and output", async () => {
    await runTest(dir, [process.execPath, "-e", "console.log('\\u001b]0;pwned\\u0007<script>alert(1)</script>');process.exit(1)"]);
    const d = JSON.parse((await http("/api/overview", { cookie: cookie() })).body);
    // The real ESC and BEL characters must be gone; the script text stays as plain data.
    expect(d.runs[0].output).toBe("<script>alert(1)</script>\n");
    // eslint-disable-next-line no-control-regex
    const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
    for (const e of d.events as { summary: string }[]) expect(control.test(e.summary)).toBe(false);
  });
});
