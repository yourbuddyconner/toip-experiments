import { SystemClock, type Clock } from "@toip-tools/trust-core";
import { witnessHttpHandler } from "../http.js";
import { ed25519Signer } from "../keys.js";
import { Witness } from "../witness.js";
import { JsonFileStore } from "./fileStore.js";
import { serveHttp } from "./http.js";

export { JsonFileStore } from "./fileStore.js";
export { serveHttp } from "./http.js";

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
