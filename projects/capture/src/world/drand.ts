/**
 * Where the world gets drand beacons. "live" polls the public quicknet chain and caches every round it
 * sees; "dev" signs rounds with a local key (same scheme), for tests and offline demos. "live" falls back
 * to "dev" when the network is down at start.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { devChain, fromHex, hex, QUICKNET, randomnessOf, roundAt, type DrandChain } from "../core";

export interface BeaconRound {
  kind: DrandChain["kind"];
  round: number;
  randomness: Uint8Array;
  signature: Uint8Array;
}

export interface DrandService {
  chain: DrandChain;
  mode: "live" | "dev";
  latest(): BeaconRound | null;
  round(round: number): Promise<BeaconRound | null>;
  stop(): void;
}

export async function startDrand(opts: { mode: "live" | "dev"; devKey: Uint8Array; cachePath?: string; now?: () => number; log?: (s: string) => void; fetch?: typeof fetch }): Promise<DrandService> {
  const now = opts.now ?? Date.now;
  const f = opts.fetch ?? fetch;
  if (opts.mode === "live") {
    const base = `https://api.drand.sh/${QUICKNET.hash}/public`;
    const cache = new Map<number, BeaconRound>();
    if (opts.cachePath && existsSync(opts.cachePath)) {
      for (const [r, sig] of Object.entries(JSON.parse(readFileSync(opts.cachePath, "utf8")) as Record<string, string>)) {
        const signature = fromHex(sig);
        cache.set(Number(r), { kind: "drand-quicknet", round: Number(r), signature, randomness: randomnessOf(signature) });
      }
    }
    let latest: BeaconRound | null = null;
    const get = async (path: string): Promise<BeaconRound | null> => {
      try {
        const res = await f(`${base}/${path}`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return null;
        const j = (await res.json()) as { round: number; signature: string };
        const signature = fromHex(j.signature);
        const r: BeaconRound = { kind: "drand-quicknet", round: j.round, signature, randomness: randomnessOf(signature) };
        cache.set(r.round, r);
        return r;
      } catch {
        return null;
      }
    };
    latest = await get("latest");
    if (latest) {
      let saved = 0;
      const persist = () => {
        if (!opts.cachePath || cache.size === saved) return;
        const recent = [...cache.values()].sort((a, b) => b.round - a.round).slice(0, 5000);
        writeFileSync(opts.cachePath, JSON.stringify(Object.fromEntries(recent.map((r) => [r.round, hex(r.signature)]))));
        saved = cache.size;
      };
      const timer = setInterval(async () => {
        const r = await get("latest");
        if (r && (!latest || r.round > latest.round)) latest = r;
        persist();
      }, 3000);
      timer.unref?.();
      opts.log?.(`drand: live quicknet, round ${latest.round}`);
      return {
        chain: QUICKNET,
        mode: "live",
        latest: () => latest,
        round: async (n) => cache.get(n) ?? (await get(String(n))),
        stop: () => {
          clearInterval(timer);
          persist();
        },
      };
    }
    opts.log?.("drand: api.drand.sh is unreachable; using a local development beacon instead");
  }
  // dev chain: genesis fixed by the key, so rounds stay valid across restarts
  const genesis = 1_790_000_000;
  const dev = devChain(opts.devKey, genesis, 3);
  const signed = new Map<number, BeaconRound>();
  const sign = (round: number): BeaconRound => {
    const hit = signed.get(round);
    if (hit) return hit;
    const r = dev.sign(round);
    const out: BeaconRound = { kind: "drand-dev", round, signature: r.signature, randomness: r.randomness };
    signed.set(round, out);
    if (signed.size > 20_000) signed.delete(signed.keys().next().value!);
    return out;
  };
  return {
    chain: dev.chain,
    mode: "dev",
    latest: () => sign(roundAt(dev.chain, now())),
    // never sign a round from the future: that would break "not before"
    round: async (n) => (n <= roundAt(dev.chain, now()) ? sign(n) : null),
    stop: () => {},
  };
}
