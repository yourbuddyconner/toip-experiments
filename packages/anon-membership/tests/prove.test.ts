import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BackendType, Barretenberg, UltraHonkBackend, UltraHonkVerifierBackend } from "@aztec/bb.js";
import { Noir } from "@noir-lang/noir_js";
import { fromB64u, toB64u } from "@zk-toip/trust-core";
import { loadArtifacts, vkHashOf } from "../src/artifacts";
import { bundledCrs } from "../src/crs";
import { fieldFromBytes, fieldToBytes, fieldToHex } from "../src/field";
import { commitmentOf, initHashing, leafHash, nullifierOf, type Leaf } from "../src/hash";
import { membershipInputs } from "../src/member";
import { MembershipError, MembershipProver, MembershipVerifier, PROOF_SYSTEM, type MembershipProof } from "../src/prove";
import { circuitInputs, publicInputs, type Statement, type Witness } from "../src/statement";
import { GroupTree } from "../src/tree";

const f = (s: string) => fieldFromBytes(new TextEncoder().encode(s));
const TODAY = 20763;
const GROUP = "did:key:z6MkAcme#employees";
const OTHER = "did:key:z6MkPine#nurses";
const SECRET = f("member secret");
const SCOPE = f("scope one");
const SIGNAL = f("signal one");

let prover: MembershipProver;
let verifier: MembershipVerifier;
let fetchCalls: string[] = [];

/** A 4,000-leaf group with our member at index 3001. */
function bigTree(leaf: Leaf): GroupTree {
  const leaves = Array.from({ length: 4000 }, (_, i) => f(`filler ${i}`));
  leaves[3001] = leafHash(leaf);
  return GroupTree.fromLeaves(leaves, 20);
}

let tree: GroupTree;
let plain: { statement: Statement; witness: Witness };
let proof: MembershipProof;

beforeAll(async () => {
  await initHashing();
  // Any network access from here on is a failure: setup data is bundled.
  vi.stubGlobal("fetch", (url: unknown) => {
    fetchCalls.push(String(url));
    throw new Error(`unexpected fetch of ${String(url)}`);
  });
  prover = await MembershipProver.create();
  verifier = await MembershipVerifier.create();
  const c = commitmentOf(SECRET, fieldFromBytes(new TextEncoder().encode(GROUP)));
  tree = bigTree({ commitment: c, schemaId: 0n, validUntilDay: 2 ** 32 - 1, registeredDay: 0, attrs: [0n, 0n, 0n, 0n] });
  plain = membershipInputs({ secret: SECRET, groups: [{ group: GROUP, tree }], scope: SCOPE, signal: SIGNAL, today: TODAY });
  proof = await prover.prove(plain.statement, plain.witness);
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await prover?.destroy();
  await verifier?.destroy();
});

