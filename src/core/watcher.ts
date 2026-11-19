import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { requireInitializedRoot, withDb } from "./context";
import { inTransaction, pcsDir, type Db } from "./db";
import { PcsError } from "./errors";
import { insertEvent } from "./events";
import { activeSession } from "./sessions";
import { fingerprintOf } from "./testruns";
import { insertSnapshot, tryObserve } from "./snapshots";

export const LOCK_FILE = "watch.json";
export const STOP_FILE = "watch.stop";

export const WATCH_DEFAULTS = {
  /** Quiet time after the last change before a snapshot is taken. */
  debounceMs: 2000,
  /** A snapshot is taken at least this often while changes keep arriving. */
  maxWaitMs: 30_000,
  /** No file activity for this long, with a session open: recorded as `watch.stalled` (inferred). */
  stalledMs: 10 * 60_000,
  /** How often the stop request and the stalled condition are checked. */
  heartbeatMs: 2000,
} as const;

export interface WatchOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  stalledMs?: number;
  heartbeatMs?: number;
  /** Human-readable progress lines (the CLI prints them). */
  onLog?: (line: string) => void;
}

export interface WatcherHandle {
  /** Resolves once the file watchers are ready. */
  ready: Promise<void>;
  /** Resolves after the watcher stopped and recorded `watch.stopped`. */
  done: Promise<void>;
  stop(reason?: string): Promise<void>;
}

interface LockInfo {
  pid: number;
  started_at: string;
}

export interface WatcherState {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  /** A lock file exists but its process is gone (the watcher was killed). */
  stale: boolean;
}

