# Instructions for any AI agent working on PCS

1. Read `README.md` for what PCS is and `docs/DECISIONS.md` before touching storage, git or security code.
2. Work on **one step at a time**. Inspect existing code before changing it; do not assume.
3. Never say a step is done without running, in this order: `npx tsc --noEmit`, `npm test`, `npm run build`. Add tests for every new behavior, including failure cases.
4. Keep logic in `src/core`. `src/cli` only parses arguments and prints. (MCP, hooks and dashboard wrap core.)
5. Schema changes: append a new entry to `MIGRATIONS` in `src/core/migrations.ts`. Never edit a shipped one.
6. Every recorded fact needs a provenance (`verified` / `reported` / `inferred`). An AI's "done" is `reported`, never `verified`.
7. Security rules: no network access, no telemetry; run git only through `src/core/git.ts`; redact before storing; never read the content of files flagged `sensitive`; sanitize repo-controlled strings before printing.
8. Record non-obvious decisions in `docs/DECISIONS.md` and user-visible changes in `CHANGELOG.md`.

## Environment and git rules
- Windows + PowerShell: no `&&` chaining (use `;` or separate commands).
- Node >= 22.13 using built-in `node:sqlite`. Do not add native dependencies (they fail to build here).
- Work on a branch and open a pull request; never push to `main`. Keep commit messages short and stage specific files.
- Do not modify files outside the task without asking the owner.
