import { defaultClientConditions, defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Workspace packages resolve to their TypeScript sources, so nothing needs building first.
const source = "@toip-tools/source";

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: [source, ...defaultClientConditions] },
  server: { port: 5181 },
});
