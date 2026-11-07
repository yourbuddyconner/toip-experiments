/** The verifier's one door to the network: the capture server's registry, key logs, status lists and beacons. Nothing it returns is trusted. */
import type { StatusListDoc } from "@zk-toip/trust-core";
import { fromHex, hex } from "./bytes";
import type { Fetcher } from "./verify";

export function httpFetcher(base: string, f: typeof fetch = (...a) => fetch(...a)): Fetcher {
  const root = base.replace(/\/$/, "");
  const bytes = async (path: string): Promise<Uint8Array | null> => {
    const r = await f(`${root}${path}`);
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  };
  return {
    storeByHash: (h) => bytes(`/api/stores/by-hash/${hex(h)}`),
    manifest: (id) => bytes(`/api/manifests/${encodeURIComponent(id)}`),
    keyLog: (did) => bytes(`/api/keylogs/${encodeURIComponent(did)}`),
    statusList: async (issuer) => {
      const r = await f(`${root}/api/status/${encodeURIComponent(issuer)}`);
      return r.ok ? ((await r.json()) as StatusListDoc) : null;
    },
    drandRound: async (kind, round) => {
      const r = await f(`${root}/api/drand/${kind}/${round}`);
      return r.ok ? fromHex(((await r.json()) as { signature: string }).signature) : null;
    },
  };
}
