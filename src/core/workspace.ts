import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { requireInitializedRoot, withDb } from "./context";
import { PcsError } from "./errors";
import { canonicalPath } from "./paths";
import { getStatus } from "./project";

/**
 * A workspace is just a list of projects on this machine. Each project keeps its own
 * `.pcs/` (its own hash-chained log); nothing is merged or shared between them.
 */
export interface WorkspaceEntry {
  name: string;
  root: string;
}

export const MAX_PROJECTS = 100;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function workspaceDir(): string {
  return process.env.PCS_HOME && process.env.PCS_HOME.trim() !== "" ? resolve(process.env.PCS_HOME) : join(homedir(), ".pcs");
}
export function workspaceFile(): string {
  return join(workspaceDir(), "workspace.json");
}

function norm(p: string): string {
  const r = canonicalPath(p).replace(/\\/g, "/");
  return process.platform === "win32" ? r.toLowerCase() : r;
}

export function loadWorkspace(): WorkspaceEntry[] {
  let raw: string;
  try {
    raw = readFileSync(workspaceFile(), "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw new PcsError("INVALID_INPUT", `Cannot read ${workspaceFile()}.`);
  }
  try {
    const v = JSON.parse(raw) as { projects?: unknown };
    if (!Array.isArray(v.projects)) throw new Error("projects");
    return v.projects.filter(
      (p): p is WorkspaceEntry =>
        typeof p === "object" && p !== null && typeof (p as WorkspaceEntry).name === "string" && typeof (p as WorkspaceEntry).root === "string" && NAME_RE.test((p as WorkspaceEntry).name),
    );
  } catch {
    throw new PcsError("INVALID_INPUT", `${workspaceFile()} is not a valid workspace file. Fix or delete it.`);
  }
}

function saveWorkspace(projects: WorkspaceEntry[]): void {
  mkdirSync(workspaceDir(), { recursive: true, mode: 0o700 });
  const tmp = `${workspaceFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, workspaceFile());
}

function cleanName(raw: string): string {
  const n = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64);
  return n === "" ? "project" : n;
}

/** Register the (initialized) project containing `cwd`. Registering the same project again is a no-op. */
export async function addProject(cwd: string, name?: string): Promise<{ entry: WorkspaceEntry; added: boolean }> {
  const root = (await requireInitializedRoot(cwd)).replace(/\\/g, "/");
  const projects = loadWorkspace();
  const existing = projects.find((p) => norm(p.root) === norm(root));
  if (existing) return { entry: existing, added: false };
  if (projects.length >= MAX_PROJECTS) throw new PcsError("INVALID_INPUT", `A workspace holds at most ${MAX_PROJECTS} projects.`);

  let chosen: string;
  if (name !== undefined) {
    if (!NAME_RE.test(name)) throw new PcsError("INVALID_INPUT", "Project name must be 1-64 characters: letters, digits, . _ - (starting with a letter or digit).");
    if (projects.some((p) => p.name === name)) throw new PcsError("INVALID_INPUT", `A project named "${name}" is already registered.`);
    chosen = name;
  } else {
    const base = cleanName(basename(root));
    chosen = base;
    for (let i = 2; projects.some((p) => p.name === chosen); i++) chosen = `${base}-${i}`;
  }
  const entry = { name: chosen, root };
  saveWorkspace([...projects, entry]);
  return { entry, added: true };
}

export function removeProject(ref: string): WorkspaceEntry {
  const projects = loadWorkspace();
  const hit = projects.find((p) => p.name === ref) ?? projects.find((p) => norm(p.root) === norm(ref));
  if (!hit) throw new PcsError("INVALID_INPUT", `No registered project "${ref}". See \`pcs workspace list\`.`);
  saveWorkspace(projects.filter((p) => p !== hit));
  return hit; // the project's own .pcs is left untouched
}

/** Pick one project out of `projects` by name (or by path). With no reference, only an unambiguous single project works. */
export function pickProject(projects: WorkspaceEntry[], ref?: string): WorkspaceEntry {
  if (projects.length === 0) throw new PcsError("INVALID_INPUT", "No projects registered. Run `pcs workspace add` inside an initialized project.");
  if (ref === undefined) {
    if (projects.length === 1) return projects[0]!;
    throw new PcsError("INVALID_INPUT", `Several projects are available: pass the project name (${projects.map((p) => p.name).join(", ")}).`);
  }
  const hit = projects.find((p) => p.name === ref);
  if (!hit) throw new PcsError("INVALID_INPUT", `Unknown project "${ref.slice(0, 80)}". Available: ${projects.map((p) => p.name).join(", ")}.`);
  return hit;
}

export interface ProjectSummary {
  name: string;
  root: string;
  ok: boolean;
  error?: string;
  branch?: string;
  head?: string | null;
  changedFiles?: number;
  session?: { id: number; agent: string; since: string } | null;
  openTasks?: number;
  integrity?: boolean;
  watcher?: "running" | "not running";
  lastHandoff?: string | null;
  lastEvent?: string | null;
}

/** One line of state per registered project. A broken project never hides the others. */
export async function workspaceStatus(entries: WorkspaceEntry[] = loadWorkspace()): Promise<ProjectSummary[]> {
  return Promise.all(
    entries.map(async (e): Promise<ProjectSummary> => {
      try {
        const s = await getStatus(e.root);
        const times = await withDb(e.root, (db) => ({
          handoff: (db.prepare("SELECT ts FROM events WHERE type = 'handoff.generated' ORDER BY id DESC LIMIT 1").get() as { ts: string } | undefined)?.ts ?? null,
          last: (db.prepare("SELECT ts FROM events ORDER BY id DESC LIMIT 1").get() as { ts: string } | undefined)?.ts ?? null,
        }));
        return {
          name: e.name,
          root: e.root,
          ok: true,
          branch: s.git.branch,
          head: s.git.head ? s.git.head.hash.slice(0, 7) : null,
          changedFiles: s.git.changed.length,
          session: s.session ? { id: s.session.id, agent: s.session.agent, since: s.session.started_at } : null,
          openTasks: s.openTasks.length,
          integrity: s.integrity.ok,
          watcher: s.watcher.running ? "running" : "not running",
          lastHandoff: times.handoff,
          lastEvent: times.last,
        };
      } catch (err) {
        return { name: e.name, root: e.root, ok: false, error: err instanceof PcsError ? err.message : "Cannot read this project." };
      }
    }),
  );
}
