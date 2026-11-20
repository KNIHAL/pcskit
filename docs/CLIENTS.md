# Connecting agents

`pcs connect <client>` writes the PCS MCP server into the app's config. It keeps your other servers, never overwrites a file it cannot parse, and `--remove` undoes it.

| Client | Command | Config file | After connecting |
|---|---|---|---|
| Claude Desktop | `pcs connect claude-desktop` | `%APPDATA%\Claude\claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Linux: `~/.config/Claude/`) | Quit Claude Desktop fully and reopen |
| Cursor (project) | `pcs connect cursor` | `.cursor/mcp.json` | Reload Cursor, Settings > MCP |
| Cursor (all projects) | `pcs connect cursor --global` | `~/.cursor/mcp.json` | same |
| Claude Code | `pcs connect claude-code` | `.mcp.json` | `/mcp`, approve the server |

Add `pcs agents install` so the agent is told to call `pcs_resume` first and `pcs_handoff` last. Claude Code can also use `pcs hooks install`.

Options: `--read-only` (no tool can change anything), `--allow-test` (also exposes `pcs_test`, off by default), `--portable` (write plain `pcs` instead of absolute paths; needs `pcs` on the app's PATH).

## What is tested automatically

CI starts the built CLI exactly as the config file says, from a different working directory (as GUI apps do), over real MCP stdio, and runs resume, notes, session end and handoff.

## Manual check in a real app (about 2 minutes)

1. `pcs init`, then `pcs connect <client>` in your project; restart the app.
2. Ask the agent: "Call pcs_resume, add a next note saying 'check the connect docs', end the session, then show the handoff."
3. Run `pcs handoff` in a terminal. The note must appear, marked `reported`.
4. Run `pcs verify`. It must say the log is intact.

If the tools do not show up: run `pcs doctor`, check the config path above, and confirm the app was fully restarted.