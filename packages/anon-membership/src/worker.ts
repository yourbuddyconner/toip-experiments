// Proving in a Web Worker, so the page stays responsive.
//
//   // prover.worker.ts
//   import { serveMembershipWorker } from "@toip-tools/anon-membership/worker";
//   serveMembershipWorker();
//
//   // the page
//   const client = new MembershipWorkerClient(new Worker(new URL("./prover.worker.ts", import.meta.url), { type: "module" }));
//   const proof = await client.prove(statement, witness, (p) => show(p));
//
// Statements and witnesses hold bigints, which structured cloning carries as they are.
import { initHashing } from "./hash.js";
import { MembershipError, MembershipProver, MembershipVerifier, type BackendOptions, type MembershipProof, type ProveProgress, type VerifyResult } from "./prove.js";
import type { Statement, Witness } from "./statement.js";

type Request =
  | { id: number; op: "warm"; options?: BackendOptions }
  | { id: number; op: "prove"; statement: Statement; witness: Witness }
  | { id: number; op: "verify"; proof: unknown; expected?: Statement }
  | { id: number; op: "destroy" };

type Reply =
  | { id: number; progress: ProveProgress }
  | { id: number; result: unknown }
  | { id: number; error: { name: string; message: string } };

interface Port {
  postMessage(m: unknown): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
}

/** Call once at the top of a worker script. Answers MembershipWorkerClient's requests. */
export function serveMembershipWorker(port: Port = globalThis as unknown as Port): void {
  let options: BackendOptions = {};
  let prover: Promise<MembershipProver> | undefined;
  let verifier: Promise<MembershipVerifier> | undefined;
  const getProver = () => (prover ??= initHashing().then(() => MembershipProver.create(options)));
  const getVerifier = () => (verifier ??= MembershipVerifier.create(options));

  port.addEventListener("message", async (e) => {
    const req = e.data as Request;
    const reply = (r: Reply) => port.postMessage(r);
    try {
      switch (req.op) {
        case "warm":
          options = req.options ?? {};
          await getProver();
          return reply({ id: req.id, result: true });
        case "prove": {
          const p = await getProver();
          const proof = await p.prove(req.statement, req.witness, (progress) => reply({ id: req.id, progress }));
          return reply({ id: req.id, result: proof });
        }
        case "verify":
          return reply({ id: req.id, result: await (await getVerifier()).verify(req.proof, req.expected) });
        case "destroy":
          await Promise.all([prover && (await prover).destroy(), verifier && (await verifier).destroy()]);
          prover = verifier = undefined;
          return reply({ id: req.id, result: true });
      }
    } catch (err) {
      const x = err instanceof Error ? err : new Error(String(err));
      reply({ id: req.id, error: { name: x.name, message: x.message } });
    }
  });
}

interface WorkerLike extends Port {
  terminate?(): void;
}

/** The page's side of a worker running serveMembershipWorker. */
export class MembershipWorkerClient {
  private next = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; progress?: (p: ProveProgress) => void }>();

  constructor(private readonly worker: WorkerLike) {
    worker.addEventListener("message", (e) => {
      const r = e.data as Reply;
      const p = this.pending.get(r.id);
      if (!p) return;
      if ("progress" in r) return p.progress?.(r.progress);
      this.pending.delete(r.id);
      if ("error" in r) {
        const err = r.error.name === "MembershipError" ? new MembershipError(r.error.message) : new Error(r.error.message);
        p.reject(err);
      } else p.resolve(r.result);
    });
  }

  private call<T>(msg: Record<string, unknown>, progress?: (p: ProveProgress) => void): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, progress });
      this.worker.postMessage({ ...msg, id });
    });
  }

  /** Loads the prover in the worker ahead of time. */
  warm(options?: BackendOptions): Promise<void> {
    return this.call({ op: "warm", options });
  }

  prove(statement: Statement, witness: Witness, onProgress?: (p: ProveProgress) => void): Promise<MembershipProof> {
    return this.call({ op: "prove", statement, witness }, onProgress);
  }

  verify(proof: unknown, expected?: Statement): Promise<VerifyResult> {
    return this.call({ op: "verify", proof, expected });
  }

  /** Frees the worker's prover and verifier, then ends the worker. */
  async destroy(): Promise<void> {
    await this.call({ op: "destroy" });
    this.worker.terminate?.();
  }
}
