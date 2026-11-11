import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  changedFilesBetween,
  commitsBetween,
  compareSnapshots,
  endSession,
  getStatus,
  initProject,
  inTransaction,
  listSnapshots,
  observeSnapshot,
  PcsError,
  recentEvents,
  recordObservation,
  startSession,
  takeSnapshot,
  verifyProject,
  withDb,
} from "../src/core";

let dir: string;

function git(...args: string[]) {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const write = (name: string, content: string) => writeFileSync(join(dir, name), content);
const events = () => withDb(dir, (db) => recentEvents(db, 100).reverse());

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PcsError);
  expect((err as PcsError).code).toBe(code);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pcs-snap-"));
  git("init", "-q");
  git("config", "user.email", "t@t.dev");
  git("config", "user.name", "Test");
  write("a.txt", "one\n");
  write("b.txt", "two\n");
  git("add", "a.txt", "b.txt");
  git("commit", "-q", "-m", "initial");
  await initProject(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("taking a snapshot", () => {
  it("records HEAD, branch and content hashes, plus a verified event", async () => {
    write("a.txt", "changed\n");
    write("new.txt", "hello\n");
    const s = await takeSnapshot(dir);

    expect(s.head).toMatch(/^[0-9a-f]{40,64}$/);
    expect(s).toMatchObject({ kind: "manual", session_id: null, truncated: false });
    const byPath = Object.fromEntries(s.files.map((f) => [f.path, f]));
    expect(byPath["a.txt"]).toMatchObject({ kind: "file", sha256: sha("changed\n"), worktree: "M" });
    expect(byPath["new.txt"]).toMatchObject({ kind: "file", untracked: true, sha256: sha("hello\n"), size: 6 });

    const evt = (await events()).find((e) => e.type === "snapshot.taken")!;
    expect(evt).toMatchObject({ provenance: "verified", source: "pcs" });
    expect(JSON.parse(evt.payload)).toMatchObject({ snapshotId: s.id, digest: s.digest, fileCount: 2 });
    expect((await verifyProject(dir)).ok).toBe(true);
    expect((await getStatus(dir)).integrity.ok).toBe(true);
  });

  it("lists files inside new directories individually", async () => {
    mkdirSync(join(dir, "nested", "deep"), { recursive: true });
    write("nested/deep/file.txt", "x");
    const s = await takeSnapshot(dir);
    expect(s.files.map((f) => f.path)).toContain("nested/deep/file.txt");
  });

  it("marks deleted files as missing without a hash", async () => {
    unlinkSync(join(dir, "b.txt"));
    const s = await takeSnapshot(dir);
    expect(s.files.find((f) => f.path === "b.txt")).toMatchObject({ kind: "missing", sha256: null, worktree: "D" });
  });

  it("never opens sensitive files: name only, nothing of their content stored", async () => {
    write(".env", "API_KEY=SUPERSECRET_MARKER_12345\n");
    const s = await takeSnapshot(dir);
    expect(s.files.find((f) => f.path === ".env")).toMatchObject({
      sensitive: true,
      kind: "sensitive",
      sha256: null,
      size: null,
    });
    expect(JSON.stringify(s)).not.toContain("SUPERSECRET_MARKER_12345");
    const stored = await withDb(dir, (db) => JSON.stringify(db.prepare("SELECT files FROM snapshots").all()));
    expect(stored).not.toContain("SUPERSECRET_MARKER_12345");
  });

  it("does not follow symlinks (a link to a file outside the repo is never read)", async (ctx) => {
    const outside = join(tmpdir(), `pcs-outside-${Date.now()}.txt`);
    writeFileSync(outside, "OUTSIDE_MARKER_999");
    try {
      try {
        symlinkSync(outside, join(dir, "link.txt"));
      } catch {
        ctx.skip(); // creating symlinks needs privileges on some Windows setups
        return;
      }
      const s = await takeSnapshot(dir);
      expect(s.files.find((f) => f.path === "link.txt")).toMatchObject({ kind: "symlink", sha256: null });
      expect(JSON.stringify(s)).not.toContain(sha("OUTSIDE_MARKER_999"));
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("skips hashing files above the size cap and reports truncation above the file cap", async () => {
    write("big.txt", "0123456789");
    const capped = await observeSnapshot(dir, { maxHashBytes: 4 });
    expect(capped.files.find((f) => f.path === "big.txt")).toMatchObject({
      kind: "file",
      size: 10,
      sha256: null,
      note: "too-large",
    });

    write("c1.txt", "1");
    write("c2.txt", "2");
    const limited = await observeSnapshot(dir, { maxFiles: 2 });
    expect(limited.truncated).toBe(true);
    expect(limited.files).toHaveLength(2);
  });

  it("links a manual snapshot to the active session", async () => {
    const { session } = await startSession(dir, "claude");
    const s = await takeSnapshot(dir);
    expect(s.session_id).toBe(session.id);
  });
});

describe("integrity", () => {
  it("snapshots are immutable", async () => {
    await takeSnapshot(dir);
    await withDb(dir, (db) => {
      expect(() => db.exec("UPDATE snapshots SET head = 'x'")).toThrow(/immutable/);
      expect(() => db.exec("DELETE FROM snapshots")).toThrow(/immutable/);
    });
  });

  it("detects an edited snapshot even if the trigger is dropped", async () => {
    write("a.txt", "changed\n");
    await takeSnapshot(dir);
    await withDb(dir, (db) => {
      db.exec("DROP TRIGGER snapshots_no_update");
      db.exec("UPDATE snapshots SET files = '[]'");
    });
    expect(await verifyProject(dir)).toMatchObject({ ok: false, reason: expect.stringMatching(/snapshot #1.*modified/) });
  });

  it("detects a deleted snapshot even if the trigger is dropped", async () => {
    await takeSnapshot(dir);
    await withDb(dir, (db) => {
      db.exec("DROP TRIGGER snapshots_no_delete");
      db.exec("DELETE FROM snapshots");
    });
    expect(await verifyProject(dir)).toMatchObject({ ok: false, reason: expect.stringMatching(/missing/) });
  });

  it("an observation failure is recorded as a verified event and returns no snapshot", async () => {
    const result = await withDb(dir, (db) =>
      inTransaction(db, () => recordObservation(db, { ok: false, error: "git exploded" }, "session_start", undefined)),
    );
    expect(result).toBeNull();
    const evt = (await events()).find((e) => e.type === "snapshot.failed")!;
    expect(evt).toMatchObject({ provenance: "verified", source: "pcs" });
    expect(evt.payload).toContain("git exploded");
    expect((await verifyProject(dir)).ok).toBe(true);
  });
});

describe("session snapshots and comparison", () => {
  it("snapshots automatically when a session starts and ends", async () => {
    const { session, snapshot: start } = await startSession(dir, "claude");
    const end = await endSession(dir);
    expect(start).toMatchObject({ kind: "session_start", session_id: session.id });
    expect(end.snapshot).toMatchObject({ kind: "session_end", session_id: session.id });
    expect((await listSnapshots(dir)).map((s) => s.kind)).toEqual(["session_end", "session_start"]);
  });

  it("shows what an interrupted agent actually did, and what the next agent committed", async () => {
    const { snapshot: s1 } = await startSession(dir, "claude"); // clean repo
    write("x.txt", "new");
    write("a.txt", "changed\n");
    const s2 = (await endSession(dir, { reason: "limit" })).snapshot!;

    const first = await compareSnapshots(dir, { from: s1!.id, to: s2.id });
    expect(first.added.map((f) => f.path)).toEqual(["a.txt", "x.txt"]);
    expect(first.added.find((f) => f.path === "x.txt")?.sha256).toBe(sha("new"));
    expect(first.head.changed).toBe(false);
    expect(first.commits).toEqual([]);

    // The next agent edits one file and commits the other.
    write("x.txt", "newer");
    git("add", "a.txt");
    git("commit", "-q", "-m", "agent commit");
    const s3 = await takeSnapshot(dir);

    const second = await compareSnapshots(dir); // default: the last two
    expect(second).toMatchObject({ from: s2.id, to: s3.id });
    expect(second.head.changed).toBe(true);
    expect(second.commits.map((c) => c.subject)).toEqual(["agent commit"]);
    expect(second.committedFiles).toEqual([{ status: "M", path: "a.txt" }]);
    expect(second.modified.map((m) => [m.path, m.contentChanged])).toEqual([["x.txt", true]]);
    expect(second.resolved.map((f) => f.path)).toEqual(["a.txt"]);
    expect(second.added).toEqual([]);

    const bySession = await compareSnapshots(dir, { session: 1 });
    expect(bySession).toMatchObject({ from: s1!.id, to: s2.id });
  });

  it("validates comparison input", async () => {
    await expectCode(compareSnapshots(dir), "INVALID_INPUT"); // none yet
    await takeSnapshot(dir);
    await expectCode(compareSnapshots(dir), "INVALID_INPUT"); // only one
    await expectCode(compareSnapshots(dir, { from: 1, to: 99 }), "INVALID_INPUT");
    await expectCode(compareSnapshots(dir, { from: 0 }), "INVALID_INPUT");
    await expectCode(compareSnapshots(dir, { from: 1.5 }), "INVALID_INPUT");
    await expectCode(compareSnapshots(dir, { session: 42 }), "INVALID_INPUT");
    await expectCode(listSnapshots(dir, 0), "INVALID_INPUT");
  });
});

describe("git history helpers", () => {
  it("reject anything that is not a full commit hash (no option injection)", async () => {
    const hash = "a".repeat(40);
    await expectCode(commitsBetween(dir, "--output=pwned", hash), "INVALID_INPUT");
    await expectCode(commitsBetween(dir, null, "HEAD"), "INVALID_INPUT");
    await expectCode(changedFilesBetween(dir, hash, "HEAD~1"), "INVALID_INPUT");
  });
});
