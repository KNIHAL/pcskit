import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addTask,
  getStatus,
  initProject,
  listTasks,
  PcsError,
  recentEvents,
  updateTask,
  verifyProject,
  withDb,
} from "../src/core";

let dir: string;

function git(...args: string[]) {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pcs-task-"));
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

describe("tasks", () => {
  it("adds, lists and updates tasks", async () => {
    const t = await addTask(dir, "  build handoff  ", "claude");
    expect(t).toMatchObject({ id: 1, title: "build handoff", status: "todo" });

    await addTask(dir, "write docs");
    const updated = await updateTask(dir, 1, { status: "in_progress", note: "started", source: "claude" });
    expect(updated.status).toBe("in_progress");

    expect((await listTasks(dir)).map((x) => x.status)).toEqual(["in_progress", "todo"]);
    expect((await listTasks(dir, "todo")).map((x) => x.id)).toEqual([2]);
  });

  it("records every change as a reported event and keeps the chain valid", async () => {
    await addTask(dir, "one", "gpt");
    await updateTask(dir, 1, { status: "done", source: "gpt" });

    const events = await withDb(dir, (db) => recentEvents(db, 10));
    const created = events.find((e) => e.type === "task.created");
    const changed = events.find((e) => e.type === "task.status_changed");
    expect(created).toMatchObject({ provenance: "reported", source: "gpt" });
    expect(changed).toMatchObject({ provenance: "reported", source: "gpt" });
    expect(JSON.parse(changed!.payload)).toMatchObject({ taskId: 1, from: "todo", to: "done" });
    expect(await verifyProject(dir)).toMatchObject({ ok: true, count: 3 });
  });

  it("never claims an agent's 'done' is verified", async () => {
    await addTask(dir, "x");
    await updateTask(dir, 1, { status: "done", source: "claude" });
    const events = await withDb(dir, (db) => recentEvents(db, 10));
    expect(events.filter((e) => e.type.startsWith("task.")).every((e) => e.provenance !== "verified")).toBe(true);
  });

  it("redacts secrets in titles and notes before storing", async () => {
    const secret = "ghp_" + "a1B2".repeat(9);
    const t = await addTask(dir, `rotate token=${secret}`);
    expect(t.title).not.toContain(secret);
    await updateTask(dir, t.id, { status: "done", note: `used password=hunter2hunter2` });
    const events = await withDb(dir, (db) => recentEvents(db, 10));
    expect(events.map((e) => e.payload).join("")).not.toMatch(/hunter2|ghp_/);
  });

  it("validates input", async () => {
    await expectCode(addTask(dir, "   "), "INVALID_INPUT");
    await expectCode(addTask(dir, "x".repeat(501)), "INVALID_INPUT");
    await expectCode(updateTask(dir, 99, { status: "done" }), "INVALID_INPUT");
    await addTask(dir, "ok");
    await expectCode(updateTask(dir, 1, { status: "finished" }), "INVALID_INPUT");
    await expectCode(updateTask(dir, 0, { status: "done" }), "INVALID_INPUT");
    await expectCode(listTasks(dir, "nope"), "INVALID_INPUT");
  });

  it("failed updates do not leave partial state", async () => {
    await addTask(dir, "ok");
    await expectCode(updateTask(dir, 1, { status: "finished" }), "INVALID_INPUT");
    expect((await listTasks(dir))[0]?.status).toBe("todo");
    expect(await verifyProject(dir)).toMatchObject({ ok: true, count: 2 });
  });

  it("requires init", async () => {
    const plain = mkdtempSync(join(tmpdir(), "pcs-noinit-"));
    execFileSync("git", ["init", "-q"], { cwd: plain, stdio: "ignore" });
    await expectCode(addTask(plain, "x"), "NOT_INITIALIZED");
    rmSync(plain, { recursive: true, force: true });
  });

  it("shows only open tasks in status", async () => {
    await addTask(dir, "open one");
    await addTask(dir, "finished one");
    await updateTask(dir, 2, { status: "done" });
    const s = await getStatus(dir);
    expect(s.openTasks.map((t) => t.title)).toEqual(["open one"]);
  });
});
