import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served by the Trail service (src/service.ts), which also answers /api and /w/<n>.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 900 },
});
