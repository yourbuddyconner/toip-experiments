import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served by the mesh app server (src/server.ts), which also answers /api.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
