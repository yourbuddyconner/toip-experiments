import { defineConfig } from "vitest/config";

// Workspace packages resolve to their TypeScript sources through the "@toip-tools/source" export
// condition, so tests need no build. The plugin adds it to every environment, keeping Vitest's defaults.
const source = { name: "toip-tools-source", configEnvironment: () => ({ resolve: { conditions: ["@toip-tools/source"] } }) };

// Only our tests: sandbox/demo-repo has node:test files of its own, for the CI attester to run.
export default defineConfig({
  plugins: [source],
  test: { include: ["tests/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 60_000, fileParallelism: false },
});
