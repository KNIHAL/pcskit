import { withDb } from "./context";
import { PcsError } from "./errors";
import { canonicalJson, computeHash, GENESIS_HASH, type EventRow, type Provenance } from "./events";
import { verifyIntegrity } from "./integrity";

/**
 * Reading the evidence log: `pcs log` (a compact view) and `pcs export` (a complete, independently checkable audit
 * trail). Everything shown was already redacted when it was written.
 */
export const EXPORT_FORMAT = "pcskit-audit-1";
const COLS = "id, ts, type, provenance, source, payload, session_id, prev_hash, hash";
export const MAX_LOG_LIMIT = 1000;

export interface LogFilter {
  limit?: number;
  type?: string;
  provenance?: Provenance;
  /** Only events with an id greater than this. */
  afterId?: number;
}

const PROVENANCE = ["verified", "reported", "inferred"] as const;

function checkFilter(f: LogFilter): void {
  if (f.limit !== undefined && (!Number.isInteger(f.limit) || f.limit < 1 || f.limit > MAX_LOG_LIMIT)) {
    throw new PcsError("INVALID_INPUT", `--limit must be between 1 and ${MAX_LOG_LIMIT}.`);
  }
  if (f.provenance !== undefined && !(PROVENANCE as readonly string[]).includes(f.provenance)) {
    throw new PcsError("INVALID_INPUT", `Provenance must be one of: ${PROVENANCE.join(", ")}.`);
  }
  if (f.afterId !== undefined && (!Number.isInteger(f.afterId) || f.afterId < 0)) throw new PcsError("INVALID_INPUT", "--after must be a non-negative event id.");
}

/** The newest `limit` matching events, returned oldest first. */
export async function listEvents(cwd: string, f: LogFilter = {}): Promise<EventRow[]> {
  checkFilter(f);
  return withDb(cwd, (db) => {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.type !== undefined) {
      where.push("type LIKE ? ESCAPE '\\'");
      args.push(`${f.type.replace(/[\\%_]/g, "\\$&").replace(/\*/g, "%")}`);
    }
    if (f.provenance !== undefined) {
      where.push("provenance = ?");
      args.push(f.provenance);
    }
    if (f.afterId !== undefined) {
      where.push("id > ?");
      args.push(f.afterId);
    }
    const sql = `SELECT ${COLS} FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...args, f.limit ?? 20) as unknown as EventRow[];
    return rows.reverse();
  });
}

/** One short line describing what an event recorded: its payload's top-level fields, truncated. */
export function eventSummary(row: Pick<EventRow, "payload">, max = 110): string {
  let p: unknown;
  try {
    p = JSON.parse(row.payload);
  } catch {
    return "";
  }
  if (!p || typeof p !== "object" || Array.isArray(p)) return clip(String(p ?? ""), max);
  const parts = Object.entries(p as Record<string, unknown>).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return clip(parts.join(" "), max);
}

function clip(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const one = s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function formatLogLine(e: EventRow): string {
  const sum = eventSummary(e);
  return `#${e.id} ${e.ts} [${e.provenance}] ${e.type} (${e.source}${e.session_id !== null ? `, session ${e.session_id}` : ""})${sum ? ` ${sum}` : ""}`;
}

/* ------------------------------------------------------------------ */
/* Export                                                               */
/* ------------------------------------------------------------------ */

export interface ExportedEvent {
  id: number;
  ts: string;
  type: string;
  provenance: Provenance;
  source: string;
  session_id: number | null;
  payload: unknown;
  prev_hash: string;
  hash: string;
}

export interface AuditExport {
  format: typeof EXPORT_FORMAT;
  exported_at: string;
  project: string;
  /** How a reader can recompute every hash without pcskit. */
  algorithm: string;
  /** False when the export starts at the first event ever recorded and ends at the newest. */
  partial: boolean;
  integrity: { ok: boolean; events_in_log: number; reason?: string; broken_at?: number };
  head: { id: number; hash: string } | null;
  counts: Record<string, number>;
  events: ExportedEvent[];
}

const ALGORITHM =
  'hash = sha256(JSON.stringify([prev_hash, ts, type, provenance, source, payload_json] + [session_id] only when session_id is not null)); ' +
  "payload_json is the payload serialised with object keys sorted at every level; the first event's prev_hash is 64 zeros.";

export interface ExportOptions {
  /** First event id to include (default: the first). */
  from?: number;
  /** Last event id to include (default: the newest). */
  to?: number;
}

function toExported(r: EventRow): ExportedEvent {
  let payload: unknown = null;
  try {
    payload = JSON.parse(r.payload);
  } catch {
    payload = null;
  }
  return { id: r.id, ts: r.ts, type: r.type, provenance: r.provenance, source: r.source, session_id: r.session_id, payload, prev_hash: r.prev_hash, hash: r.hash };
}

export async function buildExport(cwd: string, opts: ExportOptions = {}): Promise<AuditExport> {
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined && (!Number.isInteger(v) || (v as number) < 1)) throw new PcsError("INVALID_INPUT", `--${k} must be a positive event id.`);
  }
  if (opts.from !== undefined && opts.to !== undefined && opts.from > opts.to) throw new PcsError("INVALID_INPUT", "--from must not be greater than --to.");
  return withDb(cwd, (db) => {
    const integrity = verifyIntegrity(db);
    const project = (db.prepare("SELECT name FROM project WHERE id = 1").get() as { name: string } | undefined)?.name ?? "";
    const rows = db
      .prepare(`SELECT ${COLS} FROM events WHERE id >= ? AND id <= ? ORDER BY id ASC`)
      .all(opts.from ?? 1, opts.to ?? Number.MAX_SAFE_INTEGER) as unknown as EventRow[];
    const head = db.prepare("SELECT id, hash FROM events ORDER BY id DESC LIMIT 1").get() as { id: number; hash: string } | undefined;
    const first = db.prepare("SELECT id FROM events ORDER BY id ASC LIMIT 1").get() as { id: number } | undefined;
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.type] = (counts[r.type] ?? 0) + 1;
    const partial = rows.length === 0 || rows[0]!.id !== first?.id || rows[rows.length - 1]!.id !== head?.id;
    return {
      format: EXPORT_FORMAT,
      exported_at: new Date().toISOString(),
      project,
      algorithm: ALGORITHM,
      partial,
      integrity: {
        ok: integrity.ok,
        events_in_log: integrity.count,
        ...(integrity.reason !== undefined ? { reason: integrity.reason } : {}),
        ...(integrity.brokenAt !== undefined ? { broken_at: integrity.brokenAt } : {}),
      },
      head: head ? { id: Number(head.id), hash: head.hash } : null,
      counts,
      events: rows.map(toExported),
    } satisfies AuditExport;
  });
}

