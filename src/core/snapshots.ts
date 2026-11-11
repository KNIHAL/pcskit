import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { requireInitializedRoot, withDb } from "./context";
import { inTransaction, type Db } from "./db";
import { PcsError } from "./errors";
import { canonicalJson, insertEvent, type ChainReport } from "./events";
import {
  changedFilesBetween,
  commitsBetween,
  getGitState,
  type ChangedFile,
  type CommitInfo,
  type CommittedFile,
} from "./git";

export const MAX_HASH_BYTES = 50 * 1024 * 1024;
export const MAX_SNAPSHOT_FILES = 5000;
const HASH_BATCH = 16;

export type SnapshotKind = "manual" | "session_start" | "session_end";

export interface SnapshotFile {
  path: string;
  /** Git status chars at observation time. */
  index: string;
  worktree: string;
  untracked: boolean;
  /** Sensitive files are listed by name only: PCS never opens them. */
  sensitive: boolean;
  /** What PCS found on disk (lstat; symlinks are never followed). */
  kind: "file" | "symlink" | "directory" | "missing" | "sensitive" | "other";
  size: number | null;
  /** SHA-256 of the working-tree content, or null (not hashed, see `note`). */
  sha256: string | null;
  note?: "too-large" | "unreadable";
}

export interface SnapshotData {
  taken_at: string;
  branch: string;
  head: string | null;
  files: SnapshotFile[];
  /** More changed files existed than the cap; the list is incomplete. */
  truncated: boolean;
}

export interface Snapshot extends SnapshotData {
  id: number;
  kind: SnapshotKind;
  session_id: number | null;
  digest: string;
}

export interface SnapshotSummary {
  id: number;
  taken_at: string;
  kind: SnapshotKind;
  session_id: number | null;
  branch: string;
  head: string | null;
  fileCount: number;
  truncated: boolean;
}

export type Observation = { ok: true; data: SnapshotData } | { ok: false; error: string };

interface SnapshotRow {
  id: number;
  ts: string;
  kind: SnapshotKind;
  session_id: number | null;
  branch: string;
  head: string | null;
  files: string;
  truncated: number;
  digest: string;
}

const COLUMNS = "id, ts, kind, session_id, branch, head, files, truncated, digest";

function sha256File(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const h = createHash("sha256");
    const s = createReadStream(path);
    s.on("error", fail);
    s.on("data", (chunk) => h.update(chunk));
    s.on("end", () => done(h.digest("hex")));
  });
}

async function describeFile(root: string, f: ChangedFile, maxHashBytes: number): Promise<SnapshotFile> {
  const base = {
    path: f.path,
    index: f.index,
    worktree: f.worktree,
    untracked: f.untracked,
    sensitive: f.sensitive,
  };
  // Never open files that commonly hold secrets.
  if (f.sensitive) return { ...base, kind: "sensitive", size: null, sha256: null };

  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, f.path);
  if (!abs.startsWith(rootAbs + sep)) return { ...base, kind: "other", size: null, sha256: null };

  let st;
  try {
    st = await lstat(abs); // lstat: a symlink pointing outside the repo is never followed
  } catch (err) {
    const code = (err as { code?: string }).code;
    const missing = code === "ENOENT" || code === "ENOTDIR";
    return { ...base, kind: missing ? "missing" : "other", size: null, sha256: null };
  }
  if (st.isSymbolicLink()) return { ...base, kind: "symlink", size: null, sha256: null };
  if (st.isDirectory()) return { ...base, kind: "directory", size: null, sha256: null };
  if (!st.isFile()) return { ...base, kind: "other", size: null, sha256: null };
  if (st.size > maxHashBytes) return { ...base, kind: "file", size: st.size, sha256: null, note: "too-large" };
  try {
    return { ...base, kind: "file", size: st.size, sha256: await sha256File(abs) };
  } catch {
    return { ...base, kind: "file", size: st.size, sha256: null, note: "unreadable" };
  }
}

