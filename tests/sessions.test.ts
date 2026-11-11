import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addTask,
  currentSession,
  endSession,
  getStatus,
  initProject,
  listSessions,
  PcsError,
  recentEvents,
  startSession,
  updateTask,
  verifyProject,
  withDb,
} from "../src/core";

let dir: string;

function git(...args: string[]) {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pcs-sess-"));
  git("init", "-q");
  git("config", "user.email", "t@t.dev");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "x\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
  await initProject(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PcsError);
  expect((err as PcsError).code).toBe(code);
}

const events = () => withDb(dir, (db) => recentEvents(db, 50).reverse());

describe("session lifecycle", () => {
  it("starts a session and records a reported event tied to it", async () => {
    const { session, interrupted } = await startSession(dir, "claude");
    expect(interrupted).toBeNull();
    expect(session).toMatchObject({ agent: "claude", ended_at: null, end_reason: null });
    expect(await currentSession(dir)).toMatchObject({ id: session.id, agent: "claude" });

    const started = (await events()).find((e) => e.type === "session.started");
    expect(started).toMatchObject({ provenance: "reported", source: "claude", session_id: session.id });
  });

  it("ends a session with a reason and a redacted note", async () => {
    await startSession(dir, "claude");
    const ended = await endSession(dir, { reason: "limit", note: "stopped in src/x.ts, password=hunter2hunter2" });
    expect(ended).toMatchObject({ end_reason: "limit" });
    expect(ended.ended_at).not.toBeNull();
    expect(await currentSession(dir)).toBeNull();

    const evt = (await events()).find((e) => e.type === "session.ended")!;
    expect(evt.payload).toContain("stopped in src/x.ts");
    expect(evt.payload).not.toContain("hunter2");
  });

  it("marks a never-ended session as interrupted (inferred) when a new one starts", async () => {
    const first = await startSession(dir, "claude");
    const { session: second, interrupted } = await startSession(dir, "gpt");

    expect(interrupted).toMatchObject({ id: first.session.id, agent: "claude", end_reason: "interrupted" });
    expect(second.agent).toBe("gpt");

    const all = await listSessions(dir);
    expect(all.filter((s) => s.ended_at === null)).toHaveLength(1);
    expect(all.find((s) => s.id === first.session.id)?.end_reason).toBe("interrupted");

    const evt = (await events()).find((e) => e.type === "session.interrupted")!;
    expect(evt).toMatchObject({ provenance: "inferred", source: "pcs", session_id: first.session.id });
  });

  it("validates input", async () => {
    await expectCode(endSession(dir), "INVALID_INPUT"); // none active
    await startSession(dir, "claude");
    await expectCode(endSession(dir, { reason: "interrupted" }), "INVALID_INPUT"); // inferred-only
    await expectCode(endSession(dir, { reason: "whatever" }), "INVALID_INPUT");
    await expectCode(startSession(dir, ""), "INVALID_INPUT");
    await expectCode(startSession(dir, "bad\u001b[31m"), "INVALID_INPUT");
    await expectCode(startSession(dir, "a".repeat(65)), "INVALID_INPUT");
    await expectCode(listSessions(dir, 0), "INVALID_INPUT");
    expect((await currentSession(dir))?.agent).toBe("claude"); // failed calls changed nothing
  });

  it("shows the active session in status", async () => {
    expect((await getStatus(dir)).session).toBeNull();
    await startSession(dir, "codex");
    expect((await getStatus(dir)).session?.agent).toBe("codex");
  });
});

describe("tasks inherit the session", () => {
  it("attributes task events to the active session and its agent", async () => {
    const { session } = await startSession(dir, "claude");
    await addTask(dir, "write handoff");
    await updateTask(dir, 1, { status: "in_progress" });

    const taskEvents = (await events()).filter((e) => e.type.startsWith("task."));
    expect(taskEvents).toHaveLength(2);
    for (const e of taskEvents) {
      expect(e).toMatchObject({ source: "claude", session_id: session.id, provenance: "reported" });
    }
  });

  it("explicit agent overrides the session agent; no session means user and no session id", async () => {
    await addTask(dir, "before any session");
    await startSession(dir, "claude");
    await addTask(dir, "reported by gpt", "gpt");

    const evts = (await events()).filter((e) => e.type === "task.created");
    expect(evts[0]).toMatchObject({ source: "user", session_id: null });
    expect(evts[1]).toMatchObject({ source: "gpt" });
    expect(evts[1]!.session_id).not.toBeNull();
    await expectCode(addTask(dir, "x", "bad\nname"), "INVALID_INPUT");
  });
});

describe("integrity with sessions", () => {
  it("keeps the chain valid across a full flow", async () => {
    await startSession(dir, "claude");
    await addTask(dir, "t");
    await startSession(dir, "gpt");
    await endSession(dir, { reason: "completed" });
    expect((await verifyProject(dir)).ok).toBe(true);
  });

  it("detects tampering with an event's session link", async () => {
    await startSession(dir, "claude");
    await addTask(dir, "t");
    await withDb(dir, (db) => {
      db.exec("DROP TRIGGER events_no_update");
      db.exec("UPDATE events SET session_id = 999 WHERE type = 'task.created'");
    });
    expect(await verifyProject(dir)).toMatchObject({ ok: false, reason: expect.stringMatching(/modified/) });
  });
});
