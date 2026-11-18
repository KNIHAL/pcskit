import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The real, long-form absolute path. On Windows the same folder can be spelled two ways
 * (`C:\Users\RUNNER~1\...` and `C:\Users\runneradmin\...`) and git reports the long one,
 * so paths must be canonicalized before they are compared. Falls back to `resolve` when
 * the path does not exist (yet).
 */
export function canonicalPath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}
