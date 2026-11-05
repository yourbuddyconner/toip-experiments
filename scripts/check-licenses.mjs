// Lists every installed package's license. Fails on the GPL family (GPL, AGPL, LGPL) and other strong copyleft.
// Weak, file-level copyleft (MPL-2.0) is allowed only for build-time tooling, and printed as a warning.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const COPYLEFT = /\b(A?GPL|LGPL|EUPL|SSPL|OSL)\b/i;
const WEAK = /\b(MPL|CDDL|EPL)\b/i;
const BUILD_ONLY = new Set(["lightningcss", "lightningcss-darwin-arm64", "lightningcss-darwin-x64", "lightningcss-linux-x64-gnu", "lightningcss-linux-arm64-gnu", "lightningcss-win32-x64-msvc"]);
const seen = new Map();
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    if (name.startsWith("@")) { walk(p); continue; }
    const pj = join(p, "package.json");
    if (!existsSync(pj)) continue;
    const j = JSON.parse(readFileSync(pj, "utf8"));
    const lic = typeof j.license === "string" ? j.license : JSON.stringify(j.license ?? j.licenses ?? "UNKNOWN");
    seen.set(`${j.name}@${j.version}`, lic);
    walk(join(p, "node_modules"));
  }
}
walk("node_modules");
const bad = [...seen].filter(([k, l]) => COPYLEFT.test(l) || (WEAK.test(l) && !BUILD_ONLY.has(k.slice(0, k.lastIndexOf("@")))));
const warn = [...seen].filter(([k, l]) => WEAK.test(l) && BUILD_ONLY.has(k.slice(0, k.lastIndexOf("@"))));
if (warn.length) console.warn("weak copyleft, build-time only:", warn.map(([k]) => k).join(", "));
const counts = {};
for (const [, l] of seen) counts[l] = (counts[l] ?? 0) + 1;
console.log(counts);
if (bad.length) { console.error("copyleft:", bad); process.exit(1); }
