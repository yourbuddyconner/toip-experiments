/**
 * What a platform keeps between runs, in its data directory: its identities and keys, the people in its
 * directory, its operators, and what its processor and arbiter know. The local chain and the relay keep
 * their own files alongside.
 *
 *   platform.json   identities, keys, network id, operators (secret: readable by this user only)
 *   directory.json  display names and who Settle Verify vouched for
 *   agents.json     the processor's escrows, signatures and log; the arbiter's cases
 *   chain.bin       the local cluster (LiteSVM), with chain.bin.json for its clock
 *   relay.db        messages waiting for parties that are offline
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromB64u, identityFromSeed, toB64u, type Identity } from "@toip-tools/trust-core";
import { createKeyPairSignerFromPrivateKeyBytes, type KeyPairSigner } from "@solana/kit";

export interface PlatformSecrets {
  v: 1;
  /** Browsers keep payments per network: the same id means the same chain and the same parties. */
  networkId: string;
  /** The RPC endpoint and program these keys were set up on, so a data directory is never used against another chain. */
  cluster: { rpcUrl: string; programId: string };
  seeds: Record<"processor" | "arbiter" | "verifier", string>;
  /** Solana keys, as 32-byte seeds: the treasury (pays for setup and gas, owns the test-USDC mint), the processor's keys, the mint. */
  keys: Record<"treasury" | "feePayer" | "feeOwner" | "feeAccount" | "mint", string>;
  operators: string[];
}

export class DataDir {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  read<T>(name: string): T | undefined {
    const f = this.path(name);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : undefined;
  }

  /** Writes atomically, so a crash mid-write never leaves half a file. */
  write(name: string, value: unknown, secret = false): void {
    this.writeText(name, JSON.stringify(value, null, 1), secret);
  }

  writeText(name: string, text: string, secret = false): void {
    const f = this.path(name);
    writeFileSync(`${f}.tmp`, text, { mode: secret ? 0o600 : 0o644 });
    renameSync(`${f}.tmp`, f);
    if (secret) chmodSync(f, 0o600);
  }

  /** The platform's secrets, created on first use for this cluster. */
  secrets(cluster: PlatformSecrets["cluster"]): PlatformSecrets {
    const existing = this.read<PlatformSecrets>("platform.json");
    if (existing) {
      if (existing.v !== 1) throw new Error(`${this.path("platform.json")} is from another version of Settle`);
      if (existing.cluster.rpcUrl !== cluster.rpcUrl || existing.cluster.programId !== cluster.programId) {
        throw new Error(`${this.dir} belongs to ${existing.cluster.rpcUrl} (program ${existing.cluster.programId}), not ${cluster.rpcUrl}: use another data directory`);
      }
      return existing;
    }
    const seed = () => toB64u(crypto.getRandomValues(new Uint8Array(32)));
    const s: PlatformSecrets = {
      v: 1,
      networkId: crypto.randomUUID(),
      cluster,
      seeds: { processor: seed(), arbiter: seed(), verifier: seed() },
      keys: { treasury: seed(), feePayer: seed(), feeOwner: seed(), feeAccount: seed(), mint: seed() },
      operators: [],
    };
    this.write("platform.json", s, true);
    return s;
  }

  saveSecrets(s: PlatformSecrets): void {
    this.write("platform.json", s, true);
  }
}

export const identityOf = (seed: string): Identity => identityFromSeed(fromB64u(seed));
export const signerOf = (seed: string): Promise<KeyPairSigner> => createKeyPairSignerFromPrivateKeyBytes(fromB64u(seed));

/** Calls `save` when what `snapshot` returns has changed, at most every `ms`, and once more on `flush`. */
export function autosave(snapshot: () => unknown, save: (json: string) => void, ms = 1000): { flush(): void; stop(): void } {
  let last = "";
  const tick = () => {
    const json = JSON.stringify(snapshot());
    if (json !== last) {
      save(json);
      last = json;
    }
  };
  const timer = setInterval(tick, ms);
  timer.unref();
  return {
    flush: tick,
    stop: () => {
      clearInterval(timer);
      tick();
    },
  };
}
