# PCS decisions

Short record of architecture and security decisions. Add an entry when you decide something that is costly to reverse.

## Architecture
- `src/core` is the only place with logic. CLI (now), MCP and dashboard (later) are thin wrappers over it.
- Storage: SQLite via Node's built-in `node:sqlite` (no native build step; Node >= 22.13). Schema changes only by appending to `MIGRATIONS` in `db.ts`; `PRAGMA user_version` tracks it; a newer DB is refused.
- State lives in `<repo>/.pcs/`, excluded via `.git/info/exclude` (no tracked file is touched).
- Git is observed by shelling out to `git` (never a shell string, always `execFile` with an argument array).

## Evidence model
- Every event carries `provenance`: `verified` (PCS observed it), `reported` (an agent/human claimed it), `inferred`. Handoffs must keep these separate. AI completion claims are never `verified`.

## Security
- **Tamper-evident log:** events are append-only (SQLite triggers) and hash-chained (SHA-256 over prev hash + content). `pcs verify` detects edited, removed-in-the-middle or reordered events. It does NOT detect truncation of the newest events or a full rewrite by someone who recomputes the chain; an external anchor (signed head hash) is a later hardening step.
- **Untrusted repos:** git runs with `core.fsmonitor=false`, `--no-optional-locks`, no prompts, 30s timeout. PCS never bypasses git's "dubious ownership" protection.
- **Secrets:** event payloads are redacted before storage (keys, tokens, JWTs, private keys, `password=...`). Files like `.env`, `*.pem`, `id_*` are flagged `sensitive`; their content is never read into a handoff. Redaction is best-effort pattern matching, not a guarantee.
- **Terminal safety:** repo-controlled strings are stripped of control characters before printing.
- **Local only:** no network access, no telemetry. `.pcs/` is created owner-only on POSIX.
- **Exit codes:** 0 ok, 1 error, 2 integrity failure.
