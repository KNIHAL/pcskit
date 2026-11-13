import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { requireInitializedRoot, withDb } from "./context";
import { inTransaction } from "./db";
import { PcsError } from "./errors";
import { insertEvent, type ChainReport } from "./events";
import { buildHandoff, createHandoff, renderHandoff } from "./handoff";
import { verifyIntegrity } from "./integrity";
import { cap, code, oneLine, short, tag } from "./markdown";
import { activeSession, startSession, validateAgentName, type Session } from "./sessions";
import { compareSnapshots, takeSnapshot, type Snapshot, type SnapshotComparison } from "./snapshots";
import { fingerprintOf } from "./testruns";

const MAX_HANDOFF_BYTES = 2 * 1024 * 1024;
const MAX_LIST = 20;

/** What the handoff file looks like now compared with what PCS wrote. */
export type HandoffFileState = "intact" | "edited" | "missing" | "not-written";

interface HandoffRecord {
  eventId: number;
  ts: string;
  path: string | null;
  sha256: string;
  head: string | null;
  fingerprint: string | null;
  snapshotId: number | null;
  scopeSession: number | null;
  integrityOk: boolean;
}

export interface ResumeChecks {
  /** No handoff existed, so PCS generated this one at pickup (before the new session started). */
  generatedNow: boolean;
  handoffEventId: number;
  handoffTs: string;
  scopeSession: number | null;
  integrity: ChainReport;
  file: { state: HandoffFileState; path: string | null };
  /** null = could not be determined. */
  headMoved: boolean | null;
  treeChanged: boolean | null;
  /** What changed in the repo between the handoff's snapshot and the pickup snapshot. */
  drift: SnapshotComparison | null;
  driftNote: string | null;
  /** Earlier pickups of this same handoff (claims by those agents). */
  previousPickups: { agent: string; ts: string }[];
}

export interface ResumeResult {
  brief: string;
  checks: ResumeChecks;
  session: Session;
  /** A session that was never ended and was marked interrupted by this pickup (inferred). */
  interrupted: Session | null;
  /** The handoff body: the file when it is intact, otherwise one rebuilt from the evidence log. */
  handoffMarkdown: string;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function parseRecord(row: { id: number; ts: string; payload: string }): HandoffRecord {
  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    /* chain verification reports malformed events */
  }
  return {
    eventId: row.id,
    ts: row.ts,
    path: asString(p.path),
    sha256: asString(p.sha256) ?? "",
    head: asString(p.head),
    fingerprint: asString(p.fingerprint),
    snapshotId: asNumber(p.snapshotId),
    scopeSession: asNumber(p.scopeSession),
    integrityOk: p.integrityOk === true,
  };
}

/** Read the handoff file PCS wrote and check it still matches the SHA-256 recorded in the log. */
function checkFile(root: string, rec: HandoffRecord): { state: HandoffFileState; content: string | null } {
  if (rec.path === null) return { state: "not-written", content: null };
  const abs = isAbsolute(rec.path) ? rec.path : join(root, rec.path);
  let content: string;
  try {
    if (statSync(abs).size > MAX_HANDOFF_BYTES) return { state: "edited", content: null };
    content = readFileSync(abs, "utf8");
  } catch {
    return { state: "missing", content: null };
  }
  const intact = createHash("sha256").update(content).digest("hex") === rec.sha256;
  return intact ? { state: "intact", content } : { state: "edited", content: null };
}

/**
 * Pick up a handoff. Takes a verified snapshot of the repo as the new agent finds it, compares it with
 * the snapshot the handoff was written from, checks the handoff file and the log, then records two
 * events: `handoff.checked` (verified: PCS ran the checks) and `handoff.picked_up` (reported: the
 * agent says it took over).
 *
 * `agent` starts a session for that agent (an unended session becomes `interrupted`); without it, the
 * pickup is attributed to the session that is already active.
 */
