import { SystemClock, type Clock } from "@zk-toip/trust-core";
import { witnessHttpHandler } from "../http";
import { ed25519Signer } from "../keys";
import { Witness } from "../witness";
import { JsonFileStore } from "./fileStore";
import { serveHttp } from "./http";

export { JsonFileStore } from "./fileStore";
export { serveHttp } from "./http";

/** Starts a witness as a Node HTTP service, keeping its logs in a JSON file. For development and demos. */
export async function startWitness(opts: { seed: Uint8Array; dataPath: string; port?: number; host?: string; clock?: Clock }) {
  const store = new JsonFileStore(opts.dataPath);
  const witness = new Witness({ signer: ed25519Signer(opts.seed), store, clock: opts.clock ?? new SystemClock() });
  const server = await serveHttp(witnessHttpHandler(witness), { port: opts.port ?? 0, host: opts.host });
  return {
    witness,
    url: server.url,
    aid: witness.aid,
    did: witness.did,
    close: async () => {
      await server.close();
      store.close();
    },
  };
}
