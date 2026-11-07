import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPage, chromiumAvailable, runInChromium, servePage } from "./browser/harness";

const pkg = fileURLToPath(new URL("..", import.meta.url));

/** Every module reachable from `entry` inside this package, by relative import. */
function graph(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = readFileSync(entry, "utf8");
  for (const m of src.matchAll(/(?:import|export)[^"']*?from\s+["']([^"']+)["']/g)) {
    const spec = m[1];
    if (spec.startsWith(".")) {
      const p = resolve(dirname(entry), spec);
      if (!p.endsWith(".json")) graph(p.endsWith(".ts") ? p : p + ".ts", seen);
    }
  }
  return seen;
}

describe("the browser entry points", () => {
  it("import no Node built-ins and nothing that fetches setup data", () => {
    for (const entry of ["src/index.ts", "src/worker.ts"]) {
      const files = graph(join(pkg, entry));
      expect(files.size).toBeGreaterThan(3);
      for (const f of files) {
        const src = readFileSync(f, "utf8");
        expect(src, f).not.toMatch(/from\s+["']node:/);
        expect(src, f).not.toMatch(/from\s+["'](fs|path|os|child_process|crypto)["']/);
        expect(src, f).not.toMatch(/aztec-cdn|aztec-labs\.com|initSRSChonk/);
      }
      // bb.js is only ever started with its own CRS download switched off.
      const prove = readFileSync(join(pkg, "src/prove.ts"), "utf8");
      expect(prove).toMatch(/skipSrsInit: true/);
    }
  });
});

const run = chromiumAvailable() ? describe : describe.skip;

run("in Chromium", () => {
  let server: { url: string; close: () => Promise<void> };
  let out: Awaited<ReturnType<typeof runInChromium>>;

  beforeAll(async () => {
    server = await servePage(await buildPage());
    out = await runInChromium(server.url);
  }, 180_000);
  afterAll(async () => server?.close());

  it("proves in a Web Worker and verifies on the page", () => {
    expect(out.result.error).toBeUndefined();
    expect(out.result).toMatchObject({ ok: true, nullifierMatches: true, tamperedOk: false, crossOriginIsolated: true });
  });

  it("makes no request outside its own origin: no CRS download", () => {
    expect(out.blocked).toEqual([]);
    expect(out.requests.length).toBeGreaterThan(0);
    for (const u of out.requests) expect(u.startsWith(server.url) || u.startsWith("data:") || u.startsWith("blob:"), u).toBe(true);
    expect(out.requests.join(" ")).not.toMatch(/aztec|crs/i);
  });

  it("leaves no IndexedDB, localStorage or Cache Storage behind", () => {
    expect(out.result).toMatchObject({ indexedDb: [], localStorage: 0, caches: 0 });
  });
});
