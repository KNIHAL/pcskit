import { describe, expect, it } from "vitest";
import { formatArgv } from "../src/core";

describe("formatArgv", () => {
  it("leaves plain arguments alone and quotes anything a shell would split or interpret", () => {
    expect(formatArgv(["npm", "run", "test:unit", "--", "src/a.ts"])).toBe("npm run test:unit -- src/a.ts");
    expect(formatArgv(["node", "-e", "console.error('boom');process.exit(3)"])).toBe(
      'node -e "console.error(\'boom\');process.exit(3)"',
    );
    expect(formatArgv(["echo", "", "a b", 'say "hi"'])).toBe('echo "" "a b" "say \\"hi\\""');
  });
});
