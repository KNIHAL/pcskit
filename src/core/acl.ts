import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Owner-only access to `.pcs`. POSIX uses modes (0700 / 0600). Windows ignores modes, so the folder's ACL is set
 * instead: inheritance is removed and only the current user, SYSTEM and Administrators are granted access
 * (well-known SIDs, so this works on any display language). Best effort: a failure never blocks the command.
 */

const SYSTEM_SID = "*S-1-5-18";
const ADMINS_SID = "*S-1-5-32-544";

function icacls(args: string[]): string {
  return execFileSync("icacls", args, { encoding: "utf8", windowsHide: true, timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] });
}

function currentUserSid(): string | null {
  try {
    const out = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    const m = /"(S-1-[0-9-]+)"\s*$/m.exec(out.trim());
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** True when an `icacls` listing still contains inherited entries, i.e. the folder takes access from its parent. */
export function hasInheritedAces(icaclsOutput: string): boolean {
  return icaclsOutput.split(/\r?\n/).some((l) => /\(I\)/.test(l));
}

function walk(dir: string, fn: (p: string, isDir: boolean) => void): void {
  fn(dir, true);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, n);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(p, fn);
    else fn(p, false);
  }
}

/** Make `dir` (and what is already inside it) readable by the current user only. Returns false if it could not. */
export function secureDir(dir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!existsSync(dir)) return false;
  if (platform !== "win32") {
    try {
      walk(dir, (p, isDir) => chmodSync(p, isDir ? 0o700 : 0o600));
      return true;
    } catch {
      return false;
    }
  }
  const sid = currentUserSid();
  if (!sid) return false;
  try {
    // 1. The folder itself: no inheritance, only the three grants, passed on to anything created later.
    icacls([dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, `${SYSTEM_SID}:(OI)(CI)F`, `${ADMINS_SID}:(OI)(CI)F`, "/Q"]);
    // 2. What is already inside: reset to inherit from the folder. (Applying the grants with /T instead would leave
    //    existing FILES with an empty ACL, which locks even the owner out.)
    if (readdirSync(dir).length > 0) icacls([join(dir, "*"), "/reset", "/T", "/C", "/Q"]);
    return true;
  } catch {
    return false;
  }
}

/** True when nobody but the owner (and, on Windows, SYSTEM/Administrators) can reach `dir`. */
export function isOwnerOnly(dir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!existsSync(dir)) return true;
  if (platform !== "win32") {
    let ok = true;
    walk(dir, (p) => {
      if ((statSync(p).mode & 0o077) !== 0) ok = false;
    });
    return ok;
  }
  try {
    return !hasInheritedAces(icacls([dir]));
  } catch {
    return true; // cannot tell: do not raise a false alarm
  }
}
