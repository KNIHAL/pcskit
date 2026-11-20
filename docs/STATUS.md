# PCS status (read this first)

Last updated: 2026-11-20. Update this file when a whole step below is finished, not after every small fix.

## What we are building

**PCS = Project Continuity System.** When an AI coding agent stops (token limit, new chat, switching to another AI), PCS reconstructs what actually happened in the project and writes a handoff the next agent can continue from, without confusion about what is done, what is half-done and which file was being edited.

Principles: local-first, AI-independent, evidence-based (never trust an AI's "done" claim), secure by default.

Evidence model: every recorded fact has a provenance.

- `verified`: PCS observed it itself (git state, snapshots, a test run PCS executed).
- `reported`: a human or agent claimed it.
- `inferred`: derived from other facts (for example "session was interrupted").

Handoffs keep these three separate.

## What v1 contains (all built and tested on Windows, Linux and macOS)

- Core: `init`, `status`, `verify`, sessions, snapshots, tasks, notes, `test` (verified test runs), `evidence`, `handoff`, `resume` (also `--prompt`).
- Tamper-evident event log (SHA-256 hash chain), signed anchor against truncation, self-checking `export`, `log`, owner-only access (POSIX modes, Windows ACLs).
- Redaction before storage, extra rules and test allowlist through the policy files (`config`); policy can only tighten defaults.
- Agent integration: MCP server (`mcp`, with `--read-only` and `--allow-test`), `connect` for Claude Desktop, Cursor and Claude Code, Claude Code hooks, instruction block for CLAUDE.md, AGENTS.md and Cursor rules (`agents`).
- Watcher (`watch`) with autostart at login (`autostart`), multi-repo `workspace`, read-only local `dashboard`.
- Operations: `doctor [--fix]`, `deinit`.
- Quality: strict typecheck, Biome lint, coverage thresholds, 3 OS x 2 Node CI, real-layout tests (worktrees, submodules), concurrency stress tests, fuzz tests, a real MCP stdio end-to-end test.

Decisions and security limits: `docs/DECISIONS.md`. Using it with apps: `docs/CLIENTS.md`.

## Non-goals for v1

- Cross-machine sync or a central server.
- Database pruning or archiving.
- Importing other tools' sessions.
- A GUI beyond the read-only dashboard.

## Before launch

1. Community and process files (this folder, `.github/`, root).
2. Release setup: changelog, npm publish with provenance, pinned Actions, Dependabot.
3. README.
4. Real-app check of Claude Desktop and Cursor (`docs/CLIENTS.md`), npm account with 2FA and trusted publisher, then make the repository public.

## Known nits

- Commands shown in a handoff lose shell quoting.
- Note ids are event ids, not 1, 2, 3 (decision recorded in `docs/DECISIONS.md`).

## How to continue in a new chat

Tell the AI: "Read AGENTS.md and docs/STATUS.md, then continue with the first item under Before launch."
