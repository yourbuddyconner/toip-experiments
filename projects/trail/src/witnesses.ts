/**
 * The platform's witnesses, each its own HTTP service with its own key and store (design §9).
 * A witness can be switched to "rogue": it then receipts every version it is shown (demo step 6).
 */
import { type Clock } from "@toip-tools/trust-core";
import { ed25519Signer, fromStream, makeReceipt, toStream, Witness, witnessHttpHandler, type LogStore, type SignedMessage, type SubmitResult } from "@toip-tools/eventlog";
import { serveHttp } from "@toip-tools/eventlog/node";

export class WitnessService {
  readonly witness: Witness;
  readonly aid: string;
  rogue = false;
  private readonly signer;
  private readonly inner: (req: Request) => Promise<Response>;
  private server?: { url: string; close: () => Promise<void> };

  constructor(
    readonly n: number,
    seed: Uint8Array,
    readonly store: LogStore,
    readonly clock: Clock,
  ) {
    this.signer = ed25519Signer(seed);
    this.witness = new Witness({ signer: this.signer, store, clock });
    this.aid = this.witness.aid;
    this.inner = witnessHttpHandler(this.witness);
  }

  get name(): string {
    return `Witness ${this.n}`;
  }

  get url(): string {
    if (!this.server) throw new Error(`${this.name} is not listening`);
    return this.server.url;
  }

  async listen(port: number, host: string): Promise<void> {
    this.server = await serveHttp(this.handler, { port, host });
  }

  /** The witness HTTP API. Honest unless `rogue`. */
  readonly handler = async (req: Request): Promise<Response> => {
    if (this.rogue && req.method === "POST" && new URL(req.url).pathname.endsWith("/submit")) {
      const out = await this.submitAnything(await req.text());
      return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
    }
    return this.inner(req);
  };

  /**
   * Rogue mode: each message is offered to the honest witness; where it refuses a second version (duplicity),
   * the rogue signs a receipt anyway and keeps it. This is the misbehavior a watcher must catch.
   */
  private async submitAnything(stream: string): Promise<SubmitResult> {
    const receipts: SignedMessage[] = [];
    for (const m of fromStream(stream).messages) {
      const r = await this.witness.submit(toStream([m]));
      if (r.ok) {
        receipts.push(...fromStream(r.receipts).messages);
        continue;
      }
      if (r.refusal === "duplicity" && (m.t === "tin" || m.t === "ten" || m.t === "tcl")) {
        const rc = await makeReceipt(m, this.signer, { dt: this.clock.iso() });
        const text = toStream([rc]);
        await this.store.addReceipt(m.logId, m.s, m.d, { by: this.aid, kind: "witness", raw: rc.raw, attachments: text.slice(rc.raw.length), dt: String(rc.body.dt) });
        receipts.push(rc);
        continue;
      }
      return { ...r, receipts: toStream(receipts) };
    }
    return { ok: true, receipts: toStream(receipts) };
  }

  async close(): Promise<void> {
    await this.server?.close();
    this.server = undefined;
    (this.store as { close?: () => void }).close?.();
  }
}
