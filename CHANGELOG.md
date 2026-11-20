# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-20

First release.

### Added

- Evidence model: every fact is `verified`, `reported` or `inferred`, and handoffs keep them apart.
- Core commands: `init`, `status`, `verify`, `session`, `snapshot`, `task`, `note`, `test`, `evidence`, `handoff`, `resume` (with `--prompt`).
- Tamper-evident event log (SHA-256 hash chain), signed anchor, self-checking `export`, `log`.
- Redaction before storage; policy files (`config`) that can only tighten defaults; owner-only access on POSIX and Windows.
- MCP server (`mcp`, `--read-only`, `--allow-test`) and `connect` for Claude Desktop, Cursor and Claude Code.
- Claude Code hooks and instruction blocks for CLAUDE.md, AGENTS.md and Cursor rules (`hooks`, `agents`).
- Watcher with autostart at login, multi-repo `workspace`, read-only local `dashboard`.
- `doctor [--fix]` and `deinit`.