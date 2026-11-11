import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStatus, initProject, parsePorcelainZ } from "../src/core";

let dir: string;

function git(...args: string[]) {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pcs-test-"));
  git("init", "-q");
  git("config", "user.email", "t@t.dev");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "b.txt"), "two\n");
  git("add", "a.txt", "b.txt");
  git("commit", "-q", "-m", "initial commit");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("parsePorcelainZ", () => {
  it("parses modified, untracked and renamed entries", () => {
    const out = " M src/a.ts\0?? new.ts\0R  new-name.ts\0old-name.ts\0";
    const files = parsePorcelainZ(out);
    expect(files).toHaveLength(3);
    expect(files[0]).toMatchObject({ path: "src/a.ts", worktree: "M", untracked: false });
    expect(files[1]).toMatchObject({ path: "new.ts", untracked: true });
    expect(files[2]).toMatchObject({ path: "new-name.ts", index: "R" });
  });
});

describe("initProject", () => {
  it("creates .pcs, excludes it from git, and is idempotent", async () => {
    const first = await initProject(dir);
    expect(first.alreadyInitialized).toBe(false);
    expect(existsSync(join(dir, ".pcs", "pcs.db"))).toBe(true);
    expect(readFileSync(join(dir, ".git", "info", "exclude"), "utf8")).toContain(".pcs/");

    const second = await initProject(dir);
    expect(second.alreadyInitialized).toBe(true);
  });

  it("fails outside a git repo", async () => {
    const plain = mkdtempSync(join(tmpdir(), "pcs-plain-"));
    await expect(initProject(plain)).rejects.toThrow(/git repository/);
    rmSync(plain, { recursive: true, force: true });
  });
});

describe("getStatus", () => {
  it("fails before init", async () => {
    await expect(getStatus(dir)).rejects.toThrow(/not initialized/);
  });

  it("reports branch, head and real changes from git", async () => {
    await initProject(dir);
    writeFileSync(join(dir, "a.txt"), "changed\n");
    writeFileSync(join(dir, "c.txt"), "new\n");
    renameSync(join(dir, "b.txt"), join(dir, "b2.txt"));

    const s = await getStatus(dir);
    expect(s.git.head?.subject).toBe("initial commit");
    expect(s.git.branch).not.toBe("");
    const paths = s.git.changed.map((f) => f.path).sort();
    expect(paths).toEqual(["a.txt", "b.txt", "b2.txt", "c.txt"]);
    expect(s.git.changed.find((f) => f.path === "c.txt")?.untracked).toBe(true);
    expect(s.git.changed.some((f) => f.path.startsWith(".pcs"))).toBe(false);
    expect(s.recentEvents[0]?.type).toBe("project.init");
  });
});
