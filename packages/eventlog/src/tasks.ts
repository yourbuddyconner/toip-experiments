/** Trust Task transport for witnesses, disclosure and duplicity reports, over trust-core's Endpoint (TSP). */
import { ourSpec, Refusal, type Endpoint } from "@zk-toip/trust-core";
import { aidOfDidKey } from "./cesr";
import type { SubmitResult, WitnessClient } from "./client";
import { evidenceFromJson, evidenceToJson, type StoredEvidence } from "./store";
import { fromStream, toStream } from "./stream";
import type { DuplicityEvidence, Qb64 } from "./types";
import type { Bundle } from "./verify";
import type { Witness } from "./witness";

export const TRAIL_TASKS = {
  submit: ourSpec("trail/witness/submit"),
  receipts: ourSpec("trail/witness/receipts"),
  query: ourSpec("trail/query"),
  head: ourSpec("trail/head"),
  disclose: ourSpec("trail/disclose"),
  duplicity: ourSpec("trail/duplicity"),
};

/** Serves a witness on an endpoint whose identity is the witness's own key (its did:key). */
export function serveWitnessTasks(endpoint: Endpoint, w: Witness): void {
  if (endpoint.vid !== w.did) throw new Error("the endpoint's DID must be the witness's did:key");
  endpoint.handle<{ stream: string }, SubmitResult>(TRAIL_TASKS.submit, async (doc) => {
    if (typeof doc.payload?.stream !== "string") return new Refusal("badRequest", "stream must be text");
    return w.submit(doc.payload.stream);
  });
  endpoint.handle<{ stream: string }, Record<string, never>>(TRAIL_TASKS.receipts, async (doc) => {
    if (typeof doc.payload?.stream !== "string") return new Refusal("badRequest", "stream must be text");
    await w.addReceipts(doc.payload.stream);
    return {};
  });
  endpoint.handle<{ logId: Qb64; from?: number; to?: number }, { stream: string }>(TRAIL_TASKS.query, async (doc) => {
    if (typeof doc.payload?.logId !== "string") return new Refusal("badRequest", "logId must be text");
    return { stream: await w.query(doc.payload) };
  });
  endpoint.handle<{ logId: Qb64 }, { receipt: string | null }>(TRAIL_TASKS.head, async (doc) => {
    if (typeof doc.payload?.logId !== "string") return new Refusal("badRequest", "logId must be text");
    const h = await w.head(doc.payload.logId);
    return { receipt: h ? toStream([h]) : null };
  });
}

/** A witness reached over TSP at its did:key. */
export function taskWitnessClient(endpoint: Endpoint, witnessDid: string): WitnessClient {
  return {
    aid: aidOfDidKey(witnessDid),
    submit: async (stream) => (await endpoint.request<{ stream: string }, SubmitResult>(witnessDid, TRAIL_TASKS.submit, { stream })).payload,
    addReceipts: async (stream) => {
      await endpoint.request(witnessDid, TRAIL_TASKS.receipts, { stream });
    },
    query: async (q) => (await endpoint.request<typeof q, { stream: string }>(witnessDid, TRAIL_TASKS.query, q)).payload.stream,
    head: async (logId) => {
      const r = (await endpoint.request<{ logId: Qb64 }, { receipt: string | null }>(witnessDid, TRAIL_TASKS.head, { logId })).payload.receipt;
      return r ? fromStream(r).messages[0] : undefined;
    },
  };
}

/** Sends a bundle (with the bodies chosen for this reader) over TSP: `trail/disclose`. */
export async function disclose(endpoint: Endpoint, to: string, bundle: Bundle): Promise<void> {
  await endpoint.request(to, TRAIL_TASKS.disclose, { bundle });
}

export function onDisclose(endpoint: Endpoint, handler: (bundle: Bundle, from: string) => Promise<void> | void): void {
  endpoint.handle<{ bundle: Bundle }, Record<string, never>>(TRAIL_TASKS.disclose, async (doc, ctx) => {
    if (!doc.payload?.bundle || typeof doc.payload.bundle.kel !== "string") return new Refusal("badRequest", "bundle missing");
    await handler(doc.payload.bundle, ctx.sender);
    return {};
  });
}

/** Sends duplicity evidence to someone who relies on the log: `trail/duplicity`. */
export async function reportDuplicity(endpoint: Endpoint, to: string, evidence: DuplicityEvidence): Promise<void> {
  await endpoint.request(to, TRAIL_TASKS.duplicity, { evidence: evidenceToJson(evidence) });
}

export function onDuplicity(endpoint: Endpoint, handler: (e: DuplicityEvidence, from: string) => Promise<void> | void): void {
  endpoint.handle<{ evidence: StoredEvidence }, Record<string, never>>(TRAIL_TASKS.duplicity, async (doc, ctx) => {
    let e: DuplicityEvidence;
    try {
      e = evidenceFromJson(doc.payload.evidence);
      if (!e.a || !e.b) throw new Error("bad evidence");
    } catch {
      return new Refusal("badRequest", "evidence does not parse");
    }
    await handler(e, ctx.sender);
    return {};
  });
}
