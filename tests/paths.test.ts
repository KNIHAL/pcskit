import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalPath } from "../src/core/paths";

describe("canonicalPath", () => {
  it("returns the real path of an existing folder, however it is spelled", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcs-paths-"));
    try {
      mkdirSync(join(dir, "a"));
      expect(canonicalPath(join(dir, "a"))).toBe(realpathSync.native(join(dir, "a")));
      expect(canonicalPath(join(dir, "a", "..", "a"))).toBe(realpathSync.native(join(dir, "a")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the resolved path when the path does not exist", () => {
    const missing = join(tmpdir(), "pcs-paths-does-not-exist", "x");
    expect(canonicalPath(missing)).toBe(resolve(missing));
  });
});
