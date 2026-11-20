import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientConfigPath, connectClient, disconnectClient, initProject, requireInitializedRoot, serverKey } from "../src/core";

const CLI = join(process.cwd(), "dist", "cli.js");
let base: string;
let repo: string;
let home: string;
let root: string; // as git reports it (forward slashes on Windows)

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

const opts = () => ({ home, appData: join(home, "AppData", "Roaming"), platform: "win32" as const, nodePath: "node", cliPath: CLI });
const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "pcs-connect-"));
  home = join(base, "home");
  repo = join(base, "my repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t.dev");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "a.txt"), "x\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "init");
  await initProject(repo);
  root = await requireInitializedRoot(repo);
}, 60_000);

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("pcs connect: config files", () => {
  it("knows where each app keeps its config", () => {
    expect(clientConfigPath("claude-code", repo, opts())).toBe(join(repo, ".mcp.json"));
    expect(clientConfigPath("cursor", repo, opts())).toBe(join(repo, ".cursor", "mcp.json"));
    expect(clientConfigPath("cursor", repo, { ...opts(), global: true })).toBe(join(home, ".cursor", "mcp.json"));
    expect(clientConfigPath("claude-desktop", repo, opts())).toBe(join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"));
    expect(clientConfigPath("claude-desktop", repo, { ...opts(), platform: "darwin" })).toBe(
      join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    );
    expect(clientConfigPath("claude-desktop", repo, { ...opts(), platform: "linux" })).toBe(join(home, ".config", "Claude", "claude_desktop_config.json"));
  });

  it("uses the Store package folder on Windows when it exists", () => {
    const dir = join(home, "AppData", "Local", "Packages", "Claude_abc123", "LocalCache", "Roaming", "Claude");
    mkdirSync(dir, { recursive: true });
    expect(clientConfigPath("claude-desktop", repo, opts())).toBe(join(dir, "claude_desktop_config.json"));
    rmSync(join(home, "AppData", "Local"), { recursive: true, force: true });
  });

  it("global keys carry the project name; project files use plain pcs", () => {
    expect(serverKey("claude-desktop", repo)).toBe("pcs-my-repo");
    expect(serverKey("cursor", repo, { global: true })).toBe("pcs-my-repo");
    expect(serverKey("cursor", repo)).toBe("pcs");
    expect(serverKey("claude-code", repo)).toBe("pcs");
  });

  it("adds, keeps other servers, is idempotent, updates and removes", async () => {
    const file = clientConfigPath("claude-desktop", repo, opts());
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x", args: [] } } }));

    expect((await connectClient("claude-desktop", repo, opts())).status).toBe("added");
    let cfg = readJson(file);
    expect(cfg.theme).toBe("dark");
    expect(cfg.mcpServers.other).toEqual({ command: "x", args: [] });
    expect(cfg.mcpServers["pcs-my-repo"].args.slice(1)).toEqual(["mcp", "--project", root]);

    expect((await connectClient("claude-desktop", repo, opts())).status).toBe("unchanged");
    expect((await connectClient("claude-desktop", repo, { ...opts(), readOnly: true })).status).toBe("updated");
    cfg = readJson(file);
    expect(cfg.mcpServers["pcs-my-repo"].args).toContain("--read-only");

    expect((await disconnectClient("claude-desktop", repo, opts())).status).toBe("removed");
    cfg = readJson(file);
    expect(cfg.mcpServers).toEqual({ other: { command: "x", args: [] } });
    expect((await disconnectClient("claude-desktop", repo, opts())).status).toBe("absent");
  });

  it("deletes a config file that held only our entry", async () => {
    const file = clientConfigPath("claude-code", repo, opts());
    await connectClient("claude-code", repo, opts());
    expect(existsSync(file)).toBe(true);
    await disconnectClient("claude-code", repo, opts());
    expect(existsSync(file)).toBe(false);
  });

  it("refuses to overwrite a config it cannot parse", async () => {
    const file = clientConfigPath("cursor", repo, opts());
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{ not json");
    await expect(connectClient("cursor", repo, opts())).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
    rmSync(file);
  });

  it("accepts a config with a UTF-8 BOM", async () => {
    const file = clientConfigPath("cursor", repo, opts());
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `﻿${JSON.stringify({ mcpServers: {} })}`);
    expect((await connectClient("cursor", repo, opts())).status).toBe("added");
    await disconnectClient("cursor", repo, opts());
  });

  it("portable mode writes plain pcs", async () => {
    const r = await connectClient("cursor", repo, { ...opts(), portable: true });
    expect(r.entry).toEqual({ command: "pcs", args: ["mcp", "--project", root] });
    await disconnectClient("cursor", repo, { ...opts(), portable: true });
  });

  it("needs an initialized project", async () => {
    const empty = mkdtempSync(join(base, "empty-"));
    git(empty, "init", "-q");
    await expect(connectClient("cursor", empty, opts())).rejects.toThrow();
  });
});

describe("pcs connect: a real MCP client over stdio", () => {
  it("runs the exact command a client would launch and completes a handoff", async () => {
    expect(existsSync(CLI), "run `npm run build` first").toBe(true);
    // Real CLI, real config file, then launch whatever the file says (as Cursor or Claude Desktop would).
    execFileSync(process.execPath, [CLI, "connect", "claude-code"], { cwd: repo, stdio: "ignore" });
    const entry = readJson(join(repo, ".mcp.json")).mcpServers.pcs as { command: string; args: string[] };
    expect(entry.command).toBe(process.execPath);

    const transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args,
      cwd: tmpdir(), // GUI apps do not start servers in the project folder; --project must be enough
      stderr: "ignore",
    });
    const client = new Client({ name: "real-agent-sim", version: "1" });
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["pcs_status", "pcs_resume", "pcs_note_add", "pcs_session_end", "pcs_handoff"]));
      expect(names).not.toContain("pcs_test"); // off unless asked for

      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
        return { isError: r.isError === true, text: r.content.map((c) => c.text).join("\n") };
      };
      const resume = await call("pcs_resume", { agent: "cursor" });
      expect(resume.isError).toBe(false);
      await call("pcs_note_add", { kind: "task", text: "Ship the exporter" });
      await call("pcs_note_add", { kind: "next", text: "Wire the --json flag" });
      expect((await call("pcs_session_end", { reason: "limit" })).isError).toBe(false);
      const handoff = await call("pcs_handoff");
      expect(handoff.isError).toBe(false);
      expect(handoff.text).toContain("Wire the --json flag");
    } finally {
      await client.close();
    }
  }, 60_000);
});
