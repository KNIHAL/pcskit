# PCS status (read this first)

Last updated: 2026-11-12. Update this file when a whole step below is finished, not after every small fix.

## What we are building
**PCS = Project Continuity System.** When an AI coding agent stops (token limit, new chat, switching to another AI), PCS reconstructs what *actually* happened in the project and writes a handoff the next agent can continue from, without confusion about what is done, what is half-done, and which file was being edited.

Core principles: local-first, AI-independent, evidence-based (never trust an AI's "done" claim), enterprise-grade security.

Evidence model: every recorded fact has a provenance.
- `verified`: PCS observed it itself (git state, snapshots, a test run PCS executed).
- `reported`: a human or agent claimed it.
- `inferred`: derived from other facts (e.g. "session was interrupted").
Handoffs must keep these three separate.

v1 is **CLI only**. MCP server, dashboard and background watcher come after the CLI handoff works on a real project.

## Built and tested (133 tests passing)
- `pcs resume [--agent name] [--json]`: the pickup. Reads the latest `handoff.generated` event, starts a session for the new agent (an unended one becomes `interrupted`), snapshots the repo, and compares it with the handoff's snapshot (HEAD moved? files changed? commits since). Checks the handoff file's SHA-256; an edited, missing or unwritten file is never shown: the handoff is rebuilt from the evidence log instead. Records `handoff.checked` (verified) and `handoff.picked_up` (reported by the agent), both linked to the new session. Prints the brief (checks, warnings, then the handoff). Refuses if no handoff exists or nobody is identified. Exit 2 on integrity failure (brief still printed, with a warning).
- `pcs note add <kind> <text>|list|resolve <id>`: what git and tests cannot tell the next agent. Kinds: `task` (original task, newest wins), `next` (exact next step), `avoid` (do not touch, and why), `issue` (known problem). Notes are `reported` events in the hash-chained log (no separate table); `next`/`avoid`/`issue` can be resolved.
- `pcs handoff [--session id] [--out file] [--stdout] [--json]`: takes a fresh verified snapshot, then writes `.pcs/HANDOFF.md` (git-excluded) with: session, original task, completed (verified / passing-but-code-changed / reported-only), in progress, files touched (commits, uncommitted files, what changed since session start), tests (with fingerprint freshness and the output tail of failing runs), unresolved issues, next steps, do-not-touch. Every line is tagged `[verified]`, `[reported by X]` or `[inferred]`. Sensitive files by name only. Records a `handoff.generated` event with the file's SHA-256. Exit 2 (with a loud warning inside the file) if the integrity check fails.
- `pcs test [--task id] [--timeout s] -- <command>`: runs the command (argument array, no shell; `npm`/`npx` `.cmd` shims on Windows go through a guarded cmd.exe call), records exit code, duration, repo state (HEAD + fingerprint of changed files) and a redacted, size-capped output tail as a `verified` event linked to the session. Exit 0 only if it passed. `--task` links the run to a task as evidence (the link is a `reported` claim; the run is `verified`).
- `pcs evidence list|show <id>|link <task> <run>`: browse runs, link existing runs to tasks. `pcs task list` shows each task's latest evidence. Runs and links are immutable and checked by `pcs verify`.
- `pcs init`: register a git project (`.pcs/` SQLite, git-excluded, owner-only).
- `pcs status [--json]`: real git state (branch, HEAD, changed files, sensitive-file flags), active session, open tasks, log integrity.
- `pcs verify`: checks the tamper-evident event log and every snapshot (exit code 2 if broken).
- `pcs task add|list|update`: tasks; every change is a `reported` event attributed to an agent (`--agent`, else the active session's agent, else `user`).
- `pcs session start|end|current|list`: which AI is working. Starting a session while one is still open marks the old one `interrupted` (an `inferred` event). End reasons: completed, limit, switched. Task events are linked to the active session.
- `pcs snapshot [take]|list|diff [from] [to] [--session id]`: a `verified` snapshot of git state (HEAD, branch, each changed file with SHA-256 of content). Taken automatically on `session start` and `session end` (a failed observation never blocks the session; it is logged as `snapshot.failed`). `diff` shows new/changed/resolved files and the commits made between two HEADs. Default compares the last two snapshots.
- Event log: append-only, SHA-256 hash chain (covers session link too), secrets redacted before storage. Snapshots are immutable and their digest is stored in a chained event.
- Hardened git adapter (no repo-config command execution, read-only, timeouts, commit hashes validated).
- Versioned schema migrations (`src/core/migrations.ts`, currently v5; upgrades from older versions are tested).
- CI (GitHub Actions: Windows + Linux, Node 22 + 24). Decisions and security limits: `docs/DECISIONS.md`.

## Remaining for v1 (in order)
1. ~~Sessions~~ done.
2. ~~Snapshots~~ done.
3. ~~Verification (`pcs test`)~~ done.
4. ~~Handoff (`pcs handoff`, `pcs note`)~~ done.
5. ~~Resume (`pcs resume`)~~ done.
6. **Real test**: run on `causly-server`: Claude works, gets interrupted, PCS makes the handoff, GPT continues, PCS verifies.

After v1, in this order: background watcher (high priority; chokidar), MCP server (thin wrapper over `src/core`), dashboard.

## Next step
Step 5: `pcs resume`: print the brief for the next agent and record the pickup. It should read the latest `handoff.generated` event, warn if the repo (fingerprint/HEAD) moved since the handoff was written or the file's SHA-256 no longer matches, and record a `session`-linked pickup event.

## How to continue in a new chat
Tell the AI: "Read D:\pcs\AGENTS.md and D:\pcs\docs\STATUS.md, then continue with the Next step."