export async function resume(cwd: string, opts: { agent?: string | undefined } = {}): Promise<ResumeResult> {
  const agent = opts.agent === undefined ? undefined : validateAgentName(opts.agent);
  const root = await requireInitializedRoot(cwd);

  // Nobody wrote a handoff (the previous agent died first): PCS writes one now, from the evidence log, and BEFORE
  // the new session starts, so it describes the session that stopped. Refuse first if we do not know who is picking up.
  const known = await withDb(root, (db) => ({
    hasHandoff: db.prepare("SELECT 1 FROM events WHERE type = 'handoff.generated' LIMIT 1").get() !== undefined,
    active: activeSession(db),
  }));
  if (agent === undefined && !known.active) {
    throw new PcsError("INVALID_INPUT", "Say who is picking up: `pcs resume --agent <name>`.");
  }
  let generatedNow = false;
  if (!known.hasHandoff) {
    await createHandoff(root, {});
    generatedNow = true;
  }

  // Refuse before changing anything.
  const pre = await withDb(root, (db) => {
    const row = db
      .prepare("SELECT id, ts, payload FROM events WHERE type = 'handoff.generated' ORDER BY id DESC LIMIT 1")
      .get() as { id: number; ts: string; payload: string } | undefined;
    if (!row) {
      throw new PcsError("INVALID_INPUT", "No handoff exists yet. The previous agent (or you) should run `pcs handoff` first.");
    }
    const active = activeSession(db);
    if (agent === undefined && !active) {
      throw new PcsError("INVALID_INPUT", "Say who is picking up: `pcs resume --agent <name>`.");
    }
    const pickups: { agent: string; ts: string }[] = [];
    for (const raw of db
      .prepare("SELECT ts, source, payload FROM events WHERE type = 'handoff.picked_up' ORDER BY id ASC")
      .iterate()) {
      const r = raw as unknown as { ts: string; source: string; payload: string };
      try {
        if ((JSON.parse(r.payload) as { handoffEventId?: unknown }).handoffEventId === row.id) {
          pickups.push({ agent: r.source, ts: r.ts });
        }
      } catch {
        /* ignore */
      }
    }
    return { rec: parseRecord(row), active, pickups };
  });
  const rec = pre.rec;

  // The state the new agent finds, observed before it touches anything.
  let session: Session;
  let interrupted: Session | null = null;
  let pickup: Snapshot | null;
  if (agent !== undefined) {
    const started = await startSession(root, agent);
    session = started.session;
    interrupted = started.interrupted;
    pickup = started.snapshot;
  } else {
    session = pre.active!;
    try {
      pickup = await takeSnapshot(root);
    } catch {
      pickup = null;
    }
  }

  let drift: SnapshotComparison | null = null;
  let driftNote: string | null = null;
  if (!pickup) driftNote = "PCS could not observe the repository now, so changes since the handoff are unknown.";
  else if (rec.snapshotId === null) driftNote = "The handoff did not record a snapshot to compare with.";
  else {
    try {
      drift = await compareSnapshots(root, { from: rec.snapshotId, to: pickup.id });
    } catch (err) {
      driftNote = `Comparison with the handoff's snapshot failed: ${err instanceof Error ? err.message : "unknown error"}`;
    }
  }
  const currentFp = pickup ? fingerprintOf(pickup) : null;
  const headMoved = pickup ? pickup.head !== rec.head : null;
  const treeChanged = currentFp !== null && rec.fingerprint !== null ? currentFp !== rec.fingerprint : null;

  const file = checkFile(root, rec);
  let handoffMarkdown: string;
  if (file.content !== null) handoffMarkdown = file.content;
  else {
    // Never present an edited or missing file as the handoff: rebuild it from the evidence log.
    handoffMarkdown = renderHandoff(await buildHandoff(root, rec.scopeSession !== null ? { session: rec.scopeSession } : {}));
  }

  const integrity = await withDb(root, (db) =>
    inTransaction(db, () => {
      const result = verifyIntegrity(db);
      insertEvent(db, {
        type: "handoff.checked",
        provenance: "verified",
        source: "pcs",
        sessionId: session.id,
        payload: {
          handoffEventId: rec.eventId,
          file: file.state,
          headMoved,
          treeChanged,
          commitsSince: drift ? drift.commits.length : null,
          integrityOk: result.ok,
          ...(driftNote ? { driftNote } : {}),
        },
      });
      insertEvent(db, {
        type: "handoff.picked_up",
        provenance: "reported",
        source: session.agent,
        sessionId: session.id,
        payload: { handoffEventId: rec.eventId, sha256: rec.sha256, session: session.id },
      });
      return result;
    }),
  );

  const checks: ResumeChecks = {
    generatedNow,
    handoffEventId: rec.eventId,
    handoffTs: rec.ts,
    scopeSession: rec.scopeSession,
    integrity,
    file: { state: file.state, path: rec.path },
    headMoved,
    treeChanged,
    drift,
    driftNote,
    previousPickups: pre.pickups,
  };
  const brief = renderBrief(checks, session, interrupted, handoffMarkdown, rec);
  return { brief, checks, session, interrupted, handoffMarkdown };
}

