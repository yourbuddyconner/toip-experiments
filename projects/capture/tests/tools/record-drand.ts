/** Records a few drand quicknet rounds as a test fixture, so tests check real beacons offline. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { QUICKNET } from "../../src/core/drand";

const base = `https://api.drand.sh/${QUICKNET.hash}/public`;
const latest = (await (await fetch(`${base}/latest`)).json()) as { round: number };
const rounds = [];
for (let r = latest.round - 4; r <= latest.round; r++) rounds.push(await (await fetch(`${base}/${r}`)).json());
const out = join(import.meta.dirname, "..", "fixtures", "drand-quicknet.json");
writeFileSync(out, JSON.stringify({ chain: QUICKNET.hash, recordedAt: new Date().toISOString(), rounds }, null, 2) + "\n");
console.log(`wrote ${rounds.length} rounds to ${out}`);