function lockPath(root: string): string {
  return join(pcsDir(root), LOCK_FILE);
}
function stopPath(root: string): string {
  return join(pcsDir(root), STOP_FILE);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

function readLock(root: string): LockInfo | null {
  try {
    const v = JSON.parse(readFileSync(lockPath(root), "utf8")) as Partial<LockInfo>;
    if (Number.isInteger(v.pid) && typeof v.started_at === "string") return v as LockInfo;
  } catch {
    // missing or unreadable: treated as no lock
  }
  return null;
}

export function readWatcherState(root: string): WatcherState {
  const lock = readLock(root);
  if (!lock) return { running: false, pid: null, startedAt: null, stale: false };
  const alive = pidAlive(lock.pid);
  return { running: alive, pid: alive ? lock.pid : null, startedAt: lock.started_at, stale: !alive };
}

/** Where git appends a line on every commit, checkout and reset (worktrees and submodules included). */
function gitHeadLog(root: string): string | null {
  try {
    const dotGit = join(root, ".git");
    let gitDir = dotGit;
    if (statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      if (!m?.[1]) return null;
      gitDir = resolve(root, m[1].trim());
    }
    const log = join(gitDir, "logs", "HEAD");
    return existsSync(log) ? log : null;
  } catch {
    return null;
  }
}

function ignoredPath(root: string, path: string): boolean {
  const rel = isAbsolute(path) ? relative(root, path) : path;
  if (rel === "" || rel.startsWith("..")) return false;
  const parts = rel.split(/[\\/]/);
  return parts.includes(".git") || parts.includes(".pcs") || parts.includes("node_modules");
}

type Reason = "change" | "head" | "periodic" | "stop" | "stalled";

/**
 * Watch the project and record what a stopped agent leaves behind.
 * Files are only a trigger: what gets recorded is always a fresh git observation
 * (verified snapshot), never the file events themselves. A snapshot is only taken when
 * the observed repo state actually differs from the last one.
 */
export async function startWatcher(cwd: string, options: WatchOptions = {}): Promise<WatcherHandle> {
  const root = await requireInitializedRoot(cwd);
  const o = { ...WATCH_DEFAULTS, ...stripUndefined(options) };
  for (const [k, v] of Object.entries(o)) {
    if (k !== "onLog" && (typeof v !== "number" || !Number.isFinite(v) || v < 1)) {
      throw new PcsError("INVALID_INPUT", `${k} must be a positive number of milliseconds.`);
    }
  }
  const log = options.onLog ?? (() => undefined);

  const existing = readWatcherState(root);
  if (existing.running) {
    throw new PcsError("INVALID_INPUT", `A watcher is already running for this project (pid ${existing.pid}).`);
  }
  rmSync(stopPath(root), { force: true });
  writeFileSync(lockPath(root), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), {
    mode: 0o600,
  });

  const staleBefore = existing.stale;
  await withDb(root, (db) =>
    insertEvent(db, {
      type: "watch.started",
      provenance: "verified",
      source: "pcs",
      payload: {
        pid: process.pid,
        debounceMs: o.debounceMs,
        maxWaitMs: o.maxWaitMs,
        stalledMs: o.stalledMs,
        previousWatcherDied: staleBefore,
      },
    }),
  );

  let lastFingerprint: string | null = null;
  let snapshots = 0;
  let lastActivity = Date.now();
  let stalledReported = false;
  let pendingSince: number | null = null;
  let pendingReason: Reason = "change";
  let debounce: NodeJS.Timeout | null = null;
  let stopping = false;
  let chain: Promise<void> = Promise.resolve();

  // Baseline: the state when the watcher starts. Nothing is recorded for it.
  const base = await tryObserve(root);
  if (base.ok) lastFingerprint = fingerprintOf(base.data);

  const flush = (reason: Reason): Promise<void> => {
    chain = chain.catch(() => undefined).then(async () => {
      pendingSince = null;
      const obs = await tryObserve(root);
      if (!obs.ok) {
        log(`observation failed: ${obs.error}`);
        await withDb(root, (db) =>
          insertEvent(db, {
            type: "watch.failed",
            provenance: "verified",
            source: "pcs",
            payload: { error: obs.error, reason },
          }),
        );
        return;
      }
      const fp = fingerprintOf(obs.data);
      if (fp === lastFingerprint) return;
      await withDb(root, (db: Db) =>
        inTransaction(db, () => {
          const sid = activeSession(db)?.id;
          const snap = insertSnapshot(db, obs.data, "manual", sid);
          insertEvent(db, {
            type: "watch.snapshot",
            provenance: "verified",
            source: "pcs",
            ...(sid !== undefined ? { sessionId: sid } : {}),
            payload: { snapshotId: snap.id, reason, files: obs.data.files.length, head: obs.data.head },
          });
        }),
      );
      lastFingerprint = fp;
      snapshots += 1;
      log(`snapshot recorded (${reason}, ${obs.data.files.length} changed file(s))`);
    });
    return chain;
  };

  const schedule = (reason: Reason) => {
    if (stopping) return;
    lastActivity = Date.now();
    stalledReported = false;
    if (reason === "head") pendingReason = "head";
    else if (pendingSince === null) pendingReason = "change";
    const now = Date.now();
    if (pendingSince === null) pendingSince = now;
    if (debounce) clearTimeout(debounce);
    const wait = Math.min(o.debounceMs, Math.max(0, pendingSince + o.maxWaitMs - now));
    debounce = setTimeout(() => {
      debounce = null;
      void flush(pendingReason).catch((e: unknown) => log(`error: ${(e as Error).message}`));
    }, wait);
  };

  const watchers: FSWatcher[] = [];
  const files = chokidarWatch(root, {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (p: string) => ignoredPath(root, p),
  });
  files.on("all", () => schedule("change"));
  files.on("error", (e) => log(`watcher error: ${(e as Error).message}`));
  watchers.push(files);

  const headLog = gitHeadLog(root);
  if (headLog) {
    const head = chokidarWatch(headLog, { ignoreInitial: true, followSymlinks: false });
    head.on("all", () => schedule("head"));
    head.on("error", (e) => log(`watcher error: ${(e as Error).message}`));
    watchers.push(head);
  }

  const ready = Promise.all(watchers.map((w) => new Promise<void>((r) => w.once("ready", () => r())))).then(() =>
    log(`watching ${root}`),
  );

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  let stopped: Promise<void> | null = null;

  const stop = (reason = "requested"): Promise<void> => {
    if (stopped) return stopped;
    stopping = true;
    stopped = (async () => {
      clearInterval(heartbeat);
      if (debounce) clearTimeout(debounce);
      await ready.catch(() => undefined);
      await Promise.all(watchers.map((w) => w.close().catch(() => undefined)));
      await flush("stop").catch((e: unknown) => log(`error: ${(e as Error).message}`));
      try {
        await withDb(root, (db) =>
          insertEvent(db, {
            type: "watch.stopped",
            provenance: "verified",
            source: "pcs",
            payload: { reason, snapshots },
          }),
        );
      } catch (e) {
        log(`could not record watch.stopped: ${(e as Error).message}`);
      } finally {
        rmSync(lockPath(root), { force: true });
        rmSync(stopPath(root), { force: true });
        log("watcher stopped");
        resolveDone();
      }
    })();
    return stopped;
  };

  const heartbeat = setInterval(() => {
    if (stopping) return;
    if (existsSync(stopPath(root))) {
      void stop("stop requested").catch((e: unknown) => log(`error: ${(e as Error).message}`));
      return;
    }
    if (!stalledReported && pendingSince === null && Date.now() - lastActivity >= o.stalledMs) {
      stalledReported = true;
      const idleMs = Date.now() - lastActivity;
      void flush("stalled")
        .then(() =>
          withDb(root, (db) => {
            const s = activeSession(db);
            if (!s) return;
            insertEvent(db, {
              type: "watch.stalled",
              provenance: "inferred",
              source: "pcs",
              sessionId: s.id,
              payload: { idleMs, agent: s.agent },
            });
            log(`no file activity for ${Math.round(idleMs / 1000)}s while session #${s.id} is open`);
          }),
        )
        .catch((e: unknown) => log(`error: ${(e as Error).message}`));
    }
  }, o.heartbeatMs);

  return { ready, done, stop };
}