describe("proving and verifying", () => {
  it("a member's proof verifies, with the member's nullifier", async () => {
    expect(proof.system).toBe(PROOF_SYSTEM);
    expect(proof.vkHash).toBe((await loadArtifacts()).vkHash);
    expect(fromB64u(proof.proof).length).toBeLessThan(32 * 1024);
    const r = await verifier.verify(proof, plain.statement);
    expect(r).toMatchObject({ ok: true, nullifier: nullifierOf(SECRET, SCOPE, 0) });
  });

  it("nothing was fetched from the network", () => {
    expect(fetchCalls).toEqual([]);
  });

  it("a non-member can't produce a proof", async () => {
    expect(() =>
      membershipInputs({ secret: SECRET + 1n, groups: [{ group: GROUP, tree }], scope: SCOPE, signal: SIGNAL, today: TODAY }),
    ).toThrow(MembershipError);
    // Claiming someone else's leaf with the wrong secret.
    const bad = { ...plain.witness, secret: SECRET + 1n };
    await expect(prover.prove(plain.statement, bad)).rejects.toThrow(MembershipError);
  });

  it("the circuit itself refuses a witness that skips the library's checks", async () => {
    const a = await loadArtifacts();
    const inputs = circuitInputs(plain.statement, { ...plain.witness, secret: SECRET + 1n });
    await expect(new Noir(a.circuit).execute(inputs as never)).rejects.toThrow(/leaf not under the root/);
  });

  it("a changed signal, scope, root or nullifier fails verification", async () => {
    const s = proof.statement;
    const variants: MembershipProof[] = [
      { ...proof, statement: { ...s, signal: fieldToHex(SIGNAL + 1n) } },
      { ...proof, statement: { ...s, scope: fieldToHex(SCOPE + 1n) } },
      { ...proof, statement: { ...s, groups: [{ ...s.groups[0], root: fieldToHex(tree.root() + 1n) }] } },
      { ...proof, nullifier: fieldToHex(nullifierOf(SECRET, SCOPE, 0) + 1n) },
    ];
    for (const v of variants) expect(await verifier.verify(v)).toEqual({ ok: false, reason: "proofInvalid" });
  });

  it("changing any single one of the 23 public inputs fails verification", async () => {
    const a = await loadArtifacts();
    const api = await Barretenberg.new({ backend: BackendType.Wasm, skipSrsInit: true, threads: 4 });
    const crs = bundledCrs();
    await api.srsInitSrs({ pointsBuf: crs.g1, numPoints: crs.points, g2Point: crs.g2 });
    const v = new UltraHonkVerifierBackend(api);
    const inputs = publicInputs(plain.statement, nullifierOf(SECRET, SCOPE, 0)).map(fieldToHex);
    expect(inputs.length).toBe(23);
    const bytes = fromB64u(proof.proof);
    expect(await v.verifyProof({ proof: bytes, publicInputs: inputs, verificationKey: a.vk }, { verifierTarget: "noir-recursive" })).toBe(true);
    for (let i = 0; i < inputs.length; i++) {
      const changed = [...inputs];
      changed[i] = fieldToHex(BigInt(changed[i]) + 1n);
      const ok = await v.verifyProof({ proof: bytes, publicInputs: changed, verificationKey: a.vk }, { verifierTarget: "noir-recursive" }).catch(() => false);
      expect(ok, `public input ${i}`).toBe(false);
    }
    await api.destroy();
  }, 60_000);

  it("refuses a statement other than the expected one before checking the proof", async () => {
    const other = { ...plain.statement, signal: SIGNAL + 1n };
    expect(await verifier.verify(proof, other)).toEqual({ ok: false, reason: "statementMismatch" });
  });

  it("refuses a proof made without zero knowledge", async () => {
    const a = await loadArtifacts();
    const api = await Barretenberg.new({ backend: BackendType.Wasm, skipSrsInit: true, threads: 4 });
    const crs = bundledCrs();
    await api.srsInitSrs({ pointsBuf: crs.g1, numPoints: crs.points, g2Point: crs.g2 });
    const { witness } = await new Noir(a.circuit).execute(circuitInputs(plain.statement, plain.witness) as never);
    const plainProof = await new UltraHonkBackend(a.circuit.bytecode, api).generateProof(witness, { verifierTarget: "noir-recursive-no-zk" });
    await api.destroy();
    const forged: MembershipProof = { ...proof, proof: toB64u(plainProof.proof) };
    expect(await verifier.verify(forged)).toEqual({ ok: false, reason: "proofInvalid" });
  }, 60_000);

  it("two proofs of the same statement differ", async () => {
    const again = await prover.prove(plain.statement, plain.witness);
    expect(again.proof).not.toBe(proof.proof);
    expect(again.nullifier).toBe(proof.nullifier);
    expect((await verifier.verify(again)).ok).toBe(true);
  });

  it("the proof contains none of the secret, commitment, leaf, siblings or index (a smoke test, not a proof of ZK)", () => {
    const w = plain.witness;
    const bytes = fromB64u(proof.proof);
    const secrets = [w.secret, w.leaf.commitment, leafHash(w.leaf), ...w.path.siblings.slice(0, 12), BigInt(w.path.index)];
    const contains = (hay: Uint8Array, needle: Uint8Array) => {
      outer: for (let i = 0; i + needle.length <= hay.length; i++) {
        for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
        return true;
      }
      return false;
    };
    for (const s of secrets) expect(contains(bytes, fieldToBytes(s))).toBe(false);
    const json = JSON.stringify(proof);
    for (const s of secrets) expect(json.includes(fieldToHex(s).slice(2))).toBe(false);
    expect(json).not.toMatch(/3001/);
  });

  it("refuses an unknown circuit, a different verification key, and malformed proofs", async () => {
    expect(await verifier.verify({ ...proof, vkHash: "00".repeat(32) })).toEqual({ ok: false, reason: "unknownCircuit" });
    expect(await verifier.verify({ ...proof, circuit: "anon-membership/v1/other" })).toEqual({ ok: false, reason: "unknownCircuit" });
    // A verifier pinned to another key refuses the same proof.
    const a = await loadArtifacts();
    const vk = new Uint8Array(a.vk);
    vk[vk.length - 40] ^= 1;
    const wrong = await MembershipVerifier.create({ artifacts: [{ ...a, vk, vkHash: a.vkHash }] });
    expect((await wrong.verify(proof)).ok).toBe(false);
    await wrong.destroy();
    expect(vkHashOf(vk)).not.toBe(a.vkHash);
    expect(await verifier.verify({ ...proof, system: "ultrahonk/no-zk" })).toEqual({ ok: false, reason: "malformed" });
    expect(await verifier.verify({ ...proof, proof: "AAAA" })).toEqual({ ok: false, reason: "malformed" });
    expect(await verifier.verify(null)).toEqual({ ok: false, reason: "malformed" });
  });

  it("reports progress", async () => {
    const stages: string[] = [];
    await prover.prove(plain.statement, plain.witness, (p) => stages.push(p.stage));
    expect(stages).toEqual(["witness", "proving", "done"]);
  });
});