export function digestOf(data: SnapshotData): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        ts: data.taken_at,
        branch: data.branch,
        head: data.head,
        files: data.files,
        truncated: data.truncated,
      }),
    )
    .digest("hex");
}

/** Observe the repository right now: git state plus a content hash for each changed file. No DB access. */
export async function observeSnapshot(
  cwd: string,
  opts: { maxHashBytes?: number; maxFiles?: number } = {},
): Promise<SnapshotData> {
  const maxHashBytes = opts.maxHashBytes ?? MAX_HASH_BYTES;
  const maxFiles = opts.maxFiles ?? MAX_SNAPSHOT_FILES;
  const taken_at = new Date().toISOString();
  const state = await getGitState(cwd);
  if (!state.isRepo) throw new PcsError("NOT_GIT_REPO", "Not inside a git repository.");

  const truncated = state.changed.length > maxFiles;
  const changed = state.changed.slice(0, maxFiles);
  const files: SnapshotFile[] = [];
  for (let i = 0; i < changed.length; i += HASH_BATCH) {
    const batch = changed.slice(i, i + HASH_BATCH);
    files.push(...(await Promise.all(batch.map((f) => describeFile(state.root, f, maxHashBytes)))));
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { taken_at, branch: state.branch, head: state.head?.hash ?? null, files, truncated };
}

/** Like observeSnapshot, but a git problem becomes a value so session start/end are never blocked. */
export async function tryObserve(cwd: string): Promise<Observation> {
  try {
    return { ok: true, data: await observeSnapshot(cwd) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "unknown error" };
  }
}

function toSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    kind: row.kind,
    session_id: row.session_id,
    taken_at: row.ts,
    branch: row.branch,
    head: row.head,
    files: JSON.parse(row.files) as SnapshotFile[],
    truncated: row.truncated !== 0,
    digest: row.digest,
  };
}

/** Persist an observation. Must run inside a transaction. The snapshot is `verified`: PCS observed it itself. */
export function insertSnapshot(db: Db, data: SnapshotData, kind: SnapshotKind, sessionId?: number): Snapshot {
  const digest = digestOf(data);
  const info = db
    .prepare(
      "INSERT INTO snapshots (ts, kind, session_id, branch, head, files, truncated, digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      data.taken_at,
      kind,
      sessionId ?? null,
      data.branch,
      data.head,
      JSON.stringify(data.files),
      data.truncated ? 1 : 0,
      digest,
    );
  const id = Number(info.lastInsertRowid);
  insertEvent(db, {
    type: "snapshot.taken",
    provenance: "verified",
    source: "pcs",
    ...(sessionId !== undefined ? { sessionId } : {}),
    payload: {
      snapshotId: id,
      kind,
      head: data.head,
      branch: data.branch,
      fileCount: data.files.length,
      truncated: data.truncated,
      digest,
    },
  });
  return { ...data, id, kind, session_id: sessionId ?? null, digest };
}

/** Record an observation, or the fact that observing failed. Must run inside a transaction. */
export function recordObservation(
  db: Db,
  obs: Observation,
  kind: SnapshotKind,
  sessionId?: number,
): Snapshot | null {
  if (obs.ok) return insertSnapshot(db, obs.data, kind, sessionId);
  insertEvent(db, {
    type: "snapshot.failed",
    provenance: "verified",
    source: "pcs",
    ...(sessionId !== undefined ? { sessionId } : {}),
    payload: { kind, error: obs.error },
  });
  return null;
}

function activeSessionId(db: Db): number | undefined {
  const row = db.prepare("SELECT id FROM sessions WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1").get() as
    | { id: number }
    | undefined;
  return row?.id;
}

export async function takeSnapshot(cwd: string, kind: SnapshotKind = "manual"): Promise<Snapshot> {
  const root = await requireInitializedRoot(cwd);
  const data = await observeSnapshot(root);
  return withDb(root, (db) => inTransaction(db, () => insertSnapshot(db, data, kind, activeSessionId(db))));
}

