import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { requireInitializedRoot, withDb } from "./context";
import { inTransaction, type Db } from "./db";
import { PcsError } from "./errors";
import { canonicalJson, insertEvent, type ChainReport } from "./events";
import { relativeToRoot } from "./git";
import { redactText } from "./redact";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, runCommand, validateArgv, type RunOutcome } from "./runner";
import { activeSession, validateAgentName } from "./sessions";
import { tryObserve, type SnapshotData } from "./snapshots";

/** How much of a run's output is stored (the tail), after redaction. */
export const MAX_OUTPUT_CHARS = 8192;

export interface TestRun {
  id: number;
  /** When PCS started the command. */
  ts: string;
  session_id: number | null;
  /** The command as an argument array (redacted). */
  argv: string[];
  /** Directory the command ran in, relative to the repo root ("" = root). */
  cwd: string;
  outcome: RunOutcome;
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  /** Tail of the combined stdout/stderr: sanitized, redacted, size-capped. */
  output: string;
  /** Raw bytes the command produced in total. */
  output_bytes: number;
  output_truncated: boolean;
  /** Git HEAD when the command started. */
  head: string | null;
  /** Hash of the working-tree state that was tested (HEAD + changed files and their content hashes). Null if observing failed. */
  tree_fingerprint: string | null;
  digest: string;
}

export interface TestRunSummary {
  id: number;
  ts: string;
  session_id: number | null;
  argv: string[];
  outcome: RunOutcome;
  exit_code: number | null;
  duration_ms: number;
  head: string | null;
}

export interface EvidenceSummary {
  run_id: number;
  outcome: RunOutcome;
  ts: string;
  head: string | null;
}

interface TestRunRow {
  id: number;
  ts: string;
  session_id: number | null;
  argv: string;
  cwd: string;
  outcome: RunOutcome;
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  output: string;
  output_bytes: number;
  output_truncated: number;
  head: string | null;
  tree_fingerprint: string | null;
  digest: string;
}

type RunData = Omit<TestRun, "id" | "digest">;

const COLUMNS =
  "id, ts, session_id, argv, cwd, outcome, exit_code, signal, duration_ms, output, output_bytes, output_truncated, head, tree_fingerprint, digest";

function toRun(row: TestRunRow): TestRun {
  return {
    id: row.id,
    ts: row.ts,
    session_id: row.session_id,
    argv: JSON.parse(row.argv) as string[],
    cwd: row.cwd,
    outcome: row.outcome,
    exit_code: row.exit_code,
    signal: row.signal,
    duration_ms: row.duration_ms,
    output: row.output,
    output_bytes: row.output_bytes,
    output_truncated: row.output_truncated !== 0,
    head: row.head,
    tree_fingerprint: row.tree_fingerprint,
    digest: row.digest,
  };
}

export function runDigest(d: RunData): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        ts: d.ts,
        session_id: d.session_id,
        argv: d.argv,
        cwd: d.cwd,
        outcome: d.outcome,
        exit_code: d.exit_code,
        signal: d.signal,
        duration_ms: d.duration_ms,
        output: d.output,
        output_bytes: d.output_bytes,
        output_truncated: d.output_truncated,
        head: d.head,
        tree_fingerprint: d.tree_fingerprint,
      }),
    )
    .digest("hex");
}

/** Identity of the repo state that was tested. Same HEAD + same changed files with same content = same fingerprint. */
export function fingerprintOf(data: SnapshotData): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        head: data.head,
        truncated: data.truncated,
        files: data.files.map((f) => ({
          path: f.path,
          index: f.index,
          worktree: f.worktree,
          kind: f.kind,
          sha256: f.sha256,
        })),
      }),
    )
    .digest("hex");
}