function renderBrief(
  c: ResumeChecks,
  session: Session,
  interrupted: Session | null,
  handoffMarkdown: string,
  rec: HandoffRecord,
): string {
  const L: string[] = [];
  L.push("# PCS resume brief", "");
  L.push("You are picking up work that PCS recorded. Read the checks first, then the handoff below them.", "");

  if (!c.integrity.ok) {
    L.push(
      `**WARNING: INTEGRITY FAILURE${c.integrity.brokenAt !== undefined ? ` at event #${c.integrity.brokenAt}` : ""}: ${oneLine(c.integrity.reason ?? "unknown", 200)}.** The recorded history may have been altered. Do not rely on the evidence below until it is investigated.`,
      "",
    );
  }
  const drifted = c.headMoved === true || c.treeChanged === true;
  if (drifted) {
    L.push(
      "**WARNING: the repository changed since this handoff was written.** The \"Files touched\" and \"Tests\" sections of the handoff describe the earlier state. Re-check before you build on them.",
      "",
    );
  }

  L.push("## Pickup checks", "", "These were run by PCS just now.", "");
  L.push(
    `- ${tag("verified")} Integrity of the log: ${c.integrity.ok ? `OK (${c.integrity.count} events, hash chain, snapshots and test runs verified)` : "FAILED (see above)"}.`,
  );
  L.push(
    `- ${tag("verified")} Handoff: event #${c.handoffEventId}, written ${c.handoffTs}${c.scopeSession !== null ? ` for session #${c.scopeSession}` : ""}${rec.integrityOk ? "" : "; the integrity check had ALREADY failed when it was written"}.`,
  );
  if (c.generatedNow) {
    L.push(`- ${tag("verified")} Nobody wrote a handoff before the last agent stopped, so PCS generated this one just now from the evidence log (git, snapshots, test runs, notes), before your session started.`);
  }
  const fileLine: Record<string, string> = {
    intact: `intact (matches the SHA-256 PCS recorded when it wrote ${code(c.file.path ?? "", 200)}).`,
    edited: `EDITED after PCS wrote it (${code(c.file.path ?? "", 200)} no longer matches the recorded SHA-256). It was not used: the handoff below was rebuilt from the evidence log.`,
    missing: `missing (${code(c.file.path ?? "", 200)} could not be read). The handoff below was rebuilt from the evidence log.`,
    "not-written": "not written (it was only printed). The handoff below was rebuilt from the evidence log.",
  };
  L.push(`- ${tag("verified")} Handoff file: ${fileLine[c.file.state]}`);

  if (c.headMoved === null) L.push(`- ${tag("verified")} Repo since the handoff: unknown. ${oneLine(c.driftNote ?? "", 300)}`);
  else {
    L.push(
      `- ${tag("verified")} HEAD: ${c.headMoved ? `moved from ${code(short(rec.head))} to a newer commit` : `unchanged at ${code(short(rec.head))}`}. Working tree: ${c.treeChanged === null ? "could not be compared" : c.treeChanged ? "differs from the handoff" : "same as the handoff"}.`,
    );
    if (c.drift) {
      const d = c.drift;
      if (d.commits.length === 0 && d.added.length === 0 && d.modified.length === 0 && d.resolved.length === 0 && !c.headMoved) {
        L.push("  - Repo is exactly as the handoff left it.");
      }
      const cm = cap(d.commits, 10);
      for (const k of cm.shown) L.push(`  - commit ${code(short(k.hash))} ${code(k.subject, 200)}`);
      if (cm.more > 0) L.push(`  - ...and ${cm.more} more commit(s)`);
      const list = (label: string, paths: string[]) => {
        if (paths.length === 0) return;
        const p = cap(paths, MAX_LIST);
        L.push(`  - ${label}: ${p.shown.map((x) => code(x, 200)).join(", ")}${p.more > 0 ? `, ...and ${p.more} more` : ""}`);
      };
      list("newly uncommitted since the handoff", d.added.map((f) => f.path));
      list("edited again since the handoff", d.modified.map((m) => m.path));
      list("no longer uncommitted (committed, reverted or stashed)", d.resolved.map((f) => f.path));
      if (d.historyNote) L.push(`  - Note: ${oneLine(d.historyNote, 300)}`);
    } else if (c.driftNote) {
      L.push(`  - Note: ${oneLine(c.driftNote, 300)}`);
    }
  }

  L.push(`- ${tag("verified")} You are session #${session.id} (${code(session.agent, 64)}).`);
  if (interrupted) {
    L.push(
      `- ${tag("inferred")} Session #${interrupted.id} (${code(interrupted.agent, 64)}) was never ended; marked interrupted. Its last actions may be incomplete.`,
    );
  }
  for (const p of c.previousPickups) {
    L.push(`- ${tag("reported", p.agent)} This handoff was already picked up by ${code(p.agent, 64)} at ${p.ts}.`);
  }

  L.push(
    "",
    "## Before you continue",
    "",
    "1. Treat reported and inferred lines as leads, not facts. Re-run the tests with `pcs test -- <command>`; earlier results may be stale.",
    "2. Record progress as you go: `pcs task update`, `pcs note add issue|avoid|next ...`.",
    "3. When you stop: `pcs session end --reason <completed|limit|switched> --note \"where you stopped\"`, add `pcs note add next ...`, then `pcs handoff`.",
    "",
    "---",
    "",
    handoffMarkdown.trimEnd(),
    "",
  );
  return L.join("\n");
}
