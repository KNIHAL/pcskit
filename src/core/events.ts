import { createHash } from "node:crypto";
import { inTransaction, type Db } from "./db";
import { redactDeep } from "./redact";

/**
 * How trustworthy a recorded fact is:
 * - verified: PCS observed it itself (git state, test run it executed)
 * - reported: an agent or human claimed it; not independently checked
 * - inferred: derived by PCS or an AI from other facts
 */
export type Provenance = "verified" | "reported" | "inferred";

export interface EventInput {
  type: string;
  provenance: Provenance;
  source: string;
  payload?: unknown;
}

export interface EventRow {
  id: number;
  ts: string;
  type: string;
  provenance: Provenance;
  source: string;
  payload: string;
  prev_hash: string;
  hash: string;
}

export interface ChainReport {
  ok: boolean;
  count: number;
  brokenAt?: number;
  reason?: string;
}

export const GENESIS_HASH = "0".repeat(64);

export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, sort(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export function computeHash(
  prevHash: string,
  e: Pick<EventRow, "ts" | "type" | "provenance" | "source" | "payload">,
): string {
  return createHash("sha256")
    .update(JSON.stringify([prevHash, e.ts, e.type, e.provenance, e.source, e.payload]))
    .digest("hex");
}

/** Insert one event. Must be called inside a transaction (see appendEvent). */
export function insertEvent(db: Db, input: EventInput): EventRow {
  const last = db.prepare("SELECT hash FROM events ORDER BY id DESC LIMIT 1").get() as
    | { hash: string }
    | undefined;
  const prev_hash = last?.hash ?? GENESIS_HASH;
  const payload = canonicalJson(redactDeep(input.payload ?? {}).value);
  const body = {
    ts: new Date().toISOString(),
    type: input.type,
    provenance: input.provenance,
    source: input.source,
    payload,
  };
  const hash = computeHash(prev_hash, body);
  const info = db
    .prepare(
      "INSERT INTO events (ts, type, provenance, source, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(body.ts, body.type, body.provenance, body.source, body.payload, prev_hash, hash);
  return { id: Number(info.lastInsertRowid), ...body, prev_hash, hash };
}

export function appendEvent(db: Db, input: EventInput): EventRow {
  return inTransaction(db, () => insertEvent(db, input));
}

export function recentEvents(db: Db, limit = 5): EventRow[] {
  return db
    .prepare("SELECT id, ts, type, provenance, source, payload, prev_hash, hash FROM events ORDER BY id DESC LIMIT ?")
    .all(limit) as unknown as EventRow[];
}

/** Recompute the whole hash chain. Detects edits, deletions in the middle, and reordering. */
export function verifyChain(db: Db): ChainReport {
  let expectedPrev = GENESIS_HASH;
  let count = 0;
  const rows = db.prepare(
    "SELECT id, ts, type, provenance, source, payload, prev_hash, hash FROM events ORDER BY id ASC",
  );
  for (const raw of rows.iterate()) {
    const row = raw as unknown as EventRow;
    count++;
    if (row.prev_hash !== expectedPrev) {
      return { ok: false, count, brokenAt: row.id, reason: "chain link broken (event removed or reordered)" };
    }
    if (computeHash(row.prev_hash, row) !== row.hash) {
      return { ok: false, count, brokenAt: row.id, reason: "event content was modified" };
    }
    expectedPrev = row.hash;
  }
  return { ok: true, count };
}
