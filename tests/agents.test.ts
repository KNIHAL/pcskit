import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeHooksStatus,
  initProject,
  installAgentInstructions,
  installClaudeHooks,
  parseTargets,
  PcsError,
  uninstallAgentInstructions,
  uninstallClaudeHooks,
} from "../src/core";

let dir: string;
let claudeHome: string;
const oldConfigDir = process.env.CLAUDE_CONFIG_DIR;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

const local = () => join(dir, ".claude", "settings.local.json");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const put = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pcs-agents-"));
  claudeHome = mkdtempSync(join(tmpdir(), "pcs-claude-home-"));
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.dev");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  await initProject(dir);
});

afterEach(() => {
  if (oldConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = oldConfigDir;
  rmSync(dir, { recursive: true, force: true });
  rmSync(claudeHome, { recursive: true, force: true });
});

describe("claude hooks: install", () => {
  it("adds the three hooks with a long enough timeout, in the git-ignored local file by default", async () => {
    const r = await installClaudeHooks(dir);
    expect(r.added).toEqual(["session-start", "pre-compact", "session-end"]);
    expect(r.scope).toBe("local");
    const s = readJson(local());
    expect(s.hooks.SessionStart[0].hooks[0]).toEqual({ type: "command", command: "pcs hook session-start --agent claude-code", timeout: 30 });
    expect(s.hooks.PreCompact[0].hooks[0].command).toBe("pcs hook pre-compact --agent claude-code");
    expect(s.hooks.SessionEnd[0].hooks[0].timeout).toBe(30);
  });

  it("keeps the personal local file out of git status, so it never looks like project work", async () => {
    await installClaudeHooks(dir);
    expect(git(dir, "status", "--porcelain")).not.toContain(".claude");
  });

  it("is idempotent: a second run changes nothing", async () => {
    await installClaudeHooks(dir);
    const before = readFileSync(local(), "utf8");
    const r = await installClaudeHooks(dir);
    expect(r.added).toEqual([]);
    expect(r.unchanged).toHaveLength(3);
    expect(readFileSync(local(), "utf8")).toBe(before);
  });

  it("updates the command in place when the agent or executable changes", async () => {
    await installClaudeHooks(dir);
    const r = await installClaudeHooks(dir, { agent: "cursor-agent", command: 'node "D:/pcs/dist/cli.js"' });
    expect(r.updated).toHaveLength(3);
    const s = readJson(local());
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe('node "D:/pcs/dist/cli.js" hook session-start --agent cursor-agent');
  });

  it("keeps every other setting and hook", async () => {
    put(
      local(),
      JSON.stringify({
        permissions: { allow: ["Bash(git status)"] },
        hooks: {
          SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hello" }] }],
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] }],
        },
      }),
    );
    await installClaudeHooks(dir);
    const s = readJson(local());
    expect(s.permissions).toEqual({ allow: ["Bash(git status)"] });
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe("audit.sh");
    expect(s.hooks.SessionStart).toHaveLength(2);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe("echo hello");
  });

  it("refuses a settings file that is not valid JSON and leaves it untouched", async () => {
    put(local(), "{ not json");
    await expect(installClaudeHooks(dir)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(readFileSync(local(), "utf8")).toBe("{ not json");
  });

  it("refuses hooks it does not understand instead of rewriting them", async () => {
    const text = JSON.stringify({ hooks: { SessionStart: "oops" } });
    put(local(), text);
    await expect(installClaudeHooks(dir)).rejects.toBeInstanceOf(PcsError);
    expect(readFileSync(local(), "utf8")).toBe(text);
  });

  it.each(["has space", "a;b", "$(x)", "", "x".repeat(70)])("rejects the unsafe agent name %j (it goes into a shell command)", async (agent) => {
    await expect(installClaudeHooks(dir, { agent })).rejects.toBeInstanceOf(PcsError);
    expect(existsSync(local())).toBe(false);
  });

  it("rejects a multi-line command and an unknown scope", async () => {
    await expect(installClaudeHooks(dir, { command: "pcs\nrm -rf /" })).rejects.toBeInstanceOf(PcsError);
    await expect(installClaudeHooks(dir, { scope: "galaxy" as never })).rejects.toBeInstanceOf(PcsError);
  });

  it("supports project scope and user scope (CLAUDE_CONFIG_DIR)", async () => {
    await installClaudeHooks(dir, { scope: "project" });
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true);
    const r = await installClaudeHooks(dir, { scope: "user" });
    expect(r.file).toBe(join(claudeHome, "settings.json"));
    expect(readJson(r.file).hooks.SessionEnd).toBeDefined();
  });
});

