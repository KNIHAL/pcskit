# Security policy

PCS reads your repository and records evidence about it, so we treat security reports seriously.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting:
**Security tab > Report a vulnerability** on https://github.com/KNIHAL/pcskit/security/advisories/new

Include what you found, the steps to reproduce it, and the PCS version (`pcs --version`) and OS. You will get a first reply within 7 days. We will tell you when a fix is released and credit you if you want.

## Supported versions

Only the latest released version gets security fixes.

## What PCS protects, and what it does not

In scope (a report here is a vulnerability):

- Secrets reaching the event log, handoff, export or MCP output despite redaction.
- A way to change or delete log history without `pcs verify` noticing (outside the documented limit below).
- Path traversal, command injection or option injection through any input (CLI, MCP tool arguments, hook payloads, config files, git output).
- A tool exposed over MCP that can change anything when `--read-only` is set, or that runs commands without `--allow-test`.
- Local files or ports reachable by other users or by web pages (the dashboard is meant to be local only).

Known limits (documented, not vulnerabilities):

- The hash chain detects changes only if you keep a copy of the signed anchor or an export elsewhere. Someone who can rewrite both the log and the anchor on your machine can forge history.
- Redaction is pattern based. It cannot recognise every secret format. Add your own rules in the policy file.
- `reported` and `inferred` facts are labelled as such. PCS does not prove an agent told the truth.

See `docs/DECISIONS.md` for the reasoning behind these choices.
