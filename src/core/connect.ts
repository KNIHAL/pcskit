import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { requireInitializedRoot } from "./context";
import { PcsError } from "./errors";

export const CONNECT_CLIENTS = ["claude-desktop", "cursor", "claude-code"] as const;
export type ConnectClient = (typeof CONNECT_CLIENTS)[number];

export interface McpServerEntry {
  command: string;
  args: string[];
}

export interface ConnectOptions {
  /** cursor only: write ~/.cursor/mcp.json instead of the project's .cursor/mcp.json */
  global?: boolean;
  /** Use plain `pcs` as the command (needs pcs on the PATH of the app) instead of absolute node + script paths. */
  portable?: boolean;
  allowTest?: boolean;
  readOnly?: boolean;
  /** Test hook: where the config files live. */
  home?: string;
  appData?: string;
  platform?: NodeJS.Platform;
  /** Test hook: the node binary and cli script to reference. */
  nodePath?: string;
  cliPath?: string;
}

export interface ConnectResult {
  client: ConnectClient;
  file: string;
  key: string;
  status: "added" | "updated" | "unchanged" | "removed" | "absent";
  entry: McpServerEntry;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/** Where an app keeps its MCP config. Claude Desktop is global; Cursor and Claude Code are per project by default. */
export function clientConfigPath(client: ConnectClient, root: string, opts: ConnectOptions = {}): string {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  if (client === "claude-code") return join(root, ".mcp.json");
  if (client === "cursor") return opts.global ? join(home, ".cursor", "mcp.json") : join(root, ".cursor", "mcp.json");
  if (platform === "win32") {
    const roaming = opts.appData ?? process.env.APPDATA ?? join(home, "AppData", "Roaming");
    // The Microsoft Store build keeps its config in a package folder instead.
    const local = join(opts.appData ? join(dirname(opts.appData), "Local") : (process.env.LOCALAPPDATA ?? join(home, "AppData", "Local")), "Packages");
    try {
      for (const d of readdirSync(local)) {
        if (!d.startsWith("Claude_")) continue;
        const dir = join(local, d, "LocalCache", "Roaming", "Claude");
        if (existsSync(dir)) return join(dir, "claude_desktop_config.json");
      }
    } catch {
      /* no Store build */
    }
    return join(roaming, "Claude", "claude_desktop_config.json");
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

/** The key under mcpServers. Project-level files are already per project; global ones need the project name. */
export function serverKey(client: ConnectClient, root: string, opts: ConnectOptions = {}): string {
  const perProject = client === "claude-code" || (client === "cursor" && !opts.global);
  if (perProject) return "pcs";
  const name = basename(root).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  return `pcs-${name}`.slice(0, 64);
}

export function serverEntry(root: string, opts: ConnectOptions = {}): McpServerEntry {
  const flags = ["mcp", "--project", root];
  if (opts.readOnly) flags.push("--read-only");
  else if (opts.allowTest) flags.push("--allow-test");
  if (opts.portable) return { command: "pcs", args: flags };
  const cli = opts.cliPath ?? process.argv[1];
  if (!cli) throw new PcsError("INVALID_INPUT", "Cannot find the pcs script path. Use --portable.");
  return { command: opts.nodePath ?? process.execPath, args: [resolve(cli), ...flags] };
}

function readConfig(file: string): Json {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8").replace(/^﻿/, "");
  if (raw.trim() === "") return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // Never overwrite a file we cannot parse: it may hold the person's other servers.
    throw new PcsError("INVALID_INPUT", `${file} is not valid JSON. Fix or remove it, then run this again. Nothing was changed.`);
  }
  if (!isObject(data)) throw new PcsError("INVALID_INPUT", `${file} does not hold a JSON object. Nothing was changed.`);
  return data;
}

function writeConfig(file: string, data: Json): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.pcs-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, file); // atomic: a crash never leaves a half-written config
}

const same = (a: unknown, b: McpServerEntry): boolean => JSON.stringify(a) === JSON.stringify(b);

export async function connectClient(client: ConnectClient, cwd: string, opts: ConnectOptions = {}): Promise<ConnectResult> {
  const root = await requireInitializedRoot(cwd);
  const file = clientConfigPath(client, root, opts);
  const key = serverKey(client, root, opts);
  const entry = serverEntry(root, opts);
  const data = readConfig(file);
  const servers = isObject(data.mcpServers) ? { ...data.mcpServers } : {};
  const had = key in servers;
  const current = servers[key];
  const status: ConnectResult["status"] = !had ? "added" : same(current, entry) ? "unchanged" : "updated";
  if (status !== "unchanged") {
    servers[key] = entry;
    writeConfig(file, { ...data, mcpServers: servers });
  }
  return { client, file, key, status, entry };
}

export async function disconnectClient(client: ConnectClient, cwd: string, opts: ConnectOptions = {}): Promise<ConnectResult> {
  const root = await requireInitializedRoot(cwd);
  const file = clientConfigPath(client, root, opts);
  const key = serverKey(client, root, opts);
  const entry = serverEntry(root, opts);
  if (!existsSync(file)) return { client, file, key, status: "absent", entry };
  const data = readConfig(file);
  if (!isObject(data.mcpServers) || !(key in data.mcpServers)) return { client, file, key, status: "absent", entry };
  const servers = { ...data.mcpServers };
  delete servers[key];
  const rest = { ...data };
  if (Object.keys(servers).length > 0) rest.mcpServers = servers;
  else delete rest.mcpServers;
  if (Object.keys(rest).length === 0) rmSync(file, { force: true });
  else writeConfig(file, rest);
  return { client, file, key, status: "removed", entry };
}
