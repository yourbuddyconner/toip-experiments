// npm run release:check: builds the libraries, packs each one without publishing, and checks the tarballs.
// Every export and bin target must be in the tarball, nothing from src/ or tests/ may be, and the
// libraries must share one version and depend on each other at that version.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const SOURCE = "@toip-tools/source";
const problems = [];
const rows = [];
// A folder without a package.json (a library still being designed) isn't a package yet.
const pkgs = readdirSync(join(root, "packages"))
  .filter((dir) => existsSync(join(root, "packages", dir, "package.json")))
  .map((dir) => ({ dir: join(root, "packages", dir), json: JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8")) }));
const names = new Set(pkgs.map((p) => p.json.name));
const versions = new Set(pkgs.map((p) => p.json.version));
if (versions.size !== 1) problems.push(`the libraries have different versions: ${[...versions].join(", ")}`);

function targets(exp, out = []) {
  if (typeof exp === "string") out.push(exp);
  else if (exp && typeof exp === "object") for (const [cond, v] of Object.entries(exp)) if (cond !== SOURCE) targets(v, out);
  return out;
}

for (const { dir, json } of pkgs) {
  const bad = (m) => problems.push(`${json.name}: ${m}`);
  if (json.private) bad("is private");
  if (json.license !== "Apache-2.0") bad(`license is ${json.license}`);
  for (const k of ["description", "repository", "homepage", "engines", "publishConfig", "exports", "files"]) if (!json[k]) bad(`has no ${k}`);
  for (const [dep, range] of Object.entries(json.dependencies ?? {})) if (names.has(dep) && range !== json.version) bad(`depends on ${dep}@${range}, not ${json.version}`);

  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const files = new Set(pack.files.map((f) => f.path));
  for (const need of ["package.json", "README.md", "LICENSE"]) if (!files.has(need)) bad(`tarball has no ${need}`);
  for (const t of [...targets(json.exports), ...Object.values(json.bin ?? {})]) if (!files.has(t.replace(/^\.\//, ""))) bad(`tarball has no ${t}`);
  for (const f of files) if (/^(src|tests|scripts|circuits|interop|results)\//.test(f)) bad(`tarball includes ${f}`);
  rows.push({ name: json.name, version: json.version, files: pack.entryCount, packed: `${(pack.size / 1024).toFixed(1)} kB`, unpacked: `${(pack.unpackedSize / 1024).toFixed(1)} kB` });
}

console.table(rows);
if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join("\n"));
  process.exit(1);
}
console.log(`✓ ${rows.length} packages ready to publish at ${[...versions][0]}`);