/** Re-check an export on its own: parse it, then recompute every hash link from the events it carries. */
export interface ExportCheck {
  ok: boolean;
  events: number;
  partial: boolean;
  reason?: string | undefined;
  brokenAt?: number | undefined;
}

export function checkExport(text: string): ExportCheck {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new PcsError("INVALID_INPUT", "Export file is not valid JSON.");
  }
  const d = doc as Partial<AuditExport>;
  if (!d || d.format !== EXPORT_FORMAT || !Array.isArray(d.events)) throw new PcsError("INVALID_INPUT", `Not a ${EXPORT_FORMAT} export.`);
  let expected: string | null = null;
  let n = 0;
  for (const raw of d.events) {
    const e = raw as Partial<ExportedEvent>;
    const shapeOk =
      Number.isInteger(e.id) &&
      typeof e.ts === "string" &&
      typeof e.type === "string" &&
      typeof e.provenance === "string" &&
      typeof e.source === "string" &&
      typeof e.prev_hash === "string" &&
      typeof e.hash === "string" &&
      (e.session_id === null || Number.isInteger(e.session_id));
    if (!shapeOk) return { ok: false, events: n, partial: d.partial === true, reason: "an event has missing or wrong fields", brokenAt: Number.isInteger(e.id) ? e.id : undefined };
    n++;
    const ev = e as ExportedEvent;
    if (expected === null) {
      if (d.partial !== true && ev.prev_hash !== GENESIS_HASH) return { ok: false, events: n, partial: false, reason: "the first event does not start the chain", brokenAt: ev.id };
    } else if (ev.prev_hash !== expected) {
      return { ok: false, events: n, partial: d.partial === true, reason: "chain link broken (event removed or reordered)", brokenAt: ev.id };
    }
    const recomputed = computeHash(ev.prev_hash, { ts: ev.ts, type: ev.type, provenance: ev.provenance, source: ev.source, payload: canonicalJson(ev.payload), session_id: ev.session_id });
    if (recomputed !== ev.hash) return { ok: false, events: n, partial: d.partial === true, reason: "event content was modified", brokenAt: ev.id };
    expected = ev.hash;
  }
  if (d.head && expected !== null && d.partial !== true && d.head.hash !== expected) {
    return { ok: false, events: n, partial: false, reason: "the head hash does not match the last event", brokenAt: undefined };
  }
  return { ok: true, events: n, partial: d.partial === true };
}

function cell(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\|/g, "\\|").trim();
}

export function formatExportMarkdown(x: AuditExport): string {
  const L: string[] = [];
  L.push(`# PCS audit trail: ${cell(x.project) || "project"}`, "");
  L.push(`- Exported: ${x.exported_at}`);
  L.push(`- Events in this export: ${x.events.length}${x.partial ? " (partial: not the whole log)" : ""}`);
  L.push(`- Log integrity when exported: ${x.integrity.ok ? `OK (${x.integrity.events_in_log} events)` : `FAILED at #${x.integrity.broken_at ?? "?"}: ${x.integrity.reason ?? "unknown"}`}`);
  if (x.head) L.push(`- Head: #${x.head.id} \`${x.head.hash}\``);
  L.push(`- Format: ${x.format}. Check it without pcskit: ${x.algorithm}`, "");
  L.push("## Events by type", "");
  for (const [t, c] of Object.entries(x.counts).sort()) L.push(`- ${cell(t)}: ${c}`);
  L.push("", "## Timeline", "", "| # | Time | Provenance | Type | Source | Session | Detail |", "|---|---|---|---|---|---|---|");
  for (const e of x.events) {
    const row = { payload: JSON.stringify(e.payload) } as Pick<EventRow, "payload">;
    L.push(`| ${e.id} | ${cell(e.ts)} | ${cell(e.provenance)} | ${cell(e.type)} | ${cell(e.source)} | ${e.session_id ?? ""} | ${cell(eventSummary(row, 160))} |`);
  }
  L.push("", "Every value above was redacted when it was recorded. [reported] and [inferred] rows are claims, not proof.", "");
  return L.join("\n");
}
