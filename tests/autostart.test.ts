import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  autostartStatus,
  initProject,
  installAutostart,
  launchdPlist,
  serviceName,
  systemdUnit,
  uninstallAutostart,
  windowsRunArgs,
  windowsRunValue,
  type AutostartTarget,
  type Exec,
} from "../src/core";

let dir: string;
let home: string;
const extra: string[] = [];

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function fakeExec(codes: Record<string, number> = {}) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    const hit = Object.keys(codes).find((k) => line.startsWith(k));
    return { code: hit ? (codes[hit] as number) : 0, stdout: "", stderr: hit ? "boom" : "" };
  };
  return { exec, calls };
}

const T: AutostartTarget = { root: "/work/my app", node: "/usr/bin/node", cli: "/opt/pcs/dist/cli.js" };

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "pcs-ashome-"));
  dir = mkdtempSync(join(tmpdir(), "pcs-as-"));
  extra.push(home, dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.dev");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "x\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  await initProject(dir);
});

afterEach(() => {
  for (const d of extra.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("autostart: generated entries", () => {
  it("names are stable, safe and unique per project", () => {
    expect(serviceName(dir)).toBe(serviceName(dir));
    expect(serviceName(dir)).toMatch(/^pcskit-watch-[A-Za-z0-9_-]+-[0-9a-f]{10}$/);
    expect(serviceName(dir)).not.toBe(serviceName(home));
  });

  it("builds the Windows Run entry (headless, no admin)", () => {
    const t = { root: "C:\\work\\app", node: "C:\\node\\node.exe", cli: "C:\\pcs\\cli.js" };
    expect(windowsRunArgs(t)).toEqual(["--headless", "C:\\node\\node.exe", "C:\\pcs\\cli.js", "watch", "--project", "C:\\work\\app"]);
    expect(windowsRunValue(t)).toBe('conhost.exe "--headless" "C:\\node\\node.exe" "C:\\pcs\\cli.js" "watch" "--project" "C:\\work\\app"');
  });

  it("rejects quotes and newlines in paths", () => {
    expect(() => windowsRunArgs({ ...T, root: 'a"b' })).toThrow(/cannot be used/);
    expect(() => windowsRunArgs({ ...T, cli: "a\nb" })).toThrow(/cannot be used/);
  });

  it("escapes systemd specials", () => {
    const u = systemdUnit({ ...T, root: "/work/50%/$HOME/a\\b" });
    expect(u).toContain('ExecStart="/usr/bin/node" "/opt/pcs/dist/cli.js" watch --project "/work/50%%/$$HOME/a\\\\b"');
    expect(u).toContain("WantedBy=default.target");
    expect(() => systemdUnit({ ...T, root: "a\nExecStart=evil" })).toThrow();
  });

  it("escapes XML in the launchd plist", () => {
    const p = launchdPlist({ ...T, root: "/work/a&b<c>" }, "dev.x");
    expect(p).toContain("<string>/work/a&amp;b&lt;c&gt;</string>");
    expect(p).toContain("<key>RunAtLoad</key>");
    expect(p).toContain("<string>dev.x</string>");
  });
});

describe("autostart: install, status, uninstall", () => {
  it("linux: writes the unit and enables it, then removes it", async () => {
    const { exec, calls } = fakeExec();
    const r = await installAutostart(dir, { platform: "linux", exec, home }, { node: "/usr/bin/node", cli: "/opt/pcs/cli.js" });
    expect(r.file).toBeDefined();
    expect(readFileSync(r.file as string, "utf8")).toContain("watch --project");
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${r.name}.service`,
    ]);
    expect((await autostartStatus(dir, { platform: "linux", exec, home })).installed).toBe(true);

    const u = await uninstallAutostart(dir, { platform: "linux", exec, home });
    expect(u.removed).toBe(true);
    expect(existsSync(r.file as string)).toBe(false);
    expect((await autostartStatus(dir, { platform: "linux", exec, home })).installed).toBe(false);
  });

  it("darwin: writes the plist and bootstraps it", async () => {
    const { exec, calls } = fakeExec();
    const r = await installAutostart(dir, { platform: "darwin", exec, home, uid: 501 }, { node: "/usr/bin/node", cli: "/opt/pcs/cli.js" });
    expect(readFileSync(r.file as string, "utf8")).toContain("<key>ProgramArguments</key>");
    expect(calls[0]).toMatch(/^launchctl bootout gui\/501\/dev\.pcskit-watch-/);
    expect(calls[1]).toMatch(/^launchctl bootstrap gui\/501 .*\.plist$/);
    const u = await uninstallAutostart(dir, { platform: "darwin", exec, home, uid: 501 });
    expect(u.removed).toBe(true);
    expect(existsSync(r.file as string)).toBe(false);
  });

  it("win32: adds the Run entry, starts it now, queries and removes it", async () => {
    const { exec, calls } = fakeExec();
    const started: string[] = [];
    const target = { node: "C:\\node\\node.exe", cli: "C:\\pcs\\cli.js" };
    const r = await installAutostart(dir, { platform: "win32", exec, start: (c, a) => started.push(`${c} ${a.join(" ")}`) }, target);
    expect(calls[0]).toMatch(/^reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run \/v pcskit-watch-.* \/t REG_SZ \/d conhost\.exe /);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatch(/^C:\\node\\node\.exe C:\\pcs\\cli\.js watch --project /);
    expect((await autostartStatus(dir, { platform: "win32", exec })).installed).toBe(true);
    const gone = fakeExec({ "reg query": 1 });
    expect((await autostartStatus(dir, { platform: "win32", exec: gone.exec })).installed).toBe(false);
    const u = await uninstallAutostart(dir, { platform: "win32", exec });
    expect(u.removed).toBe(true);
    expect(calls.some((c) => c.startsWith("reg ") && c.includes(" HKCU") && c.includes(r.name) && c.endsWith("/f") && !c.includes(" add "))).toBe(true);
  });

  it("surfaces a failing OS command", async () => {
    const { exec } = fakeExec({ "systemctl --user enable": 1 });
    await expect(installAutostart(dir, { platform: "linux", exec, home }, { node: "/n", cli: "/c" })).rejects.toThrow(/Enabling the systemd user service failed: boom/);
  });

  it("uninstall is safe when nothing is installed", async () => {
    const { exec } = fakeExec({ "systemctl": 1 });
    const u = await uninstallAutostart(dir, { platform: "linux", exec, home });
    expect(u.removed).toBe(false);
  });

  it("needs an initialized project and a supported platform", async () => {
    const bare = mkdtempSync(join(tmpdir(), "pcs-asbare-"));
    extra.push(bare);
    git(bare, "init", "-q");
    await expect(installAutostart(bare, { platform: "linux", exec: fakeExec().exec, home })).rejects.toMatchObject({ code: "NOT_INITIALIZED" });
    await expect(installAutostart(dir, { platform: "freebsd" as never, exec: fakeExec().exec })).rejects.toThrow(/not supported/);
  });
});
