import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      // Floors just under the current numbers (79.6 / 68.5 / 81.1 / 81.7): they stop silent erosion, not set a goal.
      thresholds: { statements: 78, branches: 66, functions: 79, lines: 80 },
    },
  },
});
