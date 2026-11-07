import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultClientConditions, defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Workspace packages resolve to their TypeScript sources, so nothing needs building first.
const source = "@toip-tools/source";

/** SHA-256 over the client's sources, shown on the About page so people can compare builds. */
function sourceHash(): string {
  const h = createHash("sha256");
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(name).update(readFileSync(p));
    }
  };
  for (const d of [join(import.meta.dirname, "src"), join(import.meta.dirname, "..", "src", "client"), join(import.meta.dirname, "..", "src", "protocol")]) walk(d);
  return h.digest("hex");
}

// Served by the Agora platform (src/platform/platform.ts) on its own origin, with COOP and COEP.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  resolve: { conditions: [source, ...defaultClientConditions] },
  define: { __BUILD_ID__: JSON.stringify(sourceHash()) },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@aztec/bb.js", "@noir-lang/noir_js", "@noir-lang/acvm_js", "@noir-lang/noirc_abi"] },
  build: { outDir: "dist", emptyOutDir: true, target: "esnext", chunkSizeWarningLimit: 100_000 },
});
