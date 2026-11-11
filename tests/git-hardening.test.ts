import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGitState } from "../src/core";

let dir: string;
let marker: string;

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pcs-git-"));
  marker = join(tmpdir(), `pcs-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.PCS_TEST_MARKER = marker;
  git("init", "-q");
  git("config", "user.email", "t@t.dev");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
});

afterEach(() => {
  delete process.env.PCS_TEST_MARKER;
  rmSync(dir, { recursive: true, force: true });
  rmSync(marker, { force: true });
});

describe("git adapter hardening", () => {
  it("does not execute a repo-configured core.fsmonitor command", async () => {
    git(
      "config",
      "core.fsmonitor",
      `node -e "require('node:fs').writeFileSync(process.env.PCS_TEST_MARKER, 'ran')"`,
    );

    // Control: plain git DOES run the hook, so the test is meaningful.
    git("status");
    expect(existsSync(marker)).toBe(true);
    unlinkSync(marker);

    const state = await getGitState(dir);
    expect(state.isRepo).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("flags sensitive files in the changed list", async () => {
    writeFileSync(join(dir, ".env"), "X=1\n");
    writeFileSync(join(dir, "app.ts"), "export {}\n");
    const state = await getGitState(dir);
    if (!state.isRepo) throw new Error("expected repo");
    expect(state.changed.find((f) => f.path === ".env")?.sensitive).toBe(true);
    expect(state.changed.find((f) => f.path === "app.ts")?.sensitive).toBe(false);
  });

  it("does not modify the repo just by observing it", async () => {
    const before = git("status", "--porcelain");
    await getGitState(dir);
    expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false);
    expect(git("status", "--porcelain")).toBe(before);
  });
});
