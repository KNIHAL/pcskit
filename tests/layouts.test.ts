import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addNote,
  addTask,
  createHandoff,
  getStatus,
  initProject,
  listNotes,
  resume,
  runDoctor,
  runTest,
  startSession,
  takeSnapshot,
  verifyProject,
} from "../src/core";
import { canonicalPath } from "../src/core/paths";

const made: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" } }).trim();
}

function tmp(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
}

function makeRepo(prefix = "pcs-lay-", withCommit = true): string {
  const d = tmp(prefix);
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.email", "t@t.dev");
  git(d, "config", "user.name", "Test");
  git(d, "config", "protocol.file.allow", "always");
  if (withCommit) {
    writeFileSync(join(d, "a.txt"), "x\n");
    git(d, "add", "a.txt");
    git(d, "commit", "-q", "-m", "init");
  }
  return d;
}

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const untrackedPcs = (cwd: string) => git(cwd, "status", "--porcelain", "-uall").split("\n").filter((l) => l.includes(".pcs"));

describe("git worktrees", () => {
  it("keeps .pcs out of git status in a linked worktree, even when only the worktree is initialized", async () => {
    const main = makeRepo();
    const wt = `${main}-wt`;
    made.push(wt);
    git(main, "worktree", "add", "-q", wt, "-b", "feature");
    await initProject(wt);
    expect(existsSync(join(wt, ".pcs"))).toBe(true);
    expect(untrackedPcs(wt)).toEqual([]);
  });

  it("gives each worktree its own independent evidence log", async () => {
    const main = makeRepo();
    const wt = `${main}-wt`;
    made.push(wt);
    git(main, "worktree", "add", "-q", wt, "-b", "feature");
    await initProject(main);
    await initProject(wt);
    await addNote(main, "next", "main note");
    await addNote(wt, "next", "worktree note");
    expect((await listNotes(main)).map((n) => n.text)).toEqual(["main note"]);
    expect((await listNotes(wt)).map((n) => n.text)).toEqual(["worktree note"]);
    expect((await getStatus(wt)).git.branch).toBe("feature");
    expect((await getStatus(main)).git.branch).toBe("main");
    expect((await verifyProject(wt)).ok).toBe(true);
  });

  it("works end to end in a worktree (session, test run, handoff, resume)", async () => {
    const main = makeRepo();
    const wt = `${main}-wt`;
    made.push(wt);
    git(main, "worktree", "add", "-q", wt, "-b", "feature");
    await initProject(wt);
    await startSession(wt, "agent-a");
    const r = await runTest(wt, [process.execPath, "-e", "process.exit(0)"]);
    expect(r.run.outcome).toBe("passed");
    await addNote(wt, "next", "carry on");
    await createHandoff(wt);
    const res = await resume(wt, { agent: "agent-b" });
    expect(res.brief).toContain("carry on");
    expect(res.checks.integrity.ok).toBe(true);
    expect(res.handoffMarkdown).toContain("carry on");
  });
});

describe("submodules", () => {
  it("initializes inside a submodule without polluting it or the superproject", async () => {
    const lib = makeRepo("pcs-lib-");
    const sup = makeRepo("pcs-sup-");
    git(sup, "submodule", "add", "-q", lib, "libs/lib");
    git(sup, "commit", "-q", "-m", "add submodule");
    const sub = join(sup, "libs", "lib");

    await initProject(sub);
    await initProject(sup);
    expect(untrackedPcs(sub)).toEqual([]);
    expect(untrackedPcs(sup)).toEqual([]);

    await addNote(sub, "next", "inside the submodule");
    expect((await listNotes(sub)).map((n) => n.text)).toEqual(["inside the submodule"]);
    expect(await listNotes(sup)).toEqual([]);
    expect(canonicalPath((await getStatus(sub)).project.root)).toBe(canonicalPath(sub));
    expect(canonicalPath((await getStatus(sup)).project.root)).toBe(canonicalPath(sup));
  });

  it("snapshots and hands off a superproject whose submodule has changes", async () => {
    const lib = makeRepo("pcs-lib-");
    const sup = makeRepo("pcs-sup-");
    git(sup, "submodule", "add", "-q", lib, "libs/lib");
    git(sup, "commit", "-q", "-m", "add submodule");
    await initProject(sup);
    writeFileSync(join(sup, "libs", "lib", "a.txt"), "changed\n");
    writeFileSync(join(sup, "libs", "lib", "new.txt"), "new\n");
    const snap = await takeSnapshot(sup);
    expect(snap.id).toBeGreaterThan(0);
    const h = await createHandoff(sup);
    expect(h.handoff.integrity.ok).toBe(true);
  });
});

