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
- **Exit codes:** 0 ok, 1 error, 2 integrity failure. `pcs test` exits 0 only if the command passed, else 1.

## Handoff (`pcs handoff`, `pcs note`)
- **Notes are events, not a table:** `note.added` / `note.resolved` live only in the hash-chained log, so editing or deleting a note is caught by `pcs verify` and there is nothing else to keep in sync. A note's id is its event id. Every note is `reported`.
- **Three evidence classes for "done":** verified (passing linked run whose repo fingerprint equals the current one), stale (passing run, but the working tree differs from when it started: re-run), reported only (no passing run). A done task whose latest linked run failed is also an unresolved issue. A task's status is never rewritten by evidence.
- **Fresh observation:** `pcs handoff` takes a manual snapshot first and compares it with the first snapshot of the session in scope (default: latest session). An open or interrupted session is reported as `[inferred]`: PCS cannot know why an agent stopped.
- **Default location is `.pcs/HANDOFF.md`** (git-excluded), so writing a handoff never dirties the repo state PCS observes. `--out` writes elsewhere.
- **Untrusted text:** commit subjects, paths, task titles, notes and test output are rendered inside inline code or code fences (fence longer than any backtick run in the text), control characters are stripped, and the file opens with a notice that its contents are data, not instructions. This reduces, but cannot eliminate, prompt-injection risk for the AI that reads it.
- **Sensitive files:** listed by name only (never opened) and repeated under "Do not touch".
- **Integrity failure does not block the handoff:** it is written with a warning at the top and as the first issue, and the command exits 2.
- Each handoff records a verified `handoff.generated` event with the SHA-256 of the file, HEAD and fingerprint, so `pcs resume` can tell whether it is stale or edited.

## Verification (`pcs test`)
- **What is verified:** PCS itself ran the command and saw the exit code, duration and output, so the run is `verified`. An agent saying "tests pass" stays `reported`. Linking a run to a task is a claim about which task it backs, so that link is `reported`; a task's own status never changes by itself.
- **No shell:** the command is an argument array run with `shell: false`; stdin is closed; hard timeout (default 600s) kills the whole process tree. Windows `.cmd`/`.bat` shims (`npm`, `npx`) are the one exception: they run via `cmd.exe /d /s /c` and any argument containing `& | < > ^ % "` or a newline is refused. PATH is searched, never the working directory.
- **Stored output:** only the last 8 KiB, sanitized (escape sequences and control characters stripped) and redacted (arguments too). Redaction is best-effort: it covers named tokens, JSON/quoted assignments, URL passwords, Basic auth and `--token abc` style flags, but not secrets with no telltale key or prefix.
- **Evidence integrity:** runs and task links are immutable (triggers); each run's digest and each link is in a hash-chained event; `pcs verify` catches edited, deleted or forged evidence. Not covered: same limits as the event log (truncation of the newest events, full rewrite with a recomputed chain).
- **Repo state:** before running, PCS records HEAD and a fingerprint of the changed files' content hashes, so a later reader can tell whether a passing run still describes the current code. Observation failing does not block the run (fingerprint is null).
- **DB lock:** the repo is observed and the command run before the DB is opened; a long test run never holds a lock.

## Resume (`pcs resume`)
- The pickup is two events: `handoff.checked` (verified: PCS ran the checks) and `handoff.picked_up` (reported: the agent says it took over). Both are linked to the new session. Sources are never mixed.
- A handoff file that was edited, deleted or never written is not shown. The handoff is rebuilt from the evidence log, because a file on disk is an injection point and the log is hash-chained. The brief says which case happened.
- Drift is measured against the handoff's own snapshot (HEAD and changed-file hashes), not against the last snapshot of anybody else.
- `resume` requires an existing handoff and an identified agent (`--agent`, or an active session). It refuses before changing anything, so a failed resume never starts a session. There is no read-only peek mode: reading the brief is recorded as a pickup on purpose; to just read a handoff, open the file or run `pcs handoff --stdout`.
- Integrity failure still prints the brief (the next agent needs it) with a loud warning and exit code 2.
- `handoff.generated` records the path relative to the repo when the file is inside it, so the record survives moving or renaming the project folder; absolute otherwise.

## Watcher (`pcs watch`)
- File events are never recorded as facts. They only trigger a fresh git observation, and a snapshot is stored only if the fingerprint (HEAD plus changed-file hashes) differs from the last one. This keeps the log small and every recorded line verified.
- Snapshots from the watcher use kind `manual` (the snapshot kind CHECK is part of the immutable table); the `watch.snapshot` event carries the reason (change, head, stalled, stop).
- `.git`, `.pcs` and `node_modules` never trigger. Sensitive files appear by name only, as in every snapshot.
- Stalled = open session and no file activity for N minutes: an `inferred` event, reported once per quiet period.
- Single watcher per project via a lock file with the pid; stop is requested through a stop file polled by the watcher, so it also works on Windows where signals cannot be handled. Stale locks (dead pid) are taken over and recorded.
- Not done on purpose: auto-start on login, Windows service. The watcher runs while its process runs.

