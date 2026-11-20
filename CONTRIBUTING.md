# Contributing to PCS

Thanks for helping. PCS is small on purpose: a local-first tool that hands work between AI agents and keeps verified, reported and inferred facts apart.

## Before you start

- Bugs and small fixes: open a PR directly.
- New features: open an issue first so we can agree the scope. Read the non-goals in `docs/STATUS.md`; things like cross-machine sync, a central server or a GUI are out of scope for v1.
- Security problems: do not open an issue, see `SECURITY.md`.

## Setup

You need Node 22.13 or newer and git.

```
git clone https://github.com/KNIHAL/pcskit.git
cd pcskit
npm ci
npm run check
```

`npm run check` runs typecheck, lint, build and all tests. CI runs the same on Linux, Windows and macOS with Node 22 and 24, so please run it before you push.

## Ground rules

- TypeScript, no new runtime dependency without a good reason (say why in the PR).
- Every behaviour change needs a test. Bugs get a test that fails before the fix.
- Untrusted input (git output, hook payloads, config files, MCP arguments, agent text) never becomes a command, a path outside the project or unescaped markup.
- The event log is append-only. Schema changes are new migrations in `src/core/migrations.ts`; never edit an old one.
- Keep the three trust levels honest: only what PCS observed itself is `verified`.
- Record non-obvious decisions in `docs/DECISIONS.md`.
- Files are UTF-8 without BOM. A test checks this.

## Pull requests

- One topic per PR, branch from `main`.
- Use a clear title (`feat:`, `fix:`, `docs:`, `test:`, `chore:`) and fill in the PR template: what changed and why.
- Maintainers merge when CI is green.

## Licence

By contributing you agree that your work is released under the Apache-2.0 licence of this project.
