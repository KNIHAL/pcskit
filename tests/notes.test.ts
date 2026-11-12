import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addNote,
  initProject,
  listNotes,
  MAX_NOTE_TEXT,
  PcsError,
  recentEvents,
  resolveNote,
  startSession,
  verifyProject,
  withDb,
} from "../src/core";

let dir: string;

function git(...args: string[]) {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pcs-note-"));
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

describe("notes", () => {
  it("adds notes as reported events and lists the unresolved ones", async () => {
    const n = await addNote(dir, "next", "  finish the exporter  ", "claude");
    expect(n).toMatchObject({ kind: "next", text: "finish the exporter", source: "claude", resolved_at: null });

    const ev = await withDb(dir, (db) => recentEvents(db, 5).find((e) => e.type === "note.added")!);
    expect(ev).toMatchObject({ id: n.id, provenance: "reported", source: "claude" });
    expect(await listNotes(dir)).toHaveLength(1);
    expect(await verifyProject(dir)).toMatchObject({ ok: true });
  });

  it("attributes to the active session's agent, an explicit agent wins, no session means user", async () => {
    const a = await addNote(dir, "issue", "before any session");
    await startSession(dir, "claude");
    const b = await addNote(dir, "issue", "during");
    const c = await addNote(dir, "issue", "by gpt", "gpt");
    expect([a.source, b.source, c.source]).toEqual(["user", "claude", "gpt"]);
    expect(a.session_id).toBeNull();
    expect(b.session_id).not.toBeNull();
  });

  it("resolves next/avoid/issue notes; resolved ones leave the default list", async () => {
    const n = await addNote(dir, "avoid", "billing/ belongs to another team");
    const keep = await addNote(dir, "next", "do the thing");
    const done = await resolveNote(dir, n.id, "gpt");
    expect(done).toMatchObject({ id: n.id, resolved_by: "gpt" });
    expect(done.resolved_at).not.toBeNull();
    expect((await listNotes(dir)).map((x) => x.id)).toEqual([keep.id]);
    expect((await listNotes(dir, { all: true })).map((x) => x.id)).toEqual([n.id, keep.id]);
    expect((await listNotes(dir, { kind: "avoid", all: true })).map((x) => x.id)).toEqual([n.id]);
    expect(await verifyProject(dir)).toMatchObject({ ok: true });
  });

  it("validates input and refuses bad resolutions", async () => {
    await expectCode(addNote(dir, "todo", "x"), "INVALID_INPUT");
    await expectCode(addNote(dir, "next", "   "), "INVALID_INPUT");
    await expectCode(addNote(dir, "next", "x".repeat(MAX_NOTE_TEXT + 1)), "INVALID_INPUT");
    await expectCode(addNote(dir, "next", "x", "bad\nname"), "INVALID_INPUT");
    await expectCode(listNotes(dir, { kind: "nope" }), "INVALID_INPUT");

    const task = await addNote(dir, "task", "build it");
    await expectCode(resolveNote(dir, task.id), "INVALID_INPUT"); // replaced, never resolved
    await expectCode(resolveNote(dir, 0), "INVALID_INPUT");
    await expectCode(resolveNote(dir, 9999), "INVALID_INPUT");
    const n = await addNote(dir, "issue", "x");
    await resolveNote(dir, n.id);
    await expectCode(resolveNote(dir, n.id), "INVALID_INPUT");
  });

  it("redacts secrets before storing", async () => {
    const secret = "ghp_" + "a1B2".repeat(9);
    const n = await addNote(dir, "issue", `token=${secret} and password=hunter2hunter2`);
    expect(n.text).not.toMatch(/ghp_|hunter2/);
    const stored = await withDb(dir, (db) =>
      recentEvents(db, 5)
        .map((e) => e.payload)
        .join(""),
    );
    expect(stored).not.toMatch(/ghp_|hunter2/);
  });

  it("is part of the tamper-evident log: editing a note is detected", async () => {
    await addNote(dir, "avoid", "do not touch billing");
    await withDb(dir, (db) => {
      db.exec("DROP TRIGGER events_no_update");
      db.exec("UPDATE events SET payload = '{\"kind\":\"avoid\",\"text\":\"anything goes\"}' WHERE type = 'note.added'");
    });
    expect(await verifyProject(dir)).toMatchObject({ ok: false, reason: expect.stringMatching(/modified/) });
  });
});
