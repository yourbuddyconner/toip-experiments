import { defineConfig } from "vitest/config";

// Workspace packages resolve to their TypeScript sources through the "@toip-tools/source" export
// condition, so tests need no build. The plugin adds it to every environment, keeping Vitest's defaults.
const source = { name: "toip-tools-source", configEnvironment: () => ({ resolve: { conditions: ["@toip-tools/source"] } }) };

export default defineConfig({
  plugins: [source],
  test: { testTimeout: 20000, hookTimeout: 20000 },
});