/** Ask a running watcher (another process) to stop. Returns false when none is running. */
export async function requestStop(cwd: string): Promise<{ requested: boolean; stale: boolean }> {
  const root = await requireInitializedRoot(cwd);
  const state = readWatcherState(root);
  if (!state.running) {
    if (state.stale) rmSync(lockPath(root), { force: true });
    return { requested: false, stale: state.stale };
  }
  writeFileSync(stopPath(root), "stop\n", { mode: 0o600 });
  return { requested: true, stale: false };
}

export async function watcherState(cwd: string): Promise<WatcherState> {
  return readWatcherState(await requireInitializedRoot(cwd));
}

export interface WatchSummary {
  snapshots: number;
  lastSnapshotAt: string | null;
  stalledAt: string | null;
  stalledIdleMs: number | null;
}

/** What the watcher recorded since `sinceTs` (usually the start of the session in scope). */
export function watchSummary(db: Db, sinceTs: string, sessionId: number | null): WatchSummary {
  const snaps = db
    .prepare("SELECT COUNT(*) AS n, MAX(ts) AS last FROM events WHERE type = 'watch.snapshot' AND ts >= ?")
    .get(sinceTs) as { n: number; last: string | null };
  const stalled =
    sessionId === null
      ? undefined
      : (db
          .prepare("SELECT ts, payload FROM events WHERE type = 'watch.stalled' AND session_id = ? ORDER BY id DESC LIMIT 1")
          .get(sessionId) as { ts: string; payload: string } | undefined);
  let idle: number | null = null;
  if (stalled) {
    try {
      const v = (JSON.parse(stalled.payload) as { idleMs?: unknown }).idleMs;
      if (typeof v === "number") idle = v;
    } catch {
      // ignore
    }
  }
  return {
    snapshots: snaps.n,
    lastSnapshotAt: snaps.last,
    stalledAt: stalled?.ts ?? null,
    stalledIdleMs: idle,
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
