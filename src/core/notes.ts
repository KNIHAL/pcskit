import { withDb } from "./context";
import { inTransaction, type Db } from "./db";
import { PcsError } from "./errors";
import { insertEvent } from "./events";
import { redactText } from "./redact";
import { resolveSource } from "./tasks";

/**
 * Things the next agent must know that git and tests cannot tell it. All of them are claims
 * (`reported`): PCS stores them, it does not check them.
 * - task:  what is being built (the original task). The newest one wins.
 * - next:  an exact next step.
 * - avoid: something not to touch, and why.
 * - issue: a known unresolved problem.
 */
export const NOTE_KINDS = ["task", "next", "avoid", "issue"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const MAX_NOTE_TEXT = 2000;

export interface Note {
  /** The id of the `note.added` event, so a note is part of the tamper-evident log. */
  id: number;
  ts: string;
  kind: NoteKind;
  text: string;
  source: string;
  session_id: number | null;
  resolved_at: string | null;
  resolved_by: string | null;
}

export function isNoteKind(s: string): s is NoteKind {
  return (NOTE_KINDS as readonly string[]).includes(s);
}

/**
 * Notes live only in the hash-chained event log (`note.added`, `note.resolved`): there is no
 * separate table to tamper with, and editing or deleting one breaks `pcs verify`.
 */
export function readNotes(db: Db): Note[] {
  const notes: Note[] = [];
  const resolved = new Map<number, { ts: string; by: string }>();
  for (const raw of db
    .prepare(
      "SELECT id, ts, type, source, session_id, payload FROM events WHERE type IN ('note.added', 'note.resolved') ORDER BY id ASC",
    )
    .iterate()) {
    const r = raw as unknown as {
      id: number;
      ts: string;
      type: string;
      source: string;
      session_id: number | null;
      payload: string;
    };
    let p: { kind?: unknown; text?: unknown; noteId?: unknown };
    try {
      p = JSON.parse(r.payload) as typeof p;
    } catch {
      continue; // a malformed payload would already break the event chain
    }
    if (r.type === "note.added") {
      if (typeof p.kind === "string" && isNoteKind(p.kind) && typeof p.text === "string") {
        notes.push({
          id: r.id,
          ts: r.ts,
          kind: p.kind,
          text: p.text,
          source: r.source,
          session_id: r.session_id,
          resolved_at: null,
          resolved_by: null,
        });
      }
    } else if (typeof p.noteId === "number") {
      resolved.set(p.noteId, { ts: r.ts, by: r.source });
    }
  }
  return notes.map((n) => {
    const x = resolved.get(n.id);
    return x ? { ...n, resolved_at: x.ts, resolved_by: x.by } : n;
  });
}

export async function addNote(cwd: string, kind: string, text: string, source?: string): Promise<Note> {
  if (!isNoteKind(kind)) {
    throw new PcsError("INVALID_INPUT", `Invalid note kind "${kind}". Use: ${NOTE_KINDS.join(", ")}.`);
  }
  const clean = redactText(text.trim()).text;
  if (!clean) throw new PcsError("INVALID_INPUT", "Note text is empty.");
  if (clean.length > MAX_NOTE_TEXT) {
    throw new PcsError("INVALID_INPUT", `Note is longer than ${MAX_NOTE_TEXT} characters.`);
  }
  return withDb(cwd, (db) =>
    inTransaction(db, () => {
      const who = resolveSource(db, source);
      const ev = insertEvent(db, { type: "note.added", provenance: "reported", ...who, payload: { kind, text: clean } });
      return {
        id: ev.id,
        ts: ev.ts,
        kind,
        text: clean,
        source: who.source,
        session_id: who.sessionId ?? null,
        resolved_at: null,
        resolved_by: null,
      };
    }),
  );
}

/** Mark a next/avoid/issue note as no longer applicable. The note stays in the log; it is just not current. */
export async function resolveNote(cwd: string, id: number, source?: string): Promise<Note> {
  if (!Number.isInteger(id) || id < 1) throw new PcsError("INVALID_INPUT", "Note id must be a positive integer.");
  return withDb(cwd, (db) =>
    inTransaction(db, () => {
      const note = readNotes(db).find((n) => n.id === id);
      if (!note) throw new PcsError("INVALID_INPUT", `Note #${id} not found.`);
      if (note.kind === "task") {
        throw new PcsError("INVALID_INPUT", "The original task is replaced by adding a newer `task` note, not resolved.");
      }
      if (note.resolved_at !== null) throw new PcsError("INVALID_INPUT", `Note #${id} is already resolved.`);
      const who = resolveSource(db, source);
      const ev = insertEvent(db, {
        type: "note.resolved",
        provenance: "reported",
        ...who,
        payload: { noteId: id, kind: note.kind },
      });
      return { ...note, resolved_at: ev.ts, resolved_by: who.source };
    }),
  );
}

export async function listNotes(cwd: string, opts: { kind?: string; all?: boolean } = {}): Promise<Note[]> {
  if (opts.kind !== undefined && !isNoteKind(opts.kind)) {
    throw new PcsError("INVALID_INPUT", `Invalid note kind "${opts.kind}". Use: ${NOTE_KINDS.join(", ")}.`);
  }
  return withDb(cwd, (db) =>
    readNotes(db).filter(
      (n) => (opts.kind === undefined || n.kind === opts.kind) && (opts.all === true || n.resolved_at === null),
    ),
  );
}
