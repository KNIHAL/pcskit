import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { requireInitializedRoot } from "./context";
import { PcsError } from "./errors";
import { canonicalPath } from "./paths";
import { requestStop } from "./watcher";

/**
 * Start the project watcher at login, using the OS's own per-user mechanism (no admin rights, nothing global):
 * the current user's Run registry key (Windows; Task Scheduler's logon trigger needs admin), a systemd user unit
 * (Linux) or a launchd agent (macOS). One entry per project.
 */
export type AutostartPlatform = "win32" | "linux" | "darwin";

export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 30_000, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? (err ? err.message : "")) });
    });
  });

export interface AutostartTarget {
  root: string;
  /** The node executable and the pcs entry script that will be run at login. */
  node: string;
  cli: string;
}

export interface AutostartEnv {
  platform?: AutostartPlatform;
  exec?: Exec;
  /** Start a command now, detached and without waiting (Windows only; tests replace it). */
  start?: (cmd: string, args: string[]) => void;
  home?: string;
  uid?: number;
}

export interface AutostartResult {
  platform: AutostartPlatform;
  name: string;
  /** The unit/plist written, when there is one (Windows keeps the task inside Task Scheduler). */
  file?: string;
  note?: string;
}

export function serviceId(root: string): string {
  return createHash("sha256").update(canonicalPath(root)).digest("hex").slice(0, 10);
}

export function serviceName(root: string): string {
  const base = basename(canonicalPath(root)).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "project";
  return `pcskit-watch-${base}-${serviceId(root)}`;
}

