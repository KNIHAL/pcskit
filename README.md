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
| `pcs status [--json]` | Real git state, open tasks, log integrity |
| `pcs verify` | Verify the tamper-evident event log (exit 2 if broken) |
| `pcs task add <title> [--agent n]` | Add a task |
| `pcs task list [--status s]` | List tasks |
| `pcs task update <id> --status s [--note t] [--agent n]` | Change task status |

## Layout
- `src/core`: all logic (git adapter, SQLite store, events, tasks, redaction)
- `src/cli`: argument parsing and output only
- `tests`: vitest suites
