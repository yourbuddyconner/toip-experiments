/** Removes Capture's embedded store from a JPEG or PNG, as a platform that strips metadata would: npm run strip -- <file> [out] */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { contentHash, hex, withoutStore } from "../../src/core";

const [inPath, outPath] = process.argv.slice(2);
if (!inPath) {
  console.error("usage: npm run strip --workspace @toip-tools/capture -- <photo> [output]");
  process.exit(1);
}
const file = new Uint8Array(readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), inPath)));
const out = withoutStore(file);
const dest = resolve(process.env.INIT_CWD ?? process.cwd(), outPath ?? inPath.replace(/(\.[a-z]+)$/i, "-stripped$1"));
writeFileSync(dest, out);
console.log(`wrote ${dest}: ${file.length - out.length} bytes of credentials removed; fingerprint ${hex(contentHash(out)).slice(0, 16)}… (unchanged)`);