/** Persist a run and its chained `verified` event. Must run inside a transaction. */
function insertTestRun(db: Db, d: RunData): TestRun {
  const digest = runDigest(d);
  const info = db
    .prepare(
      `INSERT INTO test_runs (ts, session_id, argv, cwd, outcome, exit_code, signal, duration_ms, output, output_bytes, output_truncated, head, tree_fingerprint, digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      d.ts,
      d.session_id,
      JSON.stringify(d.argv),
      d.cwd,
      d.outcome,
      d.exit_code,
      d.signal,
      d.duration_ms,
      d.output,
      d.output_bytes,
      d.output_truncated ? 1 : 0,
      d.head,
      d.tree_fingerprint,
      digest,
    );
  const id = Number(info.lastInsertRowid);
  // PCS ran the command and watched the result itself, so this is `verified`.
  insertEvent(db, {
    type: "test.run",
    provenance: "verified",
    source: "pcs",
    ...(d.session_id !== null ? { sessionId: d.session_id } : {}),
    payload: {
      runId: id,
      argv: d.argv,
      outcome: d.outcome,
      exitCode: d.exit_code,
      signal: d.signal,
      durationMs: d.duration_ms,
      head: d.head,
      fingerprint: d.tree_fingerprint,
      digest,
    },
  });
  return { ...d, id, digest };
}

function linkSource(db: Db, explicit: string | undefined, sessionId: number | null): string {
  if (explicit !== undefined) return validateAgentName(explicit);
  if (sessionId !== null) {
    const row = db.prepare("SELECT agent FROM sessions WHERE id = ?").get(sessionId) as { agent: string } | undefined;
    if (row) return row.agent;
  }
  return "user";
}

/**
 * Point a task at a run. The run itself is verified evidence; *which task it backs* is a
 * claim by whoever links it, so that event is `reported`. Must run inside a transaction.
 */
function insertLink(db: Db, taskId: number, runId: number, source: string, sessionId: number | null): void {
  if (!db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId)) {
    throw new PcsError("INVALID_INPUT", `Task #${taskId} not found.`);
  }
  const run = db.prepare("SELECT outcome FROM test_runs WHERE id = ?").get(runId) as { outcome: RunOutcome } | undefined;
  if (!run) throw new PcsError("INVALID_INPUT", `Test run #${runId} not found.`);
  if (db.prepare("SELECT 1 AS x FROM task_evidence WHERE task_id = ? AND run_id = ?").get(taskId, runId)) {
    throw new PcsError("INVALID_INPUT", `Run #${runId} is already linked to task #${taskId}.`);
  }
  db.prepare("INSERT INTO task_evidence (task_id, run_id, ts) VALUES (?, ?, ?)").run(
    taskId,
    runId,
    new Date().toISOString(),
  );
  insertEvent(db, {
    type: "task.evidence_linked",
    provenance: "reported",
    source,
    ...(sessionId !== null ? { sessionId } : {}),
    payload: { taskId, runId, outcome: run.outcome },
  });
}

function checkId(label: string, n: number): void {
  if (!Number.isInteger(n) || n < 1) throw new PcsError("INVALID_INPUT", `${label} must be a positive integer.`);
}

export interface RunTestOptions {
  /** Link the run to this task as evidence. */
  taskId?: number | undefined;
  timeoutMs?: number | undefined;
  /** Who links the evidence (default: active session's agent, else user). */
  agent?: string | undefined;
  onOutput?: ((text: string, stream: "stdout" | "stderr") => void) | undefined;
}

export interface RunTestResult {
  run: TestRun;
  linkedTask: number | null;
}

/**
 * Run a command, observe the result, and record it as verified evidence.
 * Order matters: the repo is observed and the command is run *before* the DB is opened,
 * so a long test run never holds a database lock.
 */
export async function runTest(cwd: string, argvIn: readonly string[], opts: RunTestOptions = {}): Promise<RunTestResult> {
  const argv = validateArgv(argvIn);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new PcsError("INVALID_INPUT", `Timeout must be between 1 ms and ${MAX_TIMEOUT_MS / 1000} seconds.`);
  }
  if (opts.taskId !== undefined) checkId("Task id", opts.taskId);
  const agent = opts.agent === undefined ? undefined : validateAgentName(opts.agent);

  const root = await requireInitializedRoot(cwd);
  const runCwd = resolve(cwd);
  const relCwd = await relativeToRoot(runCwd);

  // Fail before running anything if the task to link does not exist.
  const sessionId = await withDb(root, (db) => {
    if (opts.taskId !== undefined && !db.prepare("SELECT id FROM tasks WHERE id = ?").get(opts.taskId)) {
      throw new PcsError("INVALID_INPUT", `Task #${opts.taskId} not found.`);
    }
    return activeSession(db)?.id ?? null;
  });

  const observation = await tryObserve(root);
  const ts = new Date().toISOString();
  const result = await runCommand(argv, { cwd: runCwd, timeoutMs, onOutput: opts.onOutput });

  const redacted = redactText(result.tail).text;
  const output = redacted.length > MAX_OUTPUT_CHARS ? redacted.slice(-MAX_OUTPUT_CHARS) : redacted;
  const data: RunData = {
    ts,
    session_id: sessionId,
    argv: argv.map((a) => redactText(a).text),
    cwd: relCwd,
    outcome: result.outcome,
    exit_code: result.exitCode,
    signal: result.signal,
    duration_ms: result.durationMs,
    output,
    output_bytes: result.totalBytes,
    output_truncated: result.totalChars > result.tail.length || redacted.length > MAX_OUTPUT_CHARS,
    head: observation.ok ? observation.data.head : null,
    tree_fingerprint: observation.ok ? fingerprintOf(observation.data) : null,
  };

  return withDb(root, (db) =>
    inTransaction(db, () => {
      const run = insertTestRun(db, data);
      if (opts.taskId !== undefined) {
        insertLink(db, opts.taskId, run.id, linkSource(db, agent, sessionId), sessionId);
      }
      return { run, linkedTask: opts.taskId ?? null };
    }),
  );
}

/** Link an existing run to a task as evidence. */
export async function linkEvidence(cwd: string, taskId: number, runId: number, agent?: string): Promise<void> {
  checkId("Task id", taskId);
  checkId("Run id", runId);
  const explicit = agent === undefined ? undefined : validateAgentName(agent);
  await withDb(cwd, (db) =>
    inTransaction(db, () => {
      const sessionId = activeSession(db)?.id ?? null;
      insertLink(db, taskId, runId, linkSource(db, explicit, sessionId), sessionId);
    }),
  );
}

