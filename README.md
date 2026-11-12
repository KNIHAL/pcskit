# PCS: Project Continuity System

Local-first, AI-independent continuity for software projects. When an AI agent stops mid-task (token limit, new session, switching providers), PCS reconstructs the real project state from git and recorded evidence so the next agent can continue.

Status and roadmap: [docs/STATUS.md](docs/STATUS.md). Rules for AI agents: [AGENTS.md](AGENTS.md). Decisions and security model: [docs/DECISIONS.md](docs/DECISIONS.md).

## Requirements
Node.js >= 22.13, git.

## Develop
```
npm install
npm run typecheck
npm test
npm run build
node dist/cli.js --help
```

## Commands (v0.1)
| Command | What it does |
| --- | --- |
| `pcs init` | Register the current git repo (creates git-excluded `.pcs/`) |
| `pcs status [--json]` | Real git state, active session, open tasks, log integrity |
| `pcs verify` | Verify the event log and snapshots are untampered (exit 2 if broken) |
| `pcs session start --agent <name>` | Start a session (an unended one is marked interrupted) and snapshot the repo |
| `pcs session end [--reason r] [--note t]` | End it (`completed`, `limit`, `switched`) and snapshot the repo |
| `pcs session current` / `pcs session list` | Show active / recent sessions |
| `pcs snapshot` | Record a verified snapshot now (git state + content hashes) |
| `pcs snapshot list` | List snapshots |
| `pcs snapshot diff [from] [to] [--session id]` | What changed between snapshots, plus commits made in between |
| `pcs test [--task id] [--timeout s] -- <command>` | Run a command and record the result as verified evidence (optionally linked to a task) |
| `pcs evidence list` / `show <id>` / `link <task> <run>` | Browse test runs; point a task at a run |
| `pcs note add <kind> <text>` / `list` / `resolve <id>` | Record the original task (`task`), exact next steps (`next`), do-not-touch (`avoid`) and known problems (`issue`) |
| `pcs handoff [--session id] [--out file] [--stdout]` | Write `.pcs/HANDOFF.md` for the next agent, with verified / reported / inferred kept apart |
| `pcs task add <title> [--agent n]` | Add a task |
| `pcs task list [--status s]` | List tasks |
| `pcs task update <id> --status s [--note t] [--agent n]` | Change task status |

## Layout
- `src/core`: all logic (git adapter, SQLite store, events, sessions, snapshots, tasks, redaction)
- `src/cli`: argument parsing and output only
- `tests`: vitest suites
