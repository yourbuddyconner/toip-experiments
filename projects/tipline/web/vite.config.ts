import { defaultClientConditions, defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { join } from "node:path";

// Workspace packages resolve to their TypeScript sources, so nothing needs building first.
const source = "@toip-tools/source";

// Four apps, one build. The platform (src/platform/platform.ts) serves each from its own origin.
const page = (name: string) => join(import.meta.dirname, `${name}.html`);

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: { conditions: [source, ...defaultClientConditions] },
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "esnext",
    chunkSizeWarningLimit: 100_000,
    rollupOptions: { input: { source: page("source"), inbox: page("inbox"), acme: page("acme"), wallet: page("wallet") } },
  },
});