describe("monorepos and subdirectories", () => {
  it("resolves the repository root from a package folder and records relative paths", async () => {
    const root = makeRepo();
    const pkg = join(root, "packages", "app");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "index.ts"), "export {}\n");
    await initProject(root);

    const s = await getStatus(pkg);
    expect(canonicalPath(s.project.root)).toBe(canonicalPath(root));
    await addNote(pkg, "next", "from a package folder");
    expect((await listNotes(root)).map((n) => n.text)).toContain("from a package folder");

    const r = await runTest(pkg, [process.execPath, "-e", "process.exit(0)"]);
    expect(r.run.cwd).toBe("packages/app");
    const snap = await takeSnapshot(pkg);
    expect(snap.files.some((f) => f.path === "packages/app/index.ts")).toBe(true);
  });

  it("does not initialize a nested repository's parent by accident", async () => {
    const outer = makeRepo("pcs-outer-");
    const inner = join(outer, "vendor", "inner");
    mkdirSync(inner, { recursive: true });
    git(inner, "init", "-q", "-b", "main");
    await initProject(inner);
    expect(existsSync(join(inner, ".pcs"))).toBe(true);
    expect(existsSync(join(outer, ".pcs"))).toBe(false);
  });
});

describe("unusual repositories and paths", () => {
  it("works in a repository with no commits yet", async () => {
    const d = makeRepo("pcs-empty-", false);
    await initProject(d);
    await addNote(d, "next", "first note");
    const s = await getStatus(d);
    expect(s.git.head).toBeNull();
    const h = await createHandoff(d);
    expect(h.handoff.integrity.ok).toBe(true);
    expect((await runDoctor(d, { exec: async () => ({ code: 1, stdout: "", stderr: "" }) })).ok).toBe(true);
  });

  it("works on a detached HEAD", async () => {
    const d = makeRepo();
    writeFileSync(join(d, "b.txt"), "y\n");
    git(d, "add", "b.txt");
    git(d, "commit", "-q", "-m", "second");
    git(d, "checkout", "-q", "--detach", "HEAD~1");
    await initProject(d);
    const s = await getStatus(d);
    expect(s.git.branch).toMatch(/detached/);
    await addTask(d, "detached task");
    expect((await verifyProject(d)).ok).toBe(true);
  });

  it("works in a folder with spaces, accents and non-Latin characters", async () => {
    const base = tmp("pcs-uni-");
    const d = join(base, "my project é 日本語");
    mkdirSync(d);
    git(d, "init", "-q", "-b", "main");
    git(d, "config", "user.email", "t@t.dev");
    git(d, "config", "user.name", "Test");
    writeFileSync(join(d, "ファイル.txt"), "x\n");
    git(d, "add", ".");
    git(d, "commit", "-q", "-m", "init");
    await initProject(d);
    writeFileSync(join(d, "ファイル.txt"), "changed\n");
    writeFileSync(join(d, "new file é.txt"), "n\n");
    const s = await getStatus(d);
    const names = s.git.changed.map((f) => f.path);
    expect(names).toEqual(expect.arrayContaining(["ファイル.txt", "new file é.txt"]));
    expect((await takeSnapshot(d)).id).toBeGreaterThan(0);
    const r = await runTest(d, [process.execPath, "-e", "process.exit(0)"]);
    expect(r.run.outcome).toBe("passed");
  });

  it.skipIf(process.platform === "win32")("treats a symlinked project path as the same project", async () => {
    const real = makeRepo();
    const holder = tmp("pcs-link-");
    const link = join(holder, "link");
    symlinkSync(real, link, "dir");
    await initProject(real);
    await addNote(link, "next", "via the symlink");
    expect((await listNotes(real)).map((n) => n.text)).toEqual(["via the symlink"]);
    expect(canonicalPath((await getStatus(link)).project.root)).toBe(canonicalPath(real));
  });

  it("ignores files in .gitignore and still reports a deleted tracked file", async () => {
    const d = makeRepo();
    writeFileSync(join(d, ".gitignore"), "secret-build/\n");
    git(d, "add", ".gitignore");
    git(d, "commit", "-q", "-m", "ignore");
    await initProject(d);
    mkdirSync(join(d, "secret-build"));
    writeFileSync(join(d, "secret-build", "out.js"), "x");
    rmSync(join(d, "a.txt"));
    const s = await getStatus(d);
    expect(s.git.changed.map((f) => f.path)).toContain("a.txt");
    expect(s.git.changed.map((f) => f.path).some((p) => p.startsWith("secret-build"))).toBe(false);
  });
});
