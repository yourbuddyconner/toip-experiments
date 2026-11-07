import { defaultClientConditions, defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Workspace packages resolve to their TypeScript sources, so nothing needs building first.
const source = "@toip-tools/source";

// Served by the Capture world (src/world/world.ts), which also answers /api and /witness.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: { conditions: [source, ...defaultClientConditions] },
  optimizeDeps: { exclude: ["@contentauth/c2pa-web"] },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 4000 },
  worker: { format: "es" },
});
