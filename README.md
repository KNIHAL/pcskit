# PCS: Project Continuity System

Local-first, AI-independent continuity for software projects. When an AI agent stops mid-task (token limit, new session, switching providers), PCS reconstructs the real project state from git and recorded evidence so the next agent can continue.

Rules for AI agents: [AGENTS.md](AGENTS.md). Decisions and security model: [docs/DECISIONS.md](docs/DECISIONS.md).

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
| `pcs resume [--agent name] [--json]` | Pick up the latest handoff: verify it, snapshot the repo, warn about drift, print the brief and record the pickup |
| `pcs watch [--debounce s] [--stalled min]` / `--stop` / `--status` | Background watcher: snapshot on file or HEAD changes, infer stalled sessions |
| `pcs workspace add [path] [--name n]` / `remove <project>` / `list` | Work across several projects: register initialized repos and see all their states in one list (each keeps its own `.pcs`) |
| `pcs dashboard [--port n] [--open] [--workspace]` | Read-only local web dashboard: sessions, tasks with evidence, notes, test runs, snapshots, timeline (127.0.0.1 only, token in the URL) |
| `pcs mcp [--project dir] [--workspace] [--agent name] [--allow-test]` | Run PCS as an MCP server (stdio) so agents call the pcs tools themselves |
| `pcs task add <title> [--agent n]` | Add a task |
| `pcs task list [--status s]` | List tasks |
| `pcs task update <id> --status s [--note t] [--agent n]` | Change task status |

## Layout
- `src/core`: all logic (git adapter, SQLite store, events, sessions, snapshots, tasks, redaction)
- `src/cli`: argument parsing and output only
- `tests`: vitest suites


## Use PCS from an agent (MCP)
Add this to the MCP config of Claude Desktop, Cursor or any MCP client (use the real paths):
```json
{
  "mcpServers": {
    "pcs": {
      "command": "node",
      "args": ["D:/pcs/dist/cli.js", "mcp", "--project", "D:/your-project", "--agent", "claude"]
    }
  }
}
```
Tools: `pcs_status`, `pcs_verify`, `pcs_resume`, `pcs_handoff`, `pcs_session_start|end`, `pcs_snapshot`, `pcs_task_add|list|update`, `pcs_note_add|list|resolve`, `pcs_evidence_list`. Start with `pcs_resume`. `pcs_test` (runs a command on your machine) exists only with `--allow-test`.
### Several repos at once
Run `pcs init` in each repo, then `pcs workspace add` inside each. `pcs workspace list` shows all of them (branch, changes, active agent, last handoff, integrity). Serve them all to an agent with `pcs mcp --workspace --agent claude`: every tool then takes a `project` argument (the names from `pcs_workspace_status`). `pcs dashboard --workspace` adds a project picker. The registry lives in `~/.pcs/workspace.json` (override with `PCS_HOME`).
## License
Apache-2.0. See [LICENSE](LICENSE).
