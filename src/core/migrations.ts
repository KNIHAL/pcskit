/**
 * Append-only list of schema migrations. Never edit an entry that has shipped;
 * add a new one. PRAGMA user_version records how many have been applied.
 */
export const MIGRATIONS: readonly string[] = [
  // v1: project identity + tamper-evident event log
  `
  CREATE TABLE project (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    root TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    provenance TEXT NOT NULL CHECK (provenance IN ('verified', 'reported', 'inferred')),
    source TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE
  );
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  `,
  // v2: tasks (current state; every change is also an event)
  `
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done', 'blocked')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // v3: agent sessions. events.session_id is part of the hash only when set,
  // so chains written before this migration still verify.
  `
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    end_reason TEXT CHECK (end_reason IN ('completed', 'limit', 'switched', 'interrupted'))
  );
  ALTER TABLE events ADD COLUMN session_id INTEGER;
  `,
  // v4: snapshots of observed git state. Immutable; each one's digest is also
  // stored in a hash-chained event, so editing a snapshot is detectable.
  `
  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('manual', 'session_start', 'session_end')),
    session_id INTEGER,
    branch TEXT NOT NULL,
    head TEXT,
    files TEXT NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0,
    digest TEXT NOT NULL
  );
  CREATE TRIGGER snapshots_no_update BEFORE UPDATE ON snapshots
    BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;
  CREATE TRIGGER snapshots_no_delete BEFORE DELETE ON snapshots
    BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;
  `,
];