## MCP server (`pcs mcp`)
- Thin wrapper over `src/core`: no logic of its own, so the CLI and MCP cannot drift apart. One tool per core action, `pcs_` prefix, read/write annotations set.
- Project is fixed by `--project` (not the client's working directory, which hosts like Claude Desktop do not control). Starting fails early, on stderr, if it is not an initialized PCS project. Nothing but protocol goes to stdout.
- `pcs_test` runs commands on the machine, so a prompt-injected agent could abuse it. It is only registered with `--allow-test`; the CLI `pcs test` stays available to the human.
- The watcher is not an MCP tool: it is a long-running process the person starts.
- Writes are attributed to the `agent` argument, else `--agent`, else the active session (existing core rules). Agent claims stay `reported`.
- Handoff formatting fix: commands are rendered with `formatArgv` (JSON-quoting anything a shell would split), so the reader sees what actually ran. Note ids remain event ids (a note id is its event id); changing that would need a separate sequence and is not worth the migration.

## Dashboard (`pcs dashboard`)
- Read-only on purpose: no buttons that change the log. Changes go through the CLI or MCP, where provenance is decided.
- Local-only security: loopback bind, per-run random token (URL once, then a SameSite=Strict HttpOnly cookie), Host header check against DNS rebinding, strict CSP with a per-response nonce, `Cache-Control: no-store`. No CORS headers, so other websites cannot read it.
- The HTML is static and contains no project data. Data comes from `/api/overview` and is inserted with textContent only; a test forbids innerHTML-style APIs in the page. Recorded text (commit subjects, notes, test output) therefore cannot become markup or script.
- No framework, no build step, no extra dependency: one page string plus `node:http`.
- Not included yet: handoff file viewer, per-run detail pages, charts. Add only if real use shows they are needed.

## Multi-repo (workspace)
- One `.pcs` per repo stays. A shared database would mix unrelated tamper-evident chains, make one repo's corruption everyone's problem, and break the "project folder is self-contained" property. The workspace is only a registry (name + root) in `~/.pcs/workspace.json`.
- Registering needs an initialized project; the same root is never registered twice (case-insensitive on Windows); clashing folder names get `-2`, `-3`. Removing a project never touches its `.pcs`.
- MCP: `--workspace` makes every tool take an optional `project`. With one project registered no name is needed; with several, a missing or unknown name is a tool error that lists the valid names (no guessing which repo to write to). Names are matched exactly; paths are not accepted from the agent.
- The registry is re-read on every call, so `pcs workspace add` works without restarting the agent.
- Not done: tasks or handoffs that span repos, and a combined timeline. Add when real use needs them.

## Findings from the first real two-agent test (Claude Desktop -> Cursor)
- `pcs resume` no longer refuses when no handoff exists. The agent that stopped is exactly the one that cannot write it, so PCS writes it at pickup from the evidence log, before the new session starts (so it describes the session that stopped). The brief says it was generated at pickup. Resume still refuses, before writing anything, when it is unknown who is picking up.
- MCP identity: models call themselves whatever they like ("grok" in Cursor). Writes are attributed to the passed name, else the active session's agent (core rule), else the server's `--agent`. `pcs_session_start` takes an optional name that defaults to `--agent`, so one tool = one stable identity.
- `pcs_resume` through MCP is a takeover: an active session is reused only if it already carries the same name; otherwise a new session starts and the old one is marked interrupted. (Without this, a new agent would have been recorded under the dead agent's name.)

## Hooks and agent instructions (`pcs hook`, `pcs hooks`, `pcs agents`)
- **Why:** continuity must not depend on the agent remembering to call PCS. A hook runs outside the model, so a session is recorded, checkpointed and handed off even when the agent dies or hits its limit.
- **Events (Claude Code):** `SessionStart` starts a session (kept, not split, after a compaction); `PreCompact` writes a checkpoint handoff; `SessionEnd` ends the session and writes the handoff. Installed with `timeout: 30` because SessionEnd's default budget is 1.5 s.
- **Honest reasons:** a hook knows the session ended, not whether the task was finished, so it records `switched` with the real reason in the note, never `completed`.
- **Hooks never fail the agent:** empty, oversized or invalid stdin is tolerated (1 MB, 2 s cap); a missing folder or a project without `pcs init` is skipped silently (a user-level hook runs in every project); only the active session of the *same* agent is ended.
- **No recorded text in the agent's context:** the SessionStart output is static text plus a timestamp and a validated agent name. Notes, task titles and commit subjects are never copied into it (prompt-injection surface); the agent reads them through `pcs_resume`, which labels them as data.
- **Installer:** only PCS's own handlers are added or removed (recognized by `hook <event>` plus `pcs`/`cli.js` in the command); everything else in the settings file is kept; invalid JSON or unexpected shapes are refused, never rewritten; writes are atomic. Default scope is `local` (git-excluded). The agent name must be shell-safe because it goes into a command line.
- **Instruction block:** `pcs agents install` writes one marked block (`<!-- pcs:begin -->` ... `<!-- pcs:end -->`) into CLAUDE.md, AGENTS.md or `.cursor/rules/pcs.mdc` for agents without hooks. Only that block is ever changed; a file that held nothing else is deleted on uninstall. It is an explicit command because it edits files that belong to the repository.
- **Identity:** the hook agent name and `pcs mcp --agent` should match, or one agent's work is split over two sessions.
## Signed anchor

- `pcs anchor` writes a small JSON (head hash, last event id, count, timestamp) signed with a local ed25519 key. The key lives in the workspace dir (`~/.pcs/anchor.key`, or `PCS_HOME`), not in the project, so whoever can rewrite `.pcs` cannot forge anchors.
- `pcs verify --anchor <file>` runs the full integrity check, then checks the signature, that the key is this machine's, and that the anchored event still exists with the same hash and count. This catches truncation of the newest events and a full recomputed rewrite, which the hash chain alone cannot.
- Keep the anchor file outside the project (another disk, a commit, a ticket). Local only: no network. Anchors are not rotated; a lost key means old anchors can no longer be trusted by `verify`.
- Creating an anchor on a log that already fails verification is refused.
