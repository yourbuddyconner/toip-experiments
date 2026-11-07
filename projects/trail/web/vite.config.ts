import { defaultClientConditions, defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Workspace packages resolve to their TypeScript sources, so nothing needs building first.
const source = "@toip-tools/source";

// Served by the Trail service (src/service.ts), which also answers /api and /w/<n>.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: { conditions: [source, ...defaultClientConditions] },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 900 },
});