function getSnapshotById(db: Db, id: number): Snapshot {
  const row = db.prepare(`SELECT ${COLUMNS} FROM snapshots WHERE id = ?`).get(id) as SnapshotRow | undefined;
  if (!row) throw new PcsError("INVALID_INPUT", `Snapshot #${id} not found.`);
  return toSnapshot(row);
}

export async function listSnapshots(cwd: string, limit = 20): Promise<SnapshotSummary[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new PcsError("INVALID_INPUT", "Limit must be an integer between 1 and 1000.");
  }
  return withDb(cwd, (db) =>
    (db.prepare(`SELECT ${COLUMNS} FROM snapshots ORDER BY id DESC LIMIT ?`).all(limit) as unknown as SnapshotRow[])
      .map(toSnapshot)
      .map((s) => ({
        id: s.id,
        taken_at: s.taken_at,
        kind: s.kind,
        session_id: s.session_id,
        branch: s.branch,
        head: s.head,
        fileCount: s.files.length,
        truncated: s.truncated,
      })),
  );
}

export interface SnapshotDiff {
  from: number;
  to: number;
  head: { from: string | null; to: string | null; changed: boolean };
  branch: { from: string; to: string; changed: boolean };
  /** Differ from HEAD in `to` but were not listed in `from`. */
  added: SnapshotFile[];
  /** Listed in both, but content or git status changed. */
  modified: { path: string; before: SnapshotFile; after: SnapshotFile; contentChanged: boolean; statusChanged: boolean }[];
  /** Listed in `from`, no longer differ from HEAD in `to` (committed, reverted or stashed). */
  resolved: SnapshotFile[];
  unchanged: number;
  /** One of the snapshots hit the file cap, so added/resolved may be incomplete. */
  incomplete: boolean;
}

export interface SnapshotComparison extends SnapshotDiff {
  /** Commits made between the two HEADs (observed from git). */
  commits: CommitInfo[];
  committedFiles: CommittedFile[];
  /** Set when git history between the two HEADs could not be read. */
  historyNote?: string;
}

/** Pure comparison of two snapshots. */
export function diffSnapshots(a: Snapshot, b: Snapshot): SnapshotDiff {
  const am = new Map(a.files.map((f) => [f.path, f]));
  const bm = new Map(b.files.map((f) => [f.path, f]));
  const added: SnapshotFile[] = [];
  const modified: SnapshotDiff["modified"] = [];
  const resolved: SnapshotFile[] = [];
  let unchanged = 0;

  for (const [path, after] of bm) {
    const before = am.get(path);
    if (!before) {
      added.push(after);
      continue;
    }
    const contentChanged = before.sha256 !== after.sha256 || before.kind !== after.kind;
    const statusChanged = before.index !== after.index || before.worktree !== after.worktree;
    if (contentChanged || statusChanged) modified.push({ path, before, after, contentChanged, statusChanged });
    else unchanged++;
  }
  for (const [path, before] of am) if (!bm.has(path)) resolved.push(before);

  return {
    from: a.id,
    to: b.id,
    head: { from: a.head, to: b.head, changed: a.head !== b.head },
    branch: { from: a.branch, to: b.branch, changed: a.branch !== b.branch },
    added,
    modified,
    resolved,
    unchanged,
    incomplete: a.truncated || b.truncated,
  };
}

function checkId(label: string, n: number): void {
  if (!Number.isInteger(n) || n < 1) throw new PcsError("INVALID_INPUT", `${label} must be a positive integer.`);
}

/**
 * Compare snapshots and add what git says happened between their HEADs.
 * Defaults to the last two snapshots; `session` compares that session's first and last.
 */
