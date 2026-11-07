import { beforeAll, describe, expect, it } from "vitest";
import { dayFromIso, fieldFromHex, fieldToHex, groupFieldOf, initHashing, sameStatement } from "@zk-toip/anon-membership";
import { canonicalJson } from "@zk-toip/trust-core";
import type { Gate, GroupDescriptor, SlotSpec } from "../src/protocol/documents";
import { docHash } from "../src/protocol/documents";
import { gateInWords, eligibility } from "../src/protocol/describe";
import { anonymityEstimate, compileGate, encodeAttribute, fieldOfText, forumNymScope, gateProblem, passSignal, pollScope, threadNymScope, voteSignal } from "../src/protocol/gate";
import { nymLook, nymName } from "../src/protocol/names";
import { ADJECTIVES, NOUNS } from "../src/protocol/words";

beforeAll(initHashing);

const slots: (SlotSpec | null)[] = [
  { name: "licenseType", label: "license type", from: "credentialSubject.licenseType", encoding: "hash", publishCounts: true },
  { name: "state", label: "state", from: "credentialSubject.state", encoding: "hash" },
  { name: "licensedSince", label: "licensed since", from: "credentialSubject.licensedSince", encoding: "day" },
  { name: "years", label: "years", from: "credentialSubject.years", encoding: "u64" },
];
const desc = (id: string, title: string, schema = "agora/schema/nursing-license/1"): GroupDescriptor => ({
  type: "agora/group",
  version: 1,
  id,
  issuer: id.split("#")[0],
  issuedAt: "",
  title,
  credentialLabel: "nursing license",
  source: { issuer: id.split("#")[0], credentialType: "NursingLicense", statusList: "" },
  schema: { id: schema, schemaId: fieldToHex(fieldOfText(schema)), slots },
  rotation: { maxPerYear: 2 },
  rootCadenceSeconds: 3600,
});
const cascade = desc("did:key:z6MkCascade#cascade", "Cascade Board of Nursing");
const pine = desc("did:key:z6MkPine#pine", "Pine Valley Board of Nursing");
const gate: Gate = {
  anyOf: [
    { group: cascade.id, registrar: cascade.issuer },
    { group: pine.id, registrar: pine.issuer },
  ],
  where: [{ attr: "licenseType", op: "eq", value: "RN" }],
  minRegisteredDays: 7,
  minAnonymitySet: 25,
};

describe("compileGate", () => {
  it("compiles each predicate kind with its slot's encoding", () => {
    const g: Gate = {
      ...gate,
      where: [
        { attr: "licenseType", op: "eq", value: "RN" },
        { attr: "licensedSince", op: "lte", value: "2020-01-01" },
        { attr: "years", op: "gte", value: "3" },
      ],
    };
    const s = compileGate({ gate: g, descs: [cascade, pine], roots: [11n, 22n], today: 20400, scope: 5n, signal: 6n });
    expect(s.groups).toEqual([
      { groupId: groupFieldOf(cascade.id), root: 11n },
      { groupId: groupFieldOf(pine.id), root: 22n },
    ]);
    expect(s.registeredBy).toBe(20393);
    expect(s.schemaId).toBe(fieldFromHex(cascade.schema.schemaId));
    expect(s.predicates).toEqual([
      { op: "eq", value: fieldOfText("RN") },
      { op: "any" },
      { op: "lte", value: BigInt(dayFromIso("2020-01-01")) },
      { op: "gte", value: 3n },
    ]);
    expect(s.limit).toBe(1);
  });

  it("refuses mixed schemas, unknown attributes, two predicates on one slot and ranges over hashes", () => {
    const other = desc("did:key:z6MkCity#res", "City", "agora/schema/residency/1");
    expect(gateProblem({ ...gate, anyOf: [gate.anyOf[0], { group: other.id, registrar: other.issuer }] }, [cascade, other])).toMatch(/same schema/);
    expect(gateProblem({ ...gate, where: [{ attr: "shoeSize", op: "eq", value: "9" }] }, [cascade, pine])).toMatch(/no attribute/);
    expect(gateProblem({ ...gate, where: [gate.where[0], gate.where[0]] }, [cascade, pine])).toMatch(/two predicates/);
    expect(gateProblem({ ...gate, where: [{ attr: "licenseType", op: "gte", value: "RN" }] }, [cascade, pine])).toMatch(/equality/);
    expect(gateProblem({ ...gate, anyOf: [] }, [])).toMatch(/1 to 4/);
    expect(gateProblem({ ...gate, anyOf: [{ group: cascade.id, registrar: "did:key:z6MkMallory" }] }, [cascade])).toMatch(/another registrar/);
    expect(() => compileGate({ gate: { ...gate, where: [{ attr: "x", op: "eq", value: "1" }] }, descs: [cascade, pine], roots: [1n, 2n], today: 1, scope: 1n, signal: 1n })).toThrow(/no attribute/);
  });

  it("is deterministic, so the host and the client compute the same statement", () => {
    const a = compileGate({ gate, descs: [cascade, pine], roots: [1n, 2n], today: 20400, scope: forumNymScope("f"), signal: 9n });
    const b = compileGate({ gate: JSON.parse(JSON.stringify(gate)), descs: [cascade, pine], roots: [1n, 2n], today: 20400, scope: forumNymScope("f"), signal: 9n });
    expect(sameStatement(a, b)).toBe(true);
  });

  it("encodes attributes: hash is f(utf8), u64 and day are integers", () => {
    expect(encodeAttribute("RN", "hash")).toBe(fieldOfText("RN"));
    expect(encodeAttribute("2026-11-06", "day")).toBe(20763n);
    expect(encodeAttribute("42", "u64")).toBe(42n);
    expect(() => encodeAttribute(String(1n << 64n), "u64")).toThrow();
    expect(() => encodeAttribute("yesterday", "day")).toThrow();
  });
});

