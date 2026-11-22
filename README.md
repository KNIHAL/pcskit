# PCS: Project Continuity System

**Your AI agent stopped. The next one picks up exactly where it left off.**

[Website](https://pcskit.causly.in) | [Docs](https://pcskit.causly.in/docs)

[![CI](https://github.com/KNIHAL/pcskit/actions/workflows/ci.yml/badge.svg)](https://github.com/KNIHAL/pcskit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@knihal/pcskit)](https://www.npmjs.com/package/@knihal/pcskit)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-339933)](package.json)

PCS is a local-first command line tool and MCP server that hands work from one AI coding agent to the next. When an agent hits a token limit, you start a new chat, or you switch from Claude to Cursor, PCS rebuilds what actually happened in the project from git and recorded evidence, and gives the next agent a brief it can trust.

Never trust an agent's "done". PCS keeps what it saw itself apart from what an agent claimed.

## Why PCS

Agents lose context when a session ends. The usual fix is a summary written by the agent that just ran out of room, which is exactly the part you cannot trust: it may say tests pass when they never ran, or forget the file it was halfway through editing.

PCS records facts with their source, so the next agent knows which lines are solid:

| Level | Meaning | Example |
| --- | --- | --- |
| `verified` | PCS observed it itself | git state, file hashes, a test run PCS executed with its exit code |
| `reported` | A person or agent claimed it | "task done", "next step is X" |
| `inferred` | Derived from other facts | "the session was interrupted" |

A task counts as verified only when a passing test run that PCS executed is linked to it, and only while the code still matches the state that run saw.

## Quick start

You need Node.js 22.13 or newer and git.

```
npm install -g @knihal/pcskit
cd your-repo
pcs init
```

Connect the agents you use (one command each, `--remove` undoes it):

```
pcs connect claude-desktop
pcs connect cursor
pcs connect claude-code
```

Tell agents how to use PCS, and for Claude Code let hooks do it automatically:

```
pcs agents install      # adds a marked block to CLAUDE.md, AGENTS.md, .cursor/rules
pcs hooks install       # Claude Code: sessions start, checkpoint and end by themselves
```

Check that everything is in place:

```
pcs doctor
```

Details for each app: [docs/CLIENTS.md](docs/CLIENTS.md).

## A handoff, step by step

```
pcs session start --agent claude
pcs note add task "Add the --json flag to the exporter"
pcs test --task <task-id> -- npm test        # PCS runs it and records the result
pcs note add next "Wire the flag in src/cli/export.ts, then update the tests"
pcs session end --reason limit
pcs handoff                                   # writes .pcs/HANDOFF.md
```

The next agent, in any tool:

```
pcs resume --agent cursor
```

Resume checks the handoff against the evidence log, snapshots the repo, warns if the code moved since the handoff, and prints the brief. Every line carries its level: `[verified]`, `[reported by claude]` or `[inferred]`. With MCP connected, agents call `pcs_resume` and `pcs_handoff` themselves. No agent running? `pcs resume --prompt` prints a ready-to-paste takeover prompt.

If an agent died before writing a handoff, PCS builds one from the evidence log and marks the interrupted session as `inferred`.

## What you get

- **Handoffs you can trust.** Original task, completed work (verified, passing-but-code-changed, or reported only), work in progress, files touched, test results with the output of failing runs, open problems, next steps and do-not-touch notes.
- **Tamper-evident history.** Events are stored in an append-only SHA-256 hash chain. `pcs verify` detects edits, deletions and reordering. A signed anchor kept outside the project also detects truncation and rewrites.
- **Audit export.** `pcs export` writes the log as JSON or Markdown that can be checked without PCS.
- **Secrets stay out.** Redaction runs before anything is stored. Files flagged sensitive (keys, `.env`) are listed by name and never read.
- **Works with your agents.** MCP server for any MCP client, Claude Code hooks, and instruction blocks for CLAUDE.md, AGENTS.md and Cursor rules.
- **Always on, if you want.** A background watcher snapshots the repo as files change and flags stalled sessions; `pcs autostart install` starts it at login.
- **Many repos.** `pcs workspace` lists all your projects; each keeps its own log.
- **Read-only dashboard.** `pcs dashboard` shows sessions, tasks with their evidence, notes, test runs and the event timeline on 127.0.0.1.

## Commands

| Area | Commands |
| --- | --- |
| Setup | `init`, `doctor [--fix]`, `deinit`, `config show\|init`, `connect`, `agents install\|uninstall`, `hooks install\|uninstall\|status`, `autostart install\|uninstall\|status` |
| Work | `session start\|end\|current\|list`, `task add\|list\|update`, `note add\|list\|resolve`, `snapshot [take\|list\|diff]`, `test -- <command>`, `evidence list\|show\|link` |
| Handoff | `handoff`, `resume [--prompt]`, `status`, `watch` |
| Trust | `verify [--anchor]`, `anchor`, `log`, `export` |
| Many projects | `workspace add\|remove\|list`, `dashboard [--workspace]`, `mcp [--workspace]` |

Run `pcs <command> --help` for options. Several commands accept `--json` for scripts.

## MCP tools

Start the server with `pcs mcp` (or let `pcs connect` write the config). Tools: `pcs_status`, `pcs_verify`, `pcs_resume`, `pcs_handoff`, `pcs_session_start`, `pcs_session_end`, `pcs_snapshot`, `pcs_task_add`, `pcs_task_list`, `pcs_task_update`, `pcs_note_add`, `pcs_note_list`, `pcs_note_resolve`, `pcs_evidence_list`, `pcs_workspace_status`. Agents should start with `pcs_resume`.

- `--read-only` exposes only tools that cannot change anything.
- `pcs_test`, which runs a command on your machine, is off unless you pass `--allow-test`.
- Recorded content is returned as data, with control characters stripped, and the server instructions tell the model not to follow it.

## Security model

PCS reads repositories and agent output that it does not trust, so it is built defensively.

- Local only: no network access and no telemetry. Data lives in `.pcs/` inside your project, git-excluded and owner-only (POSIX modes, Windows ACLs).
- Git is run read-only with a hardened adapter: no repo-defined commands, no optional locks, timeouts, validated hashes.
- Commands are argument arrays, never shell strings. `pcs test` can be limited to an allowlist.
- Untrusted text is sanitized before it reaches the terminal, markdown or the dashboard.
- Policy files can only tighten defaults. The global file is the trusted one, because a project file can be edited by an agent.

Honest limits: the hash chain proves changes only if you keep the anchor or an export somewhere else; redaction is pattern based, so add your own rules for your secrets; and `reported` claims are labelled, not proven. Full reasoning is in [docs/DECISIONS.md](docs/DECISIONS.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Platform support

Tested in CI on Linux, Windows and macOS with Node 22 and 24, including git worktrees and submodules, concurrent writers and fuzzed input.

## Uninstall

`pcs deinit` removes everything PCS added to a project: the `.pcs` folder, hooks, instruction blocks and the login entry. `pcs connect <app> --remove` removes the MCP entry.

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md); everyone is expected to follow the [code of conduct](CODE_OF_CONDUCT.md). Rules for AI agents working on this repository are in [AGENTS.md](AGENTS.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
