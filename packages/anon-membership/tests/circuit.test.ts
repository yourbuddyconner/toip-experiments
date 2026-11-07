import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BackendType, Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { CIRCUIT_ID, loadArtifacts } from "../src/artifacts";
import { G2_POINT_HEX, bundledCrs } from "../src/crs";
import { vectorsToNoir, type Vectors } from "../scripts/vectors";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const nargo = join(homedir(), ".nargo/bin/nargo");

describe("committed circuit artifacts", () => {
  it("are the depth-20 gate circuit, with a key that matches its hash", async () => {
    const a = await loadArtifacts();
    expect(a.id).toBe(CIRCUIT_ID);
    expect(a.depth).toBe(20);
    expect(a.vkHash).toBe(bytesToHex(sha256(a.vk)));
    expect(a.gates).toBeGreaterThan(1000);
    expect(a.gates).toBeLessThanOrEqual(a.crsPoints);
    await expect(loadArtifacts(24)).rejects.toThrow(/depth 24/);
  });

  it("the committed key is the one bb.js computes from the committed bytecode for the ZK target", async () => {
    const a = await loadArtifacts();
    const api = await Barretenberg.new({ backend: BackendType.Wasm, skipSrsInit: true, threads: 2 });
    const crs = bundledCrs();
    await api.srsInitSrs({ pointsBuf: crs.g1, numPoints: crs.points, g2Point: crs.g2 });
    const vk = await new UltraHonkBackend(a.circuit.bytecode, api).getVerificationKey({ verifierTarget: "noir-recursive" });
    await api.destroy();
    expect(bytesToHex(vk)).toBe(bytesToHex(a.vk));
  });

  it("the bundled CRS starts with the BN254 generator and has the Ignition G2 point", async () => {
    const crs = bundledCrs();
    expect(crs.points).toBe((await loadArtifacts()).crsPoints);
    const one = new Uint8Array(64);
    one[31] = 1;
    one[63] = 2;
    expect(bytesToHex(crs.g1.subarray(0, 64))).toBe(bytesToHex(one));
    expect(bytesToHex(crs.g2)).toBe(G2_POINT_HEX);
    const meta = JSON.parse(readFileSync(join(pkg, "artifacts/crs.json"), "utf8"));
    expect(bytesToHex(sha256(crs.g1))).toBe(meta.g1Sha256);
  });

  it.skipIf(!existsSync(join(homedir(), ".bb-crs/bn254_g1.dat")))("the bundled points are a prefix of bb's downloaded CRS", () => {
    const crs = bundledCrs();
    const buf = new Uint8Array(crs.g1.length);
    readSync(openSync(join(homedir(), ".bb-crs/bn254_g1.dat"), "r"), buf, 0, buf.length, 0);
    expect(bytesToHex(buf)).toBe(bytesToHex(crs.g1));
  });
});

describe("TypeScript and Noir hashing agree", () => {
  it("the Noir vector tests are generated from the committed vectors", () => {
    const v = JSON.parse(readFileSync(join(pkg, "tests/vectors.json"), "utf8")) as Vectors;
    expect(readFileSync(join(pkg, "circuits/lib/src/vectors.nr"), "utf8")).toBe(vectorsToNoir(v));
  });

  it.skipIf(!existsSync(nargo))(
    "nargo test passes: circuit tests and hash vectors",
    () => {
      const out = execFileSync(nargo, ["test", "--program-dir", join(pkg, "circuits"), "--package", "anon_membership"], { encoding: "utf8" });
      expect(out).toMatch(/\d+ tests passed/);
      expect(out).not.toMatch(/failed/);
    },
    120_000,
  );
});
