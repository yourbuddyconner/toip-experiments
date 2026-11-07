/** The witness HTTP API, as a fetch-style handler and a client. Browser-safe. */
import type { SubmitResult, WitnessClient } from "./client.js";
import { evidenceFromJson, evidenceToJson, type StoredEvidence } from "./store.js";
import { fromStream, toStream } from "./stream.js";
import type { DuplicityEvidence, Qb64 } from "./types.js";
import type { Witness } from "./witness.js";

const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/cesr; charset=utf-8" } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Routes, relative to wherever the handler is mounted:
 * POST submit (CESR text) → SubmitResult; POST receipts (CESR text) → {}; GET log/:id?from&to → CESR text;
 * GET head/:id → CESR text of the witness's receipt (404 if none); GET evidence?logId → evidence as JSON.
 */
export function witnessHttpHandler(w: Witness): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      const last = parts[parts.length - 1];
      const prev = parts[parts.length - 2];
      if (req.method === "POST" && last === "submit") return json(await w.submit(await req.text()));
      if (req.method === "POST" && last === "receipts") {
        await w.addReceipts(await req.text());
        return json({});
      }
      if (req.method === "GET" && prev === "log") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        return text(await w.query({ logId: decodeURIComponent(last), ...(from ? { from: Number(from) } : {}), ...(to ? { to: Number(to) } : {}) }));
      }
      if (req.method === "GET" && prev === "head") {
        const h = await w.head(decodeURIComponent(last));
        if (!h) return text("", 404);
        return text(toStream([h]));
      }
      if (req.method === "GET" && last === "evidence") {
        const logId = url.searchParams.get("logId") ?? undefined;
        return json((await w.evidence(logId)).map(evidenceToJson));
      }
      if (req.method === "GET" && last === "info") return json({ aid: w.aid, did: w.did });
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  };
}

export function httpWitnessClient(baseUrl: string, aid: Qb64, opts: { fetch?: typeof fetch } = {}): WitnessClient & { evidence(logId?: Qb64): Promise<DuplicityEvidence[]> } {
  const f = opts.fetch ?? fetch;
  const base = baseUrl.replace(/\/$/, "");
  const check = async (r: Response) => {
    if (!r.ok && r.status !== 404) throw new Error(`witness ${aid}: HTTP ${r.status} ${await r.text()}`);
    return r;
  };
  return {
    aid,
    submit: async (stream) => (await (await check(await f(`${base}/submit`, { method: "POST", body: stream }))).json()) as SubmitResult,
    addReceipts: async (stream) => {
      await check(await f(`${base}/receipts`, { method: "POST", body: stream }));
    },
    query: async (q) => {
      const p = new URLSearchParams();
      if (q.from !== undefined) p.set("from", String(q.from));
      if (q.to !== undefined) p.set("to", String(q.to));
      const r = await check(await f(`${base}/log/${encodeURIComponent(q.logId)}?${p}`));
      return r.status === 404 ? "" : r.text();
    },
    head: async (logId) => {
      const r = await check(await f(`${base}/head/${encodeURIComponent(logId)}`));
      if (r.status === 404) return undefined;
      return fromStream(await r.text()).messages[0];
    },
    evidence: async (logId) => {
      const r = await check(await f(`${base}/evidence${logId ? `?logId=${encodeURIComponent(logId)}` : ""}`));
      return ((await r.json()) as StoredEvidence[]).map(evidenceFromJson);
    },
  };
}
