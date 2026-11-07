// Checks every link in dist/: internal pages, assets and #anchors must resolve; links to files in this
// repository on GitHub must name files that exist here. External links are listed, and fetched with --external.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BASE, ORIGIN, OUT_DIR, REPO, REPO_DIR } from "./config";

function htmlFiles(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) htmlFiles(p, out);
    else if (n.endsWith(".html")) out.push(p);
  }
  return out;
}

const idsCache = new Map<string, Set<string>>();
function idsOf(file: string): Set<string> {
  let s = idsCache.get(file);
  if (!s) {
    s = new Set([...readFileSync(file, "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    idsCache.set(file, s);
  }
  return s;
}

function targetFile(pathname: string): string | undefined {
  if (!pathname.startsWith(BASE)) return undefined;
  const rel = decodeURIComponent(pathname.slice(BASE.length));
  const p = join(OUT_DIR, rel);
  if (existsSync(p) && statSync(p).isFile()) return p;
  if (existsSync(join(p, "index.html"))) return join(p, "index.html");
  return undefined;
}

const problems: string[] = [];
const external = new Map<string, Set<string>>();
let internal = 0;
let repoFiles = 0;

for (const file of htmlFiles(OUT_DIR)) {
  const page = "/" + relative(OUT_DIR, file);
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const raw = m[1].replace(/&amp;/g, "&");
    if (raw.startsWith("mailto:")) continue;
    if (raw.startsWith("#")) {
      internal++;
      if (!idsOf(file).has(decodeURIComponent(raw.slice(1)))) problems.push(`${page}: no #${raw.slice(1)} on this page`);
      continue;
    }
    if (raw.startsWith(ORIGIN + BASE)) continue; // canonical URLs
    if (/^https?:\/\//.test(raw)) {
      if (raw.startsWith(`${REPO}/blob/main/`) || raw.startsWith(`${REPO}/tree/main/`)) {
        repoFiles++;
        const path = raw.replace(/^.*?\/(?:blob|tree)\/main\//, "").replace(/#.*$/, "");
        if (!existsSync(join(REPO_DIR, decodeURIComponent(path)))) problems.push(`${page}: ${raw} names a file not in the repository`);
        continue;
      }
      if (!external.has(raw)) external.set(raw, new Set());
      external.get(raw)!.add(page);
      continue;
    }
    internal++;
    const url = new URL(raw, `http://site${page}`);
    const target = targetFile(url.pathname);
    if (!target) {
      problems.push(`${page}: ${raw} does not resolve`);
      continue;
    }
    if (url.hash && target.endsWith(".html") && !idsOf(target).has(decodeURIComponent(url.hash.slice(1)))) problems.push(`${page}: ${raw}: no such anchor`);
  }
}

console.log(`${internal} internal links and anchors, ${repoFiles} links to repository files, ${external.size} distinct external links`);

if (process.argv.includes("--external")) {
  const bad: string[] = [];
  for (const url of external.keys()) {
    let status = 0;
    try {
      const r = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (link check)" }, signal: AbortSignal.timeout(20_000) });
      status = r.status;
    } catch {
      status = 0;
    }
    console.log(`${status || "ERR"} ${url}`);
    if (status < 200 || status >= 400) bad.push(`${status || "ERR"} ${url} (on ${[...external.get(url)!].join(", ")})`);
  }
  if (bad.length) console.log(`\nExternal links that didn't answer 2xx/3xx:\n${bad.join("\n")}`);
} else {
  console.log("External links (not fetched; pass --external to fetch):");
  for (const url of [...external.keys()].sort()) console.log(`  ${url}`);
}

if (problems.length) {
  console.error(`\n${problems.length} broken:\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("All internal links resolve.");
