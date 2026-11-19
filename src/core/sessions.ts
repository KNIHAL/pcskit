import { requireInitializedRoot, withDb } from "./context";
import { inTransaction, type Db } from "./db";
import { PcsError } from "./errors";
import { insertEvent } from "./events";
import { redactText } from "./redact";
import { recordObservation, tryObserve, type Snapshot } from "./snapshots";

/** Reasons a person/agent may report when ending a session. "interrupted" is only ever inferred by PCS. */
export const END_REASONS = ["completed", "limit", "switched"] as const;
export type EndReason = (typeof END_REASONS)[number];

export interface Session {
  id: number;
  agent: string;
  started_at: string;
  ended_at: string | null;
  end_reason: EndReason | "interrupted" | null;
}

const SELECT = "SELECT id, agent, started_at, ended_at, end_reason FROM sessions";
const MAX_NOTE = 2000;
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/ -]{0,63}$/;

export function validateAgentName(name: string): string {
  const n = name.trim();
  if (!AGENT_RE.test(n)) {
    throw new PcsError(
      "INVALID_INPUT",
      "Agent name must be 1-64 characters: letters, digits and . _ : @ / - (spaces allowed inside).",
    );
  }
  return n;
}

export function activeSession(db: Db): Session | null {
  const row = db.prepare(`${SELECT} WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1`).get() as
    | Session
    | undefined;
  return row ?? null;
}

export interface StartResult {
  session: Session;
  /** A previous session that was never ended; PCS marked it interrupted. */
  interrupted: Session | null;
  /** Verified snapshot of the repo as the new agent found it; null if observing failed (a snapshot.failed event is recorded). */
  snapshot: Snapshot | null;
}

/**
 * Start a session for an agent. If a session is still open (the previous agent hit a
 * limit or crashed without ending it), PCS closes it as "interrupted" and says so
 * as an *inferred* event: PCS did not observe the interruption, it concluded it.
 * The snapshot taken here is the evidence of what the previous agent left behind.
 */
export async function startSession(cwd: string, agent: string): Promise<StartResult> {
  const name = validateAgentName(agent);
  const root = await requireInitializedRoot(cwd);
  const observation = await tryObserve(root);

  return withDb(root, (db) =>
    inTransaction(db, () => {
      const now = new Date().toISOString();
      let interrupted: Session | null = null;

      const open = activeSession(db);
      if (open) {
        db.prepare("UPDATE sessions SET ended_at = ?, end_reason = 'interrupted' WHERE id = ?").run(now, open.id);
        interrupted = { ...open, ended_at: now, end_reason: "interrupted" };
        insertEvent(db, {
          type: "session.interrupted",
          provenance: "inferred",
          source: "pcs",
          sessionId: open.id,
          payload: { agent: open.agent, reason: "a new session started before this one was ended" },
        });
      }

      const info = db.prepare("INSERT INTO sessions (agent, started_at) VALUES (?, ?)").run(name, now);
      const id = Number(info.lastInsertRowid);
      insertEvent(db, {
        type: "session.started",
        provenance: "reported",
        source: name,
        sessionId: id,
        payload: { agent: name },
      });
      const snapshot = recordObservation(db, observation, "session_start", id);
      const session: Session = { id, agent: name, started_at: now, ended_at: null, end_reason: null };
      return { session, interrupted, snapshot };
    }),
  );
}

export type EndResult = Session & { snapshot: Snapshot | null };

export async function endSession(cwd: string, opts: { reason?: string; note?: string } = {}): Promise<EndResult> {
  const reason = opts.reason ?? "completed";
  if (!(END_REASONS as readonly string[]).includes(reason)) {
    throw new PcsError("INVALID_INPUT", `Invalid reason "${reason}". Use: ${END_REASONS.join(", ")}.`);
  }
  const root = await requireInitializedRoot(cwd);
  const note = opts.note ? redactText(opts.note.trim()).text.slice(0, MAX_NOTE) : undefined;

  const noActive = () =>
    new PcsError("INVALID_INPUT", "No active session. Start one with `pcs session start --agent <name>`.");
  if (!(await withDb(root, (db) => activeSession(db)))) throw noActive();
  const observation = await tryObserve(root);

  return withDb(root, (db) =>
    inTransaction(db, () => {
      const open = activeSession(db);
      if (!open) throw noActive();
      const now = new Date().toISOString();
      db.prepare("UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?").run(now, reason, open.id);
      const snapshot = recordObservation(db, observation, "session_end", open.id);
      insertEvent(db, {
        type: "session.ended",
        provenance: "reported",
        source: open.agent,
        sessionId: open.id,
        payload: { reason, ...(note ? { note } : {}) },
      });
      return { ...open, ended_at: now, end_reason: reason as EndReason, snapshot };
    }),
  );
}

export async function currentSession(cwd: string): Promise<Session | null> {
  return withDb(cwd, (db) => activeSession(db));
}

export async function listSessions(cwd: string, limit = 20): Promise<Session[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new PcsError("INVALID_INPUT", "Limit must be an integer between 1 and 1000.");
  }
  return withDb(
    cwd,
    (db) => db.prepare(`${SELECT} ORDER BY id DESC LIMIT ?`).all(limit) as unknown as Session[],
  );
}