export async function compareSnapshots(
  cwd: string,
  opts: { from?: number; to?: number; session?: number } = {},
): Promise<SnapshotComparison> {
  const root = await requireInitializedRoot(cwd);
  const { a, b } = await withDb(root, (db) => {
    const idsOf = (sql: string, ...args: number[]) =>
      (db.prepare(sql).all(...args) as unknown as { id: number }[]).map((r) => r.id);
    let fromId: number;
    let toId: number;

    if (opts.session !== undefined) {
      checkId("Session id", opts.session);
      const ids = idsOf("SELECT id FROM snapshots WHERE session_id = ? ORDER BY id ASC", opts.session);
      if (ids.length < 2) {
        throw new PcsError("INVALID_INPUT", `Session #${opts.session} has fewer than 2 snapshots to compare.`);
      }
      fromId = ids[0]!;
      toId = ids[ids.length - 1]!;
    } else {
      if (opts.from !== undefined) checkId("From id", opts.from);
      if (opts.to !== undefined) checkId("To id", opts.to);
      const latest = idsOf("SELECT id FROM snapshots ORDER BY id DESC LIMIT 2");
      if (opts.from === undefined) {
        if (latest.length < 2) throw new PcsError("INVALID_INPUT", "Need at least 2 snapshots to compare.");
        fromId = latest[1]!;
        toId = latest[0]!;
      } else {
        if (latest.length < 1) throw new PcsError("INVALID_INPUT", "No snapshots yet.");
        fromId = opts.from;
        toId = opts.to ?? latest[0]!;
      }
    }
    return { a: getSnapshotById(db, fromId), b: getSnapshotById(db, toId) };
  });

  const diff = diffSnapshots(a, b);
  let commits: CommitInfo[] = [];
  let committedFiles: CommittedFile[] = [];
  let historyNote: string | undefined;
  if (diff.head.changed && b.head) {
    try {
      commits = await commitsBetween(root, a.head, b.head);
      if (a.head) committedFiles = await changedFilesBetween(root, a.head, b.head);
    } catch {
      historyNote = "git history between these snapshots could not be read (rewritten or pruned?)";
    }
  }
  return { ...diff, commits, committedFiles, ...(historyNote ? { historyNote } : {}) };
}

/**
 * Check every snapshot against the digest stored in its (hash-chained) event.
 * Detects edited or deleted snapshots even if the immutability triggers were dropped.
 */
export function verifySnapshots(db: Db): ChainReport {
  const fromEvents = new Map<number, { eventId: number; digest: string }>();
  for (const raw of db.prepare("SELECT id, payload FROM events WHERE type = 'snapshot.taken' ORDER BY id ASC").iterate()) {
    const r = raw as unknown as { id: number; payload: string };
    try {
      const p = JSON.parse(r.payload) as { snapshotId?: unknown; digest?: unknown };
      if (typeof p.snapshotId === "number" && typeof p.digest === "string") {
        fromEvents.set(p.snapshotId, { eventId: r.id, digest: p.digest });
      }
    } catch {
      /* a malformed payload would already break the event chain */
    }
  }

  let count = 0;
  const seen = new Set<number>();
  for (const raw of db.prepare(`SELECT ${COLUMNS} FROM snapshots ORDER BY id ASC`).iterate()) {
    const snap = toSnapshot(raw as unknown as SnapshotRow);
    count++;
    seen.add(snap.id);
    const ev = fromEvents.get(snap.id);
    if (!ev) return { ok: false, count, reason: `snapshot #${snap.id} has no matching event` };
    if (digestOf(snap) !== snap.digest || snap.digest !== ev.digest) {
      return {
        ok: false,
        count,
        brokenAt: ev.eventId,
        reason: `snapshot #${snap.id} does not match its recorded digest (modified)`,
      };
    }
  }
  for (const [snapshotId, ev] of fromEvents) {
    if (!seen.has(snapshotId)) {
      return { ok: false, count, brokenAt: ev.eventId, reason: `snapshot #${snapshotId} is missing (deleted)` };
    }
  }
  return { ok: true, count };
}
