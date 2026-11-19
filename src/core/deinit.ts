import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { uninstallAgentInstructions, uninstallClaudeHooks } from "./agents";
import { uninstallAutostart, type AutostartEnv } from "./autostart";
import { dbPath, PCS_DIR, pcsDir } from "./db";
import { PcsError } from "./errors";
import { findGitRoot } from "./git";
import { canonicalPath } from "./paths";
import { readWatcherState, requestStop } from "./watcher";
import { loadWorkspace, removeProject } from "./workspace";

export interface DeinitResult {
  root: string;
  dryRun: boolean;
  /** What was (or, in a dry run, would be) removed. */
  removed: string[];
  /** What is deliberately left alone, and why. */
  kept: string[];
}

async function waitForWatcherStop(root: string, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!readWatcherState(root).running) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return !readWatcherState(root).running;
}

/**
 * Remove everything PCS added to this project: the `.pcs` folder (database, evidence, handoff, config), the git
 * exclude line, project/local Claude hooks, the instruction block in CLAUDE.md / AGENTS.md / Cursor rules, the
 * login entry for the watcher and the workspace registration. Without `yes` nothing is changed and the plan is returned.
 */
export async function deinitProject(cwd: string, opts: { yes?: boolean; env?: AutostartEnv } = {}): Promise<DeinitResult> {
  const root = await findGitRoot(cwd);
  if (!root) throw new PcsError("NOT_GIT_REPO", "Not inside a git repository.");
  if (!existsSync(pcsDir(root))) throw new PcsError("NOT_INITIALIZED", "PCS is not initialized here; nothing to remove.");
  const dryRun = opts.yes !== true;
  const removed: string[] = [];
  const kept: string[] = [
    "user-level Claude hooks (shared by every project; they do nothing in a project without .pcs: `pcs hooks uninstall --scope user`)",
    "the signing key for anchors in your PCS home, and any anchor or handoff files you saved outside .pcs",
    "the global config file",
  ];

  const hasDb = existsSync(dbPath(root));
  const watcher = readWatcherState(root);
  if (watcher.running) {
    if (dryRun) removed.push("stop the running watcher");
    else {
      await requestStop(root);
      if (!(await waitForWatcherStop(root))) throw new PcsError("INVALID_INPUT", "The watcher did not stop in time. Run `pcs watch --stop` and try again.");
      removed.push("stopped the running watcher");
    }
  }

  // Everything below needs the project still initialized, so .pcs goes last.
  if (hasDb) {
    const a = dryRun ? null : await uninstallAutostart(root, opts.env ?? {}, root);
    if (dryRun || a?.removed) removed.push("the watcher login entry (if installed)");

    for (const scope of ["project", "local"] as const) {
      try {
        const h = dryRun ? null : await uninstallClaudeHooks(root, { scope });
        if (dryRun || (h && h.removed.length > 0)) removed.push(`Claude Code ${scope} hooks (if installed)`);
      } catch {
        /* no settings file for this scope */
      }
    }
    const blocks = dryRun ? [] : await uninstallAgentInstructions(root);
    if (dryRun || blocks.some((b) => b.status === "removed")) removed.push("the PCS block in CLAUDE.md / AGENTS.md / .cursor/rules (if present)");
  }

  const registered = loadWorkspace().find((p) => canonicalPath(p.root) === canonicalPath(root));
  if (registered) {
    if (!dryRun) removeProject(registered.name);
    removed.push(`the workspace registration "${registered.name}"`);
  }

  const exclude = join(root, ".git", "info", "exclude");
  if (existsSync(exclude)) {
    const lines = readFileSync(exclude, "utf8").split(/\r?\n/);
    if (lines.includes(`${PCS_DIR}/`)) {
      if (!dryRun) writeFileSync(exclude, lines.filter((l) => l !== `${PCS_DIR}/`).join("\n"));
      removed.push(`the ${PCS_DIR}/ line in .git/info/exclude`);
    }
  }

  if (!dryRun) rmSync(pcsDir(root), { recursive: true, force: true });
  removed.push(`the ${PCS_DIR}/ folder (all events, snapshots, evidence and the handoff)`);
  return { root, dryRun, removed, kept };
}
