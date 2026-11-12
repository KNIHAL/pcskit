import { withDb } from "./context";
import { inTransaction, type Db } from "./db";
import { PcsError } from "./errors";
import { insertEvent } from "./events";
import { redactText } from "./redact";
import { activeSession, validateAgentName } from "./sessions";

export const TASK_STATUSES = ["todo", "in_progress", "done", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

const MAX_TITLE = 500;
const MAX_NOTE = 2000;
const SELECT = "SELECT id, title, status, created_at, updated_at FROM tasks";

export function isTaskStatus(s: string): s is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(s);
}

/** Tasks that are not done, oldest first. */
export function openTasks(db: Db): Task[] {
  return db.prepare(`${SELECT} WHERE status != 'done' ORDER BY id ASC`).all() as unknown as Task[];
}

/**
 * Who is making the claim: an explicit agent name, else the agent of the active
 * session, else "user". Either way it is a claim (`reported`), never an observation.
 */
export function resolveSource(db: Db, explicit: string | undefined): { source: string; sessionId?: number } {
  const session = activeSession(db);
  const source = explicit !== undefined ? validateAgentName(explicit) : (session?.agent ?? "user");
  return session ? { source, sessionId: session.id } : { source };
}

export async function addTask(cwd: string, title: string, source?: string): Promise<Task> {
  const clean = redactText(title.trim()).text;
  if (!clean) throw new PcsError("INVALID_INPUT", "Task title is empty.");
  if (clean.length > MAX_TITLE) throw new PcsError("INVALID_INPUT", `Task title is longer than ${MAX_TITLE} characters.`);

  return withDb(cwd, (db) =>
    inTransaction(db, () => {
      const who = resolveSource(db, source);
      const now = new Date().toISOString();
      const info = db
        .prepare("INSERT INTO tasks (title, status, created_at, updated_at) VALUES (?, 'todo', ?, ?)")
        .run(clean, now, now);
      const id = Number(info.lastInsertRowid);
      // A task declared by a person or agent is a claim about intent, not an observed fact.
      insertEvent(db, { type: "task.created", provenance: "reported", ...who, payload: { taskId: id, title: clean } });
      return { id, title: clean, status: "todo" as const, created_at: now, updated_at: now };
    }),
  );
}

export async function updateTask(
  cwd: string,
  id: number,
  change: { status: string; note?: string; source?: string },
): Promise<Task> {
  if (!Number.isInteger(id) || id < 1) throw new PcsError("INVALID_INPUT", "Task id must be a positive integer.");
  if (!isTaskStatus(change.status)) {
    throw new PcsError("INVALID_INPUT", `Invalid status "${change.status}". Use: ${TASK_STATUSES.join(", ")}.`);
  }
  const status = change.status;
  const note = change.note ? redactText(change.note.trim()).text.slice(0, MAX_NOTE) : undefined;

  return withDb(cwd, (db) =>
    inTransaction(db, () => {
      const current = db.prepare(`${SELECT} WHERE id = ?`).get(id) as Task | undefined;
      if (!current) throw new PcsError("INVALID_INPUT", `Task #${id} not found.`);
      const who = resolveSource(db, change.source);
      const now = new Date().toISOString();
      db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
      // "done" from an agent is a claim; PCS only upgrades it to verified with real evidence (tests, git).
      insertEvent(db, {
        type: "task.status_changed",
        provenance: "reported",
        ...who,
        payload: { taskId: id, from: current.status, to: status, ...(note ? { note } : {}) },
      });
      return { ...current, status, updated_at: now };
    }),
  );
}

export async function listTasks(cwd: string, status?: string): Promise<Task[]> {
  if (status !== undefined && !isTaskStatus(status)) {
    throw new PcsError("INVALID_INPUT", `Invalid status "${status}". Use: ${TASK_STATUSES.join(", ")}.`);
  }
  return withDb(cwd, (db) =>
    status
      ? (db.prepare(`${SELECT} WHERE status = ? ORDER BY id ASC`).all(status) as unknown as Task[])
      : (db.prepare(`${SELECT} ORDER BY id ASC`).all() as unknown as Task[]),
  );
}
