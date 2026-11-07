import { defineConfig } from "vitest/config";

// Only our tests: sandbox/demo-repo has node:test files of its own, for the CI attester to run.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 60_000, fileParallelism: false },
});
