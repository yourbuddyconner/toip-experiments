import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served by the Capture world (src/world/world.ts), which also answers /api and /witness.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  optimizeDeps: { exclude: ["@contentauth/c2pa-web"] },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 4000 },
  worker: { format: "es" },
});
