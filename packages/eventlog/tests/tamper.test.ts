import { describe, expect, it } from "vitest";
import { utf8, fromUtf8 } from "@zk-toip/trust-core";
import { verifyKel } from "../src/kel";
import { verifyTrail } from "../src/trail";
import { exportBundle } from "../src/verify";
import { incept } from "./helpers";

const EXPECTED = new Set([
  "badVersion",
  "badFields",
  "unsupported",
  "saidMismatch",
  "badSequence",
  "badChain",
  "signatureInvalid",
  "thresholdNotMet",
  "nextKeyMismatch",
  "unknownKeyState",
  "staleKeyState",
  "sealMismatch",
  "timeReversed",
  "truncated",
  "duplicity",
  "unsealedRotation",
]);

// a small deterministic PRNG, so a failure can be replayed
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
  };
}

describe("tamper detection", () => {
  it("any byte flip fails (10,000 flips)", { timeout: 120_000 }, async () => {
    const env = await incept("flip");
    const t = await env.c.openTrail("agent/actions");
    await t.append({ kind: "agent/tool-call", body: { a: 1 } });
    await env.c.rotate();
    await t.append({ kind: "agent/tool-call", body: { a: 2 } });
    const b = await exportBundle(env.store, env.c.aid);
    const kelBytes = utf8(b.kel);
    const trailBytes = utf8(b.trails[0].stream);
    const goodKel = await verifyKel(b.kel, { allowUnwitnessed: true });
    expect(goodKel.ok).toBe(true);
    expect((await verifyTrail({ kel: goodKel, stream: b.trails[0].stream }, { allowUnwitnessed: true })).ok).toBe(true);
    const rand = rng(42);
    const seenCodes = new Set<string>();
    const total = kelBytes.length + trailBytes.length;
    for (let n = 0; n < 10_000; n++) {
      const at = Math.floor(rand() * total);
      const inKel = at < kelBytes.length;
      const src = inKel ? kelBytes : trailBytes;
      const i = inKel ? at : at - kelBytes.length;
      const copy = src.slice();
      copy[i] ^= 1 << Math.floor(rand() * 8);
      const text = fromUtf8(copy);
      let problems: { code: string }[];
      let ok: boolean;
      if (inKel) {
        const r = await verifyKel(text, { allowUnwitnessed: true });
        ok = r.ok;
        problems = r.problems;
      } else {
        const r = await verifyTrail({ kel: goodKel, stream: text }, { allowUnwitnessed: true });
        ok = r.ok;
        problems = r.problems;
      }
      if (ok) throw new Error(`flip ${n} at byte ${at} was not detected`);
      for (const p of problems) {
        seenCodes.add(p.code);
        if (!EXPECTED.has(p.code)) throw new Error(`flip ${n}: unexpected problem ${p.code}: ${JSON.stringify(p)}`);
      }
    }
    expect(seenCodes.has("saidMismatch")).toBe(true);
    expect(seenCodes.has("signatureInvalid")).toBe(true);
  });
});