describe("scopes and signals", () => {
  it("separates forums, threads and polls", () => {
    const xs = [forumNymScope("a"), forumNymScope("b"), threadNymScope("a", "t"), threadNymScope("a", "u"), pollScope("a")];
    expect(new Set(xs).size).toBe(xs.length);
  });

  it("binds a pass's signal to everything in it but its proofs", () => {
    const pass = { type: "agora/nym-pass", version: 1, id: "x", issuer: "did:key:z6MkA", issuedAt: "t", forum: "f", policy: "p", thread: null, nym: "0x01", validUntil: "u" } as const;
    const s = passSignal(pass);
    expect(passSignal({ ...pass, zk: { anything: 1 }, proof: { sig: 2 } } as never)).toBe(s);
    expect(passSignal({ ...pass, issuer: "did:key:z6MkB" })).not.toBe(s);
    expect(passSignal({ ...pass, forum: "g" })).not.toBe(s);
    expect(voteSignal("p", 0)).not.toBe(voteSignal("p", 1));
  });

  it("hashes documents as SHA-256 of JCS without the proof", async () => {
    const { sha256 } = await import("@noble/hashes/sha2.js");
    const { bytesToHex } = await import("@noble/hashes/utils.js");
    const doc = { b: 2, a: 1, proof: { x: 1 } };
    expect(docHash(doc)).toBe(bytesToHex(sha256(new TextEncoder().encode(canonicalJson({ a: 1, b: 2 })))));
  });
});

describe("nym names", () => {
  it("are stable, from 256 adjectives and 256 nouns", () => {
    expect(ADJECTIVES).toHaveLength(256);
    expect(NOUNS).toHaveLength(256);
    expect(new Set(ADJECTIVES).size).toBe(256);
    expect(new Set(NOUNS).size).toBe(256);
    const nym = fieldToHex(123456789n);
    expect(nymName(nym)).toBe(nymName(nym));
    expect(nymName(nym)).toMatch(/^[a-z]+-[a-z]+-\d{1,2}$/);
    expect(nymLook(nym).hue).toBeGreaterThanOrEqual(0);
    expect(nymName(fieldToHex(1n))).not.toBe(nymName(fieldToHex(2n)));
  });
});

describe("words for people", () => {
  it("says the gate", () => {
    expect(gateInWords(gate, [cascade, pine])).toBe("a nursing license with license type RN, from Cascade Board of Nursing or Pine Valley Board of Nursing, held in a group for at least 7 days");
  });

  it("explains why a member can't post, before any proof", () => {
    const lpn = { group: cascade.id, values: { licenseType: "LPN" }, registeredDay: 100, validUntilDay: 900, inRoot: true };
    expect(eligibility(gate, [cascade, pine], [lpn], 200)).toMatchObject({ ok: false, code: "attribute", reason: "This forum is for license type RN; yours is LPN." });
    const rn = { ...lpn, values: { licenseType: "RN" } };
    expect(eligibility(gate, [cascade, pine], [{ ...rn, registeredDay: 198 }], 200)).toMatchObject({ ok: false, code: "tooRecent" });
    expect(eligibility(gate, [cascade, pine], [{ ...rn, validUntilDay: 199 }], 200)).toMatchObject({ ok: false, code: "expired" });
    expect(eligibility(gate, [cascade, pine], [], 200)).toMatchObject({ ok: false, code: "noMembership" });
    expect(eligibility(gate, [cascade, pine], [rn], 200)).toEqual({ ok: true, group: cascade.id });
  });

  it("estimates the anonymity set from sizes, narrowed by counts for equality predicates", () => {
    const rn = fieldToHex(fieldOfText("RN"));
    const root = (size: number, n: number) => ({ size, ext: { counts: { licenseType: { [rn]: n } } } }) as never;
    expect(anonymityEstimate(gate, [cascade, pine], [root(42, 36), root(41, 37)])).toBe(73);
    expect(anonymityEstimate({ ...gate, where: [] }, [cascade, pine], [root(42, 36), root(41, 37)])).toBe(83);
  });
});
