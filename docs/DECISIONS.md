# PCS decisions

Short record of architecture and security decisions. Add an entry when you decide something that is costly to reverse.

## Architecture
- `src/core` is the only place with logic. CLI (now), MCP and dashboard (later) are thin wrappers over it.
- Storage: SQLite via Node's built-in `node:sqlite` (no native build step; Node >= 22.13). Schema changes only by appending to `MIGRATIONS` in `migrations.ts`; `PRAGMA user_version` tracks it; a newer DB is refused.
- State lives in `<repo>/.pcs/`, excluded via `.git/info/exclude` (no tracked file is touched).
- Git is observed by shelling out to `git` (never a shell string, always `execFile` with an argument array).
- Observation (git, file hashing) happens *before* the DB transaction; the transaction only writes. Session start/end never fail because observing failed.

## Evidence model
- Every event carries `provenance`: `verified` (PCS observed it), `reported` (an agent/human claimed it), `inferred`. Handoffs must keep these separate. AI completion claims are never `verified`.
- `events.session_id` joins the hash only when set, so chains written before it existed still verify.

## Security
- **Tamper-evident log:** events are append-only (SQLite triggers) and hash-chained (SHA-256 over prev hash + content). `pcs verify` detects edited, removed-in-the-middle or reordered events. It does NOT detect truncation of the newest events or a full rewrite by someone who recomputes the chain; an external anchor (signed head hash) is a later hardening step.
- **Snapshots:** immutable (triggers) and each snapshot's digest is stored in a hash-chained event; `pcs verify` recomputes digests, so an edited or deleted snapshot is caught even if the triggers are dropped.
- **Snapshot file handling:** files flagged sensitive (`.env`, keys, ...) are listed by name and never opened. Files are inspected with `lstat`; symlinks are recorded, never followed. Paths are checked to stay inside the repo. Caps: 50 MB per file hashed, 5000 files per snapshot (truncation is flagged).
- **Untrusted repos:** git runs with `core.fsmonitor=false`, `--no-optional-locks`, no prompts, 30s timeout. PCS never bypasses git's "dubious ownership" protection. Commit hashes passed to git history commands must be full hex hashes (no option injection).
- **Secrets:** event payloads are redacted before storage (keys, tokens, JWTs, private keys, `password=...`). Redaction is best-effort pattern matching, not a guarantee.
- **Terminal safety:** repo-controlled strings are stripped of control characters before printing.
- **Input validation:** agent names are restricted to a safe character set; titles, notes and limits are length-capped.
- **Local only:** no network access, no telemetry. `.pcs/` is created owner-only on POSIX.
- **Exit codes:** 0 ok, 1 error, 2 integrity failure.
