import { defineConfig } from "vitest/config";

// Workspace packages resolve to their TypeScript sources through the "@toip-tools/source" export
// condition, so tests need no build. The plugin adds it to every environment, keeping Vitest's defaults.
const source = { name: "toip-tools-source", configEnvironment: () => ({ resolve: { conditions: ["@toip-tools/source"] } }) };

export default defineConfig({
  plugins: [source],
  // The gateway tests run a real relay; the default 5 s is too tight when the whole repository is tested at once.
  test: { testTimeout: 20000 },
});