describe("the gate statement", () => {
  const nursing = "urn:agora:group:cascade-nursing-v1";
  const pine = "urn:agora:group:pine-nursing-v1";
  const schemaId = f("agora/schema/nursing-license/1");
  const RN = f("RN");
  const leafFields = { schemaId, validUntilDay: TODAY + 100, registeredDay: TODAY - 30, attrs: [RN, f("CA"), 20000n, 0n] as Leaf["attrs"] };
  let groups: { group: string; tree: GroupTree }[];

  beforeAll(() => {
    const member = { ...leafFields, commitment: commitmentOf(SECRET, fieldFromBytes(new TextEncoder().encode(pine))) };
    groups = [
      { group: OTHER, tree: GroupTree.fromLeaves([f("x"), f("y")], 20) },
      { group: nursing, tree: GroupTree.fromLeaves([f("a"), f("b"), f("c")], 20) },
      { group: pine, tree: GroupTree.fromLeaves([f("d"), leafHash(member), f("e")], 20) },
      { group: "urn:agora:group:four", tree: GroupTree.fromLeaves([f("z")], 20) },
    ];
  });

  const gate = (over: Partial<Parameters<typeof membershipInputs>[0]> = {}) =>
    membershipInputs({
      secret: SECRET,
      groups,
      leaf: leafFields,
      scope: SCOPE,
      signal: SIGNAL,
      today: TODAY,
      registeredBy: TODAY - 7,
      schemaId,
      predicates: [{ op: "eq", value: RN }, { op: "any" }, { op: "gte", value: 19000n }],
      ...over,
    });

  it("proves membership in one of four groups without saying which", async () => {
    const { statement, witness } = gate();
    expect(witness.groupIndex).toBe(2);
    const p = await prover.prove(statement, witness);
    expect(JSON.stringify(p.statement)).not.toMatch(/groupIndex/);
    const r = await verifier.verify(p, statement);
    expect(r.ok).toBe(true);
    // The nullifier doesn't depend on the group the member proves from.
    expect(r.ok && r.nullifier).toBe(nullifierOf(SECRET, SCOPE, 0));
  }, 60_000);

  it("expired membership fails", async () => {
    const { statement, witness } = gate({ today: TODAY + 101, registeredBy: TODAY });
    await expect(prover.prove(statement, witness)).rejects.toThrow(/expired/);
  });

  it("a leaf registered after registeredBy fails", async () => {
    const { statement, witness } = gate({ registeredBy: TODAY - 31 });
    await expect(prover.prove(statement, witness)).rejects.toThrow(/registered too recently/);
  });

  it("unmet predicates fail", async () => {
    for (const predicates of [
      [{ op: "eq" as const, value: f("LPN") }],
      [{ op: "any" as const }, { op: "any" as const }, { op: "gte" as const, value: 20001n }],
      [{ op: "any" as const }, { op: "any" as const }, { op: "lte" as const, value: 19999n }],
    ]) {
      const { statement, witness } = gate({ predicates });
      await expect(prover.prove(statement, witness)).rejects.toThrow(/predicate/);
    }
  });

  it("k must be below the limit; each k gives its own nullifier", async () => {
    const two = gate({ limit: 2, messageIndex: 1 });
    const p = await prover.prove(two.statement, two.witness);
    const r = await verifier.verify(p, two.statement);
    expect(r.ok && r.nullifier).toBe(nullifierOf(SECRET, SCOPE, 1));
    expect(nullifierOf(SECRET, SCOPE, 1)).not.toBe(nullifierOf(SECRET, SCOPE, 0));
    const over = gate({ limit: 2, messageIndex: 2 });
    await expect(prover.prove(over.statement, over.witness)).rejects.toThrow(/limit/);
  }, 60_000);

  it("a statement with a schema the leaf doesn't have fails", async () => {
    const { statement, witness } = gate();
    await expect(prover.prove({ ...statement, schemaId: schemaId + 1n }, witness)).rejects.toThrow(MembershipError);
  });
});
