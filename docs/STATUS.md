# PCS status (read this first)

Last updated: 2026-11-11. Update this file when a whole step below is finished, not after every small fix.

## What we are building
**PCS = Project Continuity System.** When an AI coding agent stops (token limit, new chat, switching to another AI), PCS reconstructs what *actually* happened in the project and writes a handoff the next agent can continue from, without confusion about what is done, what is half-done, and which file was being edited.

Core principles: local-first, AI-independent, evidence-based (never trust an AI's "done" claim), enterprise-grade security.

Evidence model: every recorded fact has a provenance.
- `verified`: PCS observed it itself (git state, a test run PCS executed).
- `reported`: a human or agent claimed it.
- `inferred`: derived from other facts (e.g. "session was interrupted").
Handoffs must keep these three separate.

v1 is **CLI only**. MCP server, dashboard and background watcher come after the CLI handoff works on a real project.

## Built and tested (59 tests passing)
- `pcs init`: register a git project (`.pcs/` SQLite, git-excluded, owner-only).
- `pcs status [--json]`: real git state (branch, HEAD, changed files, sensitive-file flags), active session, open tasks, log integrity.
- `pcs verify`: checks the tamper-evident event log (exit code 2 if broken).
- `pcs task add|list|update`: tasks; every change is a `reported` event attributed to an agent (`--agent`, else the active session's agent, else `user`).
- `pcs session start|end|current|list`: which AI is working. Starting a session while one is still open marks the old one `interrupted` (an `inferred` event). End reasons: completed, limit, switched. Task events are linked to the active session.
- Event log: append-only, SHA-256 hash chain (covers session link too), secrets redacted before storage.
- Hardened git adapter (no repo-config command execution, read-only, timeouts).
- Versioned schema migrations (`src/core/migrations.ts`, currently v3; upgrade from v2 is tested).
- CI (GitHub Actions: Windows + Linux, Node 22 + 24). Decisions and security limits: `docs/DECISIONS.md`.

## Remaining for v1 (in order)
1. ~~Sessions~~ done.
2. **Snapshots**: `pcs snapshot` records a *verified* git snapshot (HEAD, branch, changed files with content hashes) linked to the active session. Also take one automatically on `session start` and `session end`. Comparing two snapshots shows what changed during a session. Never read content of `sensitive` files (record name only).
3. **Verification**: `pcs test -- <command>` runs a command, records exit code and summary as a *verified* event; tasks can point to that evidence.
4. **Handoff**: `pcs handoff` writes `HANDOFF.md` with sections: original task, completed (verified vs reported), in progress, files touched, tests, unresolved issues, exact next steps, do-not-touch. Sensitive files listed by name only.
5. **Resume**: `pcs resume` prints the brief for the next agent and records the pickup.
6. **Real test**: run on `causly-server`: Claude works, gets interrupted, PCS makes the handoff, GPT continues, PCS verifies.

After v1: background watcher (chokidar), MCP server (thin wrapper over `src/core`), dashboard.

## Next step
Step 2: snapshots.

## How to continue in a new chat
Tell the AI: "Read D:\pcs\AGENTS.md and D:\pcs\docs\STATUS.md, then continue with the Next step."