function assertSafe(label: string, v: string): void {
  if (/["\r\n\0]/.test(v)) throw new PcsError("INVALID_INPUT", `${label} contains a character that cannot be used in a startup entry.`);
}

function check(t: AutostartTarget): void {
  assertSafe("Project path", t.root);
  assertSafe("Node path", t.node);
  assertSafe("PCS path", t.cli);
}

export const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/** conhost --headless runs a console program with no window (Windows 10 1809+). */
export function windowsRunArgs(t: AutostartTarget): string[] {
  check(t);
  return ["--headless", t.node, t.cli, "watch", "--project", t.root];
}

export function windowsRunValue(t: AutostartTarget): string {
  return `conhost.exe ${windowsRunArgs(t).map((a) => `"${a}"`).join(" ")}`;
}

function defaultStart(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => undefined);
  child.unref();
}

function systemdQuote(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

export function systemdUnit(t: AutostartTarget): string {
  check(t);
  return [
    "[Unit]",
    `Description=pcskit watcher for ${t.root.replace(/[\r\n%]/g, "")}`,
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${systemdQuote(t.node)} ${systemdQuote(t.cli)} watch --project ${systemdQuote(t.root)}`,
    "Restart=on-failure",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function xml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function launchdPlist(t: AutostartTarget, label: string): string {
  check(t);
  const args = [t.node, t.cli, "watch", "--project", t.root].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
</dict>
</plist>
`;
}

function paths(name: string, env: AutostartEnv) {
  const home = env.home ?? homedir();
  const base = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim() !== "" ? process.env.XDG_CONFIG_HOME : join(home, ".config");
  return {
    unit: join(env.home ? join(home, ".config") : base, "systemd", "user", `${name}.service`),
    plist: join(home, "Library", "LaunchAgents", `dev.${name}.plist`),
  };
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function platformOf(env: AutostartEnv): AutostartPlatform {
  const p = env.platform ?? process.platform;
  if (p !== "win32" && p !== "linux" && p !== "darwin") throw new PcsError("INVALID_INPUT", `Autostart is not supported on ${p}.`);
  return p;
}

async function must(exec: Exec, cmd: string, args: string[], what: string): Promise<void> {
  const r = await exec(cmd, args);
  if (r.code !== 0) throw new PcsError("INVALID_INPUT", `${what} failed: ${(r.stderr || r.stdout).trim().split("\n")[0] ?? `exit ${r.code}`}`);
}

export function currentTarget(root: string): AutostartTarget {
  const cli = process.argv[1];
  if (!cli) throw new PcsError("INVALID_INPUT", "Cannot tell where pcs is installed.");
  return { root: canonicalPath(root), node: process.execPath, cli: canonicalPath(cli) };
}

export async function installAutostart(cwd: string, env: AutostartEnv = {}, target?: Partial<AutostartTarget>): Promise<AutostartResult> {
  const root = await requireInitializedRoot(cwd);
  const t: AutostartTarget = { ...currentTarget(root), ...target };
  const platform = platformOf(env);
  const exec = env.exec ?? defaultExec;
  const name = serviceName(t.root);
  const p = paths(name, env);

  if (platform === "win32") {
    await must(exec, "reg", ["add", WINDOWS_RUN_KEY, "/v", name, "/t", "REG_SZ", "/d", windowsRunValue(t), "/f"], "Adding the Run entry");
    // Start now with a hidden console of its own (conhost --headless exits at once without inherited handles).
    (env.start ?? defaultStart)(t.node, [t.cli, "watch", "--project", t.root]);
    return { platform, name, note: "Runs at every logon (current user); started now." };
  }
  if (platform === "linux") {
    writeAtomic(p.unit, systemdUnit(t));
    await must(exec, "systemctl", ["--user", "daemon-reload"], "systemctl daemon-reload");
    await must(exec, "systemctl", ["--user", "enable", "--now", `${name}.service`], "Enabling the systemd user service");
    return { platform, name, file: p.unit, note: "To keep it running when you are logged out: loginctl enable-linger $USER" };
  }
  const label = `dev.${name}`;
  const uid = env.uid ?? (typeof process.getuid === "function" ? process.getuid() : 501);
  writeAtomic(p.plist, launchdPlist(t, label));
  await exec("launchctl", ["bootout", `gui/${uid}/${label}`]); // ignore "not loaded"
  await must(exec, "launchctl", ["bootstrap", `gui/${uid}`, p.plist], "Loading the launchd agent");
  return { platform, name, file: p.plist, note: "Runs at every login; started now." };
}

export async function uninstallAutostart(cwd: string, env: AutostartEnv = {}, rootOverride?: string): Promise<AutostartResult & { removed: boolean }> {
  const root = rootOverride ?? (await requireInitializedRoot(cwd));
  const platform = platformOf(env);
  const exec = env.exec ?? defaultExec;
  const name = serviceName(root);
  const p = paths(name, env);
  let removed = false;

  if (platform === "win32") {
    const r = await exec("reg", ["delete", WINDOWS_RUN_KEY, "/v", name, "/f"]);
    removed = r.code === 0;
  } else if (platform === "linux") {
    await exec("systemctl", ["--user", "disable", "--now", `${name}.service`]);
    if (existsSync(p.unit)) {
      rmSync(p.unit);
      removed = true;
      await exec("systemctl", ["--user", "daemon-reload"]);
    }
  } else {
    const uid = env.uid ?? (typeof process.getuid === "function" ? process.getuid() : 501);
    await exec("launchctl", ["bootout", `gui/${uid}/dev.${name}`]);
    if (existsSync(p.plist)) {
      rmSync(p.plist);
      removed = true;
    }
  }
  try {
    await requestStop(root);
  } catch {
    /* no watcher running */
  }
  return { platform, name, removed, ...(platform === "linux" ? { file: p.unit } : platform === "darwin" ? { file: p.plist } : {}) };
}

export async function autostartStatus(cwd: string, env: AutostartEnv = {}): Promise<AutostartResult & { installed: boolean }> {
  const root = await requireInitializedRoot(cwd);
  const platform = platformOf(env);
  const exec = env.exec ?? defaultExec;
  const name = serviceName(root);
  const p = paths(name, env);
  if (platform === "win32") {
    const r = await exec("reg", ["query", WINDOWS_RUN_KEY, "/v", name]);
    return { platform, name, installed: r.code === 0 };
  }
  if (platform === "linux") {
    const installed = existsSync(p.unit) && readFileSync(p.unit, "utf8").includes(canonicalPath(root).replace(/\\/g, "\\\\").replace(/%/g, "%%").replace(/\$/g, "$$$$"));
    return { platform, name, installed, file: p.unit };
  }
  return { platform, name, installed: existsSync(p.plist), file: p.plist };
}
