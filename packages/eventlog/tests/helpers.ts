import { DemoClock, identityFromSeed, seedFrom } from "@zk-toip/trust-core";
import { utf8 } from "@zk-toip/trust-core";
import { Controller, type InceptOptions } from "../src/controller";
import { coldKeysFromSeed, ed25519Signer, keyQb64, signWith, type Signer } from "../src/keys";
import { MemoryStore } from "../src/store";
import { Witness, localWitnessClient } from "../src/witness";
import type { IndexedSig, IndexedSigCode, SignedMessage } from "../src/types";

export const T0 = "2026-11-06T18:00:00.000Z";

export function signer(label: string): Signer {
  return ed25519Signer(seedFrom(label));
}

export function setup(label = "agent") {
  const clock = new DemoClock(T0);
  const store = new MemoryStore();
  const cold = coldKeysFromSeed(seedFrom(`${label}/cold`), label);
  const hot = [signer(`${label}/hot`)];
  return { clock, store, cold, hot };
}

export async function incept(label = "agent", extra: Partial<InceptOptions> = {}) {
  const s = setup(label);
  const c = await Controller.incept({ hot: s.hot, cold: s.cold, store: s.store, clock: s.clock, ...extra });
  return { ...s, c };
}

export function witnesses(clock: DemoClock, n: number, label = "w") {
  return Array.from({ length: n }, (_, i) => {
    const w = new Witness({ signer: signer(`${label}/${i}`), store: new MemoryStore(), clock });
    return { w, client: localWitnessClient(w) };
  });
}

/** Signs raw with explicit indexes and codes. */
export async function sign(raw: string, specs: { s: Signer; index: number; ondex?: number; code?: IndexedSigCode }[]): Promise<IndexedSig[]> {
  const out: IndexedSig[] = [];
  for (const sp of specs) {
    const { sig } = await signWith(sp.s, utf8(raw));
    const code = sp.code ?? (sp.ondex === undefined ? "A" : sp.ondex === sp.index ? "A" : "2A");
    const one: IndexedSig = { code, index: sp.index, sig };
    if (code === "A" || code === "2A") one.ondex = sp.ondex ?? sp.index;
    out.push(one);
  }
  return out;
}

export function msgOf(t: SignedMessage["t"], raw: string, body: Record<string, unknown>): SignedMessage {
  return { t, raw, body, logId: String(body.i), s: parseInt(String(body.s), 16), d: String(body.d) };
}

export { keyQb64, identityFromSeed, seedFrom };
