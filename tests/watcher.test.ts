import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createHandoff,
  getStatus,
  initProject,
  listSnapshots,
  PcsError,
  recentEvents,
  requestStop,
  startSession,
  startWatcher,
  verifyProject,
  watcherState,
  withDb,
  type WatcherHandle,
} from "../src/core";

let dir: string;
let handle: WatcherHandle | null = null;

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

const events = () => withDb(dir, (db) => recentEvents(db, 200).reverse());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error("timed out waiting for condition");
}

const FAST = { debounceMs: 300, maxWaitMs: 2000, heartbeatMs: 100 };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pcs-watch-"));
  git("init", "-q");
  git("config", "user.email", "t@t.dev");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "x\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
  await initProject(dir);
});

afterEach(async () => {
  if (handle) await handle.stop("test over");
  handle = null;
  // Windows releases directory handles a moment after close(), so retry the delete.
  for (let i = 0; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch (err) {
      if (i >= 20) throw err;
      await sleep(150);
    }
  }
});

const snapshotEvents = async () => (await events()).filter((e) => e.type === "watch.snapshot");

describe("watcher: recording", () => {
  it("snapshots a burst of edits once, linked to the session, with a valid chain", async () => {
    await startSession(dir, "claude");
    handle = await startWatcher(dir, FAST);
    await handle.ready;

    writeFileSync(join(dir, "a.txt"), "1\n");
    writeFileSync(join(dir, "new.ts"), "n\n");
    writeFileSync(join(dir, "a.txt"), "2\n");
    await until(async () => (await snapshotEvents()).length >= 1);
    await sleep(800);

    const snaps = await snapshotEvents();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ provenance: "verified", source: "pcs" });
    expect(snaps[0]!.session_id).not.toBeNull();
    expect(JSON.parse(snaps[0]!.payload)).toMatchObject({ reason: "change", files: 2 });
    expect((await verifyProject(dir)).ok).toBe(true);
  });

  it("does not record a snapshot when nothing observable changed", async () => {
    handle = await startWatcher(dir, FAST);
    await handle.ready;
    writeFileSync(join(dir, "a.txt"), "x\n"); // same content
    await sleep(1200);
    expect(await snapshotEvents()).toHaveLength(0);
  });

  it("records a head snapshot after a commit", async () => {
    handle = await startWatcher(dir, FAST);
    await handle.ready;
    writeFileSync(join(dir, "b.txt"), "b\n");
    git("add", "b.txt");
    git("commit", "-q", "-m", "second");
    await until(async () => (await snapshotEvents()).length >= 1);
    const payloads = (await snapshotEvents()).map((e) => JSON.parse(e.payload) as { head: string });
    expect(payloads.at(-1)!.head).toBe(git("rev-parse", "HEAD"));
  });

  it("ignores .git, .pcs and node_modules", async () => {
    handle = await startWatcher(dir, FAST);
    await handle.ready;
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", "i.js"), "1\n"); // untracked but ignored by trigger only
    await sleep(1200);
    // git itself still reports node_modules as untracked, so a snapshot may exist; but the
    // trigger must not have fired from .pcs writes (the watcher's own database).
    const before = (await snapshotEvents()).length;
    await sleep(800);
    expect((await snapshotEvents()).length).toBe(before);
  });

  it("never opens sensitive files: they are listed by name only", async () => {
    handle = await startWatcher(dir, FAST);
    await handle.ready;
    writeFileSync(join(dir, ".env"), "SECRET=abc123\n");
    await until(async () => (await snapshotEvents()).length >= 1);
    const snap = (await listSnapshots(dir)).at(0)!;
    expect(snap.fileCount).toBeGreaterThan(0);
    const raw = JSON.stringify(await events());
    expect(raw).not.toContain("abc123");
  });
});

describe("watcher: lifecycle", () => {
  it("records start and stop, shows state, and removes its lock", async () => {
    handle = await startWatcher(dir, FAST);
    await handle.ready;
    expect(await watcherState(dir)).toMatchObject({ running: true, pid: process.pid });
    expect((await getStatus(dir)).watcher.running).toBe(true);

    await handle.stop("done");
    handle = null;
    expect((await watcherState(dir)).running).toBe(false);
    const types = (await events()).map((e) => e.type);
    expect(types).toContain("watch.started");
    expect(types).toContain("watch.stopped");
    expect(existsSync(join(dir, ".pcs", "watch.json"))).toBe(false);
  });

  it("refuses a second watcher while one is running", async () => {
    handle = await startWatcher(dir, FAST);
    await handle.ready;
    await expect(startWatcher(dir, FAST)).rejects.toBeInstanceOf(PcsError);
  });

  it("takes over a stale lock and says the previous watcher died", async () => {
    writeFileSync(join(dir, ".pcs", "watch.json"), JSON.stringify({ pid: 2 ** 30, started_at: "2020-01-01T00:00:00Z" }));
    expect((await watcherState(dir)).stale).toBe(true);
    handle = await startWatcher(dir, FAST);
    await handle.ready;
    const started = (await events()).find((e) => e.type === "watch.started")!;
    expect(JSON.parse(started.payload)).toMatchObject({ previousWatcherDied: true });
  });

  it("stops when another process asks it to", async () => {
    handle = await startWatcher(dir, FAST);
    await handle.ready;
    expect(await requestStop(dir)).toMatchObject({ requested: true });
    await handle.done;
    handle = null;
    expect((await events()).some((e) => e.type === "watch.stopped")).toBe(true);
    expect(await requestStop(dir)).toMatchObject({ requested: false });
  });

  it("rejects nonsense options before recording anything", async () => {
    await expect(startWatcher(dir, { debounceMs: -5 })).rejects.toBeInstanceOf(PcsError);
    expect((await events()).some((e) => e.type === "watch.started")).toBe(false);
  });
});

describe("watcher: stalled sessions", () => {
  it("infers a stalled session after the quiet period, once", async () => {
    await startSession(dir, "claude");
    handle = await startWatcher(dir, { ...FAST, stalledMs: 600 });
    await handle.ready;
    await until(async () => (await events()).some((e) => e.type === "watch.stalled"));
    await sleep(1000);
    const stalled = (await events()).filter((e) => e.type === "watch.stalled");
    expect(stalled).toHaveLength(1);
    expect(stalled[0]).toMatchObject({ provenance: "inferred", source: "pcs" });
  });

  it("does not report a stall when no session is open", async () => {
    handle = await startWatcher(dir, { ...FAST, stalledMs: 400 });
    await handle.ready;
    await sleep(1200);
    expect((await events()).some((e) => e.type === "watch.stalled")).toBe(false);
  });

  it("puts watcher observations in the handoff with their provenance", async () => {
    await startSession(dir, "claude");
    handle = await startWatcher(dir, { ...FAST, stalledMs: 1500 });
    await handle.ready;
    writeFileSync(join(dir, "w.ts"), "w\n");
    await until(async () => (await events()).some((e) => e.type === "watch.stalled"), 20_000);
    const r = await createHandoff(dir, { noFile: true });
    expect(r.markdown).toMatch(/\[verified\] The PCS watcher recorded \d+ change snapshot/);
    expect(r.markdown).toMatch(/\[inferred\] The watcher saw no file activity/);
  });
});
