import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isOwnerOnly, secureDir } from "./acl";
import { claudeHooksStatus } from "./agents";
import { autostartStatus, type AutostartEnv } from "./autostart";
import { loadPolicy } from "./config";
import { withDb } from "./context";
import { dbPath, pcsDir } from "./db";
import { findGitRoot } from "./git";
import { verifyIntegrity } from "./integrity";
import { MIGRATIONS } from "./migrations";
import { readWatcherState } from "./watcher";
import { loadWorkspace } from "./workspace";

export const MIN_NODE = [22, 13] as const;

export type CheckStatus = "ok" | "warn" | "fail";
export interface Check {
  id: string;
  status: CheckStatus;
  title: string;
  detail?: string;
  /** What to run or change to resolve it. */
  fix?: string;
}
export interface DoctorReport {
  ok: boolean;
  checks: Check[];
}

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, windowsHide: true, timeout: 15_000, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

export function nodeVersionOk(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/**
 * Diagnose the environment and the current project. Read-only apart from what opening the database already does
 * (schema migration). Never prints project content.
 */
export async function runDoctor(cwd: string, env: AutostartEnv = {}, opts: { fix?: boolean } = {}): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (c: Check) => void checks.push(c);

  add(
    nodeVersionOk(process.version)
      ? { id: "node", status: "ok", title: `Node ${process.version}` }
      : { id: "node", status: "fail", title: `Node ${process.version} is too old`, fix: `Install Node ${MIN_NODE[0]}.${MIN_NODE[1]} or newer (pcs uses the built-in node:sqlite).` },
  );
  add({ id: "sqlite", status: "ok", title: "node:sqlite ExperimentalWarning is suppressed by pcs (hooks and MCP stderr stay quiet)" });

  const g = await run("git", ["--version"]);
  add(g.code === 0 ? { id: "git", status: "ok", title: g.out } : { id: "git", status: "fail", title: "git was not found in PATH", fix: "Install git and make sure it is on PATH." });

  const workspace = loadWorkspace();
  const missing = workspace.filter((p) => !existsSync(p.root));
  add(
    missing.length === 0
      ? { id: "workspace", status: "ok", title: `Workspace: ${workspace.length} registered project${workspace.length === 1 ? "" : "s"}` }
      : {
          id: "workspace",
          status: "warn",
          title: `Workspace lists ${missing.length} folder${missing.length === 1 ? "" : "s"} that no longer exist`,
          detail: missing.map((p) => p.name).join(", "),
          fix: "pcs workspace remove <name>",
        },
  );

  let root: string | null = null;
  try {
    root = await findGitRoot(cwd);
  } catch (e) {
    add({ id: "project", status: "fail", title: (e as Error).message });
  }
  if (!root) {
    if (!checks.some((c) => c.id === "project")) add({ id: "project", status: "fail", title: "Not inside a git repository", fix: "cd into your project, or run `git init`." });
    return finish(checks);
  }
  if (!existsSync(dbPath(root))) {
    add({ id: "project", status: "fail", title: "PCS is not initialized in this repository", fix: "pcs init" });
    return finish(checks);
  }
  add({ id: "project", status: "ok", title: "Project initialized" });

  try {
    const r = await withDb(root, (db) => {
      const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      return { version: v, integrity: verifyIntegrity(db) };
    });
    add({ id: "schema", status: "ok", title: `Database schema v${r.version} (current: v${MIGRATIONS.length})` });
    add(
      r.integrity.ok
        ? { id: "integrity", status: "ok", title: `Event log intact (${r.integrity.count} events)` }
        : {
            id: "integrity",
            status: "fail",
            title: `Integrity check failed: ${r.integrity.reason ?? "unknown"}`,
            fix: "Do not trust this history. Compare with a saved anchor (`pcs verify --anchor <file>`) or restore .pcs from a backup.",
          },
    );
  } catch (e) {
    add({ id: "schema", status: "fail", title: (e as Error).message, fix: (e as { code?: string }).code === "SCHEMA_TOO_NEW" ? "Upgrade pcskit." : undefined });
  }

  const ignored = await run("git", ["check-ignore", "-q", ".pcs/"], root);
  add(
    ignored.code === 0
      ? { id: "ignored", status: "ok", title: ".pcs/ is ignored by git" }
      : { id: "ignored", status: "warn", title: ".pcs/ is not ignored by git, so it could be committed", fix: "Add `.pcs/` to .gitignore (pcs init normally adds it to .git/info/exclude)." },
  );

  {
    let fixed = false;
    if (opts.fix === true && !isOwnerOnly(pcsDir(root))) fixed = secureDir(pcsDir(root));
    const fix = process.platform === "win32" ? "pcs doctor --fix" : "pcs doctor --fix (or chmod -R go-rwx .pcs)";
    add(
      isOwnerOnly(pcsDir(root))
        ? { id: "permissions", status: "ok", title: fixed ? ".pcs access restricted to you (fixed)" : ".pcs is accessible to you only" }
        : { id: "permissions", status: "warn", title: ".pcs may be readable by other users", fix },
    );
  }
  try {
    const policy = loadPolicy(root);
    add({ id: "config", status: "ok", title: policy.sources.length === 0 ? "No config files (defaults)" : `Config OK (${policy.sources.length} file${policy.sources.length === 1 ? "" : "s"})` });
  } catch (e) {
    add({ id: "config", status: "fail", title: (e as Error).message, fix: "Fix or remove the config file (see `pcs config show`)." });
  }

  const w = readWatcherState(root);
  add(
    w.running
      ? { id: "watcher", status: "ok", title: `Watcher running (pid ${w.pid})` }
      : { id: "watcher", status: "warn", title: w.stale ? "Watcher is not running (its lock is stale)" : "Watcher is not running", fix: "pcs watch (or `pcs autostart install` to start it at login)" },
  );
  try {
    const a = await autostartStatus(root, env);
    add(a.installed ? { id: "autostart", status: "ok", title: "Watcher autostart installed" } : { id: "autostart", status: "warn", title: "Watcher autostart is not installed", fix: "pcs autostart install" });
  } catch {
    /* unsupported platform: nothing to report */
  }

  try {
    const hooks = await claudeHooksStatus(root);
    const any = hooks.filter((h) => h.installed.length > 0);
    add(
      any.length > 0
        ? { id: "hooks", status: "ok", title: `Claude Code hooks installed (${any.map((h) => h.scope).join(", ")})` }
        : { id: "hooks", status: "warn", title: "No Claude Code hooks installed (sessions start and end only when the agent calls PCS itself)", fix: "pcs hooks install" },
    );
  } catch {
    /* nothing to report */
  }

  return finish(checks);
}

function finish(checks: Check[]): DoctorReport {
  return { ok: !checks.some((c) => c.status === "fail"), checks };
}

export function formatDoctor(r: DoctorReport): string {
  const mark = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]" } as const;
  const lines: string[] = [];
  for (const c of r.checks) {
    lines.push(`${mark[c.status]} ${c.title}`);
    if (c.detail) lines.push(`       ${c.detail}`);
    if (c.fix && c.status !== "ok") lines.push(`       fix: ${c.fix}`);
  }
  const fails = r.checks.filter((c) => c.status === "fail").length;
  const warns = r.checks.filter((c) => c.status === "warn").length;
  lines.push("", fails > 0 ? `${fails} problem${fails === 1 ? "" : "s"}, ${warns} warning${warns === 1 ? "" : "s"}.` : warns > 0 ? `No problems, ${warns} warning${warns === 1 ? "" : "s"}.` : "Everything looks good.");
  return lines.join("\n");
}
