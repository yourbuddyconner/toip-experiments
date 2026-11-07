/**
 * The web app's services: the platform's config, a clock that follows the host's dev clock, one Web
 * Worker that proves and verifies, a reader anyone can use, and the signed-in account.
 */
import { MembershipWorkerClient } from "@zk-toip/anon-membership/worker";
import { initHashing, type ProveProgress } from "@zk-toip/anon-membership";
import { Endpoint, RelayTransport, identityFromSeed, type Clock } from "@zk-toip/trust-core";
import { createVault, type Unlocked } from "@zk-toip/web-vault";
import { AgoraClient, type WalletState } from "../../src/client/client";
import { HostApi, RegistrarApi } from "../../src/client/http";
import { ForumReader, type KeyValue } from "../../src/client/reader";
import type { IssuerInfo } from "../../src/issuers/issuers";

export interface AppConfig {
  hostUrl: string;
  registrarUrl: string;
  relayUrl: string;
  host: { did: string; aid: string };
  issuers: IssuerInfo[];
}

export const vault = createVault({ prefix: "agora", rpName: "Agora" });

/** Follows the host's clock, which the dev clock can move. */
export class HostClock implements Clock {
  offset = 0;
  now() {
    return Date.now() + this.offset;
  }
  iso() {
    return new Date(this.now()).toISOString();
  }
  date() {
    return new Date(this.now());
  }
}

const localKv: KeyValue = {
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
};

export interface Services {
  config: AppConfig;
  clock: HostClock;
  host: HostApi;
  registrar: RegistrarApi;
  worker: MembershipWorkerClient;
  reader: ForumReader;
  warm(): Promise<void>;
  syncClock(): Promise<void>;
}

let services: Promise<Services> | undefined;

export function loadServices(): Promise<Services> {
  return (services ??= (async () => {
    await initHashing();
    const config = (await (await fetch("/config.json")).json()) as AppConfig;
    const clock = new HostClock();
    const host = new HostApi(config.hostUrl);
    const registrar = new RegistrarApi(config.registrarUrl);
    const worker = new MembershipWorkerClient(new Worker(new URL("./prover.worker.ts", import.meta.url), { type: "module" }));
    const syncClock = async () => {
      const t0 = Date.now();
      const { now } = await host.time();
      clock.offset = now - Math.round((t0 + Date.now()) / 2);
    };
    await syncClock();
    let warmed: Promise<void> | undefined;
    return {
      config,
      clock,
      host,
      registrar,
      worker,
      reader: new ForumReader(host, registrar, worker, clock, localKv),
      warm: () => (warmed ??= worker.warm()),
      syncClock,
    };
  })());
}

/** A signed-in account in this tab: its client, over the relay for TSP. */
export class Session {
  private constructor(
    readonly unlocked: Unlocked,
    readonly client: AgoraClient,
    private readonly transport: RelayTransport,
  ) {}

  get name() {
    return this.unlocked.account.name;
  }

  static async open(u: Unlocked, s: Services): Promise<Session> {
    const identity = identityFromSeed(u.seed);
    const transport = new RelayTransport({ url: s.config.relayUrl, identity });
    transport.start();
    const endpoint = new Endpoint({ identity, transport, clock: s.clock, timeoutMs: 20_000 });
    const client = await AgoraClient.open({
      seed: u.seed,
      clock: s.clock,
      host: s.host,
      registrar: s.registrar,
      prover: s.worker,
      endpoint,
      wallet: {
        load: () => vault.readJson<WalletState>(u, "wallet"),
        save: (w) => vault.writeJson(u, "wallet", w),
      },
    });
    return new Session(u, client, transport);
  }

  close() {
    this.transport.stop();
  }
}

export type { ProveProgress };
