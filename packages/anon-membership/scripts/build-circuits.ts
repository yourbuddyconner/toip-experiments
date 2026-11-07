// Rebuilds the committed circuit artifacts. Needs nargo 1.0.0 and bb 6.0.0; consumers and tests don't.
//
//   npm run build:circuits --workspace @toip-tools/anon-membership
//
// Writes artifacts/gate_d20.json (nargo's output), artifacts/gate_d20.meta.json (id, vk, vkHash,
// gate count) and artifacts/crs.json (the CRS points the prover needs, so nothing is fetched at
// proving time). The points come from bb's local CRS cache (CRS_PATH, default ~/.bb-crs).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { toB64u } from "@toip-tools/trust-core";
import { G2_POINT_HEX } from "../src/g2";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const circuits = join(pkg, "circuits");
const out = join(pkg, "artifacts");
const nargo = process.env.NARGO ?? join(homedir(), ".nargo/bin/nargo");
const bb = process.env.BB ?? join(homedir(), ".bb/bb");
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

console.log(run(nargo, ["--version"]).split("\n")[0], "/ bb", run(bb, ["--version"]).trim());
run(nargo, ["compile", "--program-dir", circuits, "--package", "gate_d20"]);
const compiled = join(circuits, "target", "gate_d20.json");
copyFileSync(compiled, join(out, "gate_d20.json"));

const tmp = mkdtempSync(join(tmpdir(), "anon-membership-vk-"));
run(bb, ["write_vk", "-b", compiled, "-o", tmp, "-t", "noir-recursive"]);
const vk = readFileSync(join(tmp, "vk"));
const gates = JSON.parse(run(bb, ["gates", "-b", compiled]).replace(/^[^{]*/, "")).functions[0].circuit_size as number;
// The prover needs at least the circuit's padded size in CRS points.
const points = 2 ** Math.ceil(Math.log2(gates));

const meta = {
  id: "anon-membership/v1/gate-d20",
  depth: 20,
  gates,
  crsPoints: points,
  vk: toB64u(vk),
  vkHash: bytesToHex(sha256(vk)),
  toolchain: { nargo: "1.0.0", bb: "6.0.0", poseidon: "noir-lang/poseidon v0.4.0", verifierTarget: "noir-recursive" },
};
writeFileSync(join(out, "gate_d20.meta.json"), JSON.stringify(meta, null, 2) + "\n");

const crsDir = process.env.CRS_PATH ?? join(homedir(), ".bb-crs");
const g1File = join(crsDir, "bn254_g1.dat");
if (!existsSync(g1File)) throw new Error(`${g1File} is missing. Run any bb prove once to fill bb's CRS cache.`);
const g1 = new Uint8Array(points * 64);
const fd = openSync(g1File, "r");
if (readSync(fd, g1, 0, g1.length, 0) !== g1.length) throw new Error(`${g1File} holds fewer than ${points} points`);
const crs = { points, g1: toB64u(g1), g2: toB64u(Buffer.from(G2_POINT_HEX, "hex")), g1Sha256: bytesToHex(sha256(g1)) };
writeFileSync(join(out, "crs.json"), JSON.stringify(crs) + "\n");

console.log(`gate_d20: ${gates} gates, ${points} CRS points (${g1.length} bytes), vkHash ${meta.vkHash}`);
