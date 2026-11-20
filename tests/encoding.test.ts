import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|json|md)$/.test(name)) out.push(p);
  }
  return out;
}

describe("repository text files", () => {
  it("are valid UTF-8 (a stray Latin-1 byte once broke the dashboard's separators)", () => {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const bad: string[] = [];
    for (const root of ["src", "tests", "docs"]) {
      for (const f of files(root)) {
        try {
          decoder.decode(readFileSync(f));
        } catch {
          bad.push(f);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("contain no U+FFFD replacement characters", () => {
    const bad: string[] = [];
    for (const root of ["src", "tests", "docs"]) {
      for (const f of files(root)) if (readFileSync(f, "utf8").includes(String.fromCharCode(0xfffd))) bad.push(f);
    }
    expect(bad).toEqual([]);
  });
});