describe("claude hooks: uninstall and status", () => {
  it("removes only PCS hooks and keeps the rest", async () => {
    put(local(), JSON.stringify({ permissions: { deny: ["x"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hello" }] }] } }));
    await installClaudeHooks(dir);
    const r = await uninstallClaudeHooks(dir);
    expect(r.removed).toEqual(["session-start", "pre-compact", "session-end"]);
    const s = readJson(local());
    expect(s.permissions).toEqual({ deny: ["x"] });
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe("echo hello");
    expect(s.hooks.PreCompact).toBeUndefined();
  });

  it("deletes a settings file that held nothing but the PCS hooks", async () => {
    await installClaudeHooks(dir);
    await uninstallClaudeHooks(dir);
    expect(existsSync(local())).toBe(false);
  });

  it("does not touch another tool's hook that merely looks similar", async () => {
    const other = { hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "other-tool hook session-end" }] }] } };
    put(local(), JSON.stringify(other));
    const r = await uninstallClaudeHooks(dir);
    expect(r.removed).toEqual([]);
    expect(readJson(local())).toEqual(other);
  });

  it("is a no-op when nothing is installed", async () => {
    expect((await uninstallClaudeHooks(dir)).removed).toEqual([]);
  });

  it("reports what is installed per scope", async () => {
    await installClaudeHooks(dir, { scope: "user" });
    const st = await claudeHooksStatus(dir);
    expect(st.find((s) => s.scope === "user")?.installed).toHaveLength(3);
    expect(st.find((s) => s.scope === "local")).toMatchObject({ exists: false, installed: [] });
  });
});

describe("agent instruction files", () => {
  const read = (name: string) => readFileSync(join(dir, name), "utf8");

  it("creates AGENTS.md when no instruction file exists", async () => {
    const r = await installAgentInstructions(dir);
    expect(r).toMatchObject([{ target: "agents", status: "created" }]);
    expect(read("AGENTS.md")).toContain("pcs_resume");
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  });

  it("is idempotent", async () => {
    await installAgentInstructions(dir);
    const before = read("AGENTS.md");
    expect((await installAgentInstructions(dir))[0]?.status).toBe("unchanged");
    expect(read("AGENTS.md")).toBe(before);
  });

  it("appends to existing files, keeps the owner's text, and uninstall restores it exactly", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "# Rules\n\nBe kind.\n");
    writeFileSync(join(dir, "AGENTS.md"), "# Agents\n");
    const r = await installAgentInstructions(dir);
    expect(r.map((x) => x.target).sort()).toEqual(["agents", "claude"]);
    expect(read("CLAUDE.md")).toContain("Be kind.");
    expect(read("CLAUDE.md")).toContain("<!-- pcs:begin -->");

    await uninstallAgentInstructions(dir);
    expect(read("CLAUDE.md")).toBe("# Rules\n\nBe kind.\n");
    expect(read("AGENTS.md")).toBe("# Agents\n");
  });

  it("refreshes only the marked block when its text changed", async () => {
    writeFileSync(join(dir, "AGENTS.md"), "top\n\n<!-- pcs:begin -->\nold text\n<!-- pcs:end -->\n\nbottom\n");
    const r = await installAgentInstructions(dir);
    expect(r[0]?.status).toBe("updated");
    const text = read("AGENTS.md");
    expect(text.startsWith("top\n")).toBe(true);
    expect(text).toContain("bottom");
    expect(text).not.toContain("old text");
  });

  it("deletes a file that held only the PCS block", async () => {
    await installAgentInstructions(dir);
    const r = await uninstallAgentInstructions(dir);
    expect(r[0]?.status).toBe("removed");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("writes a Cursor rule that is always applied", async () => {
    await installAgentInstructions(dir, { targets: ["cursor"] });
    const text = read(join(".cursor", "rules", "pcs.mdc"));
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain("alwaysApply: true");
    await uninstallAgentInstructions(dir);
    expect(existsSync(join(dir, ".cursor", "rules", "pcs.mdc"))).toBe(false);
  });

  it("keeps CRLF line endings in a CRLF file", async () => {
    writeFileSync(join(dir, "AGENTS.md"), "# Agents\r\n");
    await installAgentInstructions(dir);
    const text = read("AGENTS.md");
    expect(text).toContain("\r\n");
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("parses --target lists and rejects unknown names", () => {
    expect(parseTargets(undefined)).toBeUndefined();
    expect(parseTargets("all")).toEqual(["claude", "agents", "cursor"]);
    expect(parseTargets("claude, cursor")).toEqual(["claude", "cursor"]);
    expect(() => parseTargets("vim")).toThrow(PcsError);
  });

  it("needs an initialized project", async () => {
    const bare = mkdtempSync(join(tmpdir(), "pcs-bare-"));
    try {
      git(bare, "init", "-q");
      await expect(installAgentInstructions(bare)).rejects.toMatchObject({ code: "NOT_INITIALIZED" });
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