export async function getTestRun(cwd: string, id: number): Promise<TestRun> {
  checkId("Run id", id);
  return withDb(cwd, (db) => {
    const row = db.prepare(`SELECT ${COLUMNS} FROM test_runs WHERE id = ?`).get(id) as unknown as TestRunRow | undefined;
    if (!row) throw new PcsError("INVALID_INPUT", `Test run #${id} not found.`);
    return toRun(row);
  });
}

export async function listTestRuns(cwd: string, limit = 20): Promise<TestRunSummary[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new PcsError("INVALID_INPUT", "Limit must be an integer between 1 and 1000.");
  }
  return withDb(cwd, (db) =>
    (db.prepare(`SELECT ${COLUMNS} FROM test_runs ORDER BY id DESC LIMIT ?`).all(limit) as unknown as TestRunRow[])
      .map(toRun)
      .map((r) => ({
        id: r.id,
        ts: r.ts,
        session_id: r.session_id,
        argv: r.argv,
        outcome: r.outcome,
        exit_code: r.exit_code,
        duration_ms: r.duration_ms,
        head: r.head,
      })),
  );
}

/** For each task, its most recent linked run. A task with no entry has no evidence. */
export function latestEvidenceByTask(db: Db): Map<number, EvidenceSummary> {
  const out = new Map<number, EvidenceSummary>();
  const rows = db
    .prepare(
      `SELECT e.task_id AS task_id, r.id AS run_id, r.outcome AS outcome, r.ts AS ts, r.head AS head
       FROM task_evidence e JOIN test_runs r ON r.id = e.run_id ORDER BY r.id ASC`,
    )
    .all() as unknown as ({ task_id: number } & EvidenceSummary)[];
  for (const r of rows) out.set(r.task_id, { run_id: r.run_id, outcome: r.outcome, ts: r.ts, head: r.head });
  return out;
}

export async function getTaskEvidence(cwd: string): Promise<Record<number, EvidenceSummary>> {
  return withDb(cwd, (db) => Object.fromEntries(latestEvidenceByTask(db)));
}

/**
 * Check every run against the digest stored in its (hash-chained) event, and every
 * task-evidence link against its event. Detects edited, deleted or forged evidence even
 * if the immutability triggers were dropped.
 */
export function verifyTestRuns(db: Db): ChainReport {
  const runEvents = new Map<number, { eventId: number; digest: string }>();
  const linkEvents = new Map<string, number>();
  for (const raw of db
    .prepare("SELECT id, type, payload FROM events WHERE type IN ('test.run', 'task.evidence_linked') ORDER BY id ASC")
    .iterate()) {
    const r = raw as unknown as { id: number; type: string; payload: string };
    try {
      const p = JSON.parse(r.payload) as { runId?: unknown; taskId?: unknown; digest?: unknown };
      if (r.type === "test.run") {
        if (typeof p.runId === "number" && typeof p.digest === "string") {
          runEvents.set(p.runId, { eventId: r.id, digest: p.digest });
        }
      } else if (typeof p.runId === "number" && typeof p.taskId === "number") {
        linkEvents.set(`${p.taskId}:${p.runId}`, r.id);
      }
    } catch {
      /* a malformed payload would already break the event chain */
    }
  }

  let count = 0;
  const seen = new Set<number>();
  for (const raw of db.prepare(`SELECT ${COLUMNS} FROM test_runs ORDER BY id ASC`).iterate()) {
    const run = toRun(raw as unknown as TestRunRow);
    count++;
    seen.add(run.id);
    const ev = runEvents.get(run.id);
    if (!ev) return { ok: false, count, reason: `test run #${run.id} has no matching event` };
    if (runDigest(run) !== run.digest || run.digest !== ev.digest) {
      return {
        ok: false,
        count,
        brokenAt: ev.eventId,
        reason: `test run #${run.id} does not match its recorded digest (modified)`,
      };
    }
  }
  for (const [runId, ev] of runEvents) {
    if (!seen.has(runId)) {
      return { ok: false, count, brokenAt: ev.eventId, reason: `test run #${runId} is missing (deleted)` };
    }
  }

  const links = new Set<string>();
  for (const raw of db.prepare("SELECT task_id, run_id FROM task_evidence ORDER BY id ASC").iterate()) {
    const l = raw as unknown as { task_id: number; run_id: number };
    const key = `${l.task_id}:${l.run_id}`;
    links.add(key);
    if (!linkEvents.has(key)) {
      return { ok: false, count, reason: `evidence link task #${l.task_id} -> run #${l.run_id} has no matching event (forged)` };
    }
    if (!seen.has(l.run_id)) {
      return { ok: false, count, reason: `evidence link task #${l.task_id} points at missing run #${l.run_id}` };
    }
  }
  for (const [key, eventId] of linkEvents) {
    if (!links.has(key)) {
      return { ok: false, count, brokenAt: eventId, reason: `evidence link ${key.replace(":", " -> run #")} was removed` };
    }
  }
  return { ok: true, count };
}
