/** Presentations: what a delegate shows a counterparty before it acts (agents design §8.7). */
import { signDocument, type Clock, type Identity } from "@toip-tools/trust-core";
import type { Presentation } from "./types";

/** Signs a presentation by `holder`, the leaf's subject. `audience` and `action` bind it to one counterparty and one action. */
export function present(holder: Identity, clock: Clock, o: Omit<Presentation, "type" | "issuer" | "at" | "proof">): Presentation {
  const { type: _t, issuer: _i, at: _a, proof: _p, ...rest } = o as Partial<Presentation>;
  const body = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  const doc = { type: "mandates/presentation", issuer: holder.did, ...body, at: clock.iso() } as Presentation;
  return signDocument(doc, holder, clock);
}
