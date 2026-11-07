// Lists the license of every package installed in site/node_modules, and fails on any copyleft one
// (GPL, AGPL, LGPL, MPL and the like), build-time tools included.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SITE_DIR } from "./config";

const COPYLEFT = /\b(A?GPL|LGPL|MPL|EUPL|SSPL|OSL|CDDL|EPL|CC-BY-SA)\b/i;
const seen = new Map<string, string>();

function walk(dir: string) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    if (name.startsWith("@")) {
      walk(p);
      continue;
    }
    const pj = join(p, "package.json");
    if (!existsSync(pj)) continue;
    const j = JSON.parse(readFileSync(pj, "utf8"));
    const lic = typeof j.license === "string" ? j.license : JSON.stringify(j.license ?? j.licenses ?? "UNKNOWN");
    seen.set(`${j.name}@${j.version}`, lic);
    walk(join(p, "node_modules"));
  }
}

walk(join(SITE_DIR, "node_modules"));
const counts: Record<string, number> = {};
for (const l of seen.values()) counts[l] = (counts[l] ?? 0) + 1;
console.log(`${seen.size} packages`, counts);
const bad = [...seen].filter(([, l]) => COPYLEFT.test(l) || l === "UNKNOWN");
if (bad.length) {
  console.error("not allowed:", bad);
  process.exit(1);
}
