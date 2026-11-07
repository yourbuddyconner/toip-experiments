/**
 * Agora's services in one process: three demo issuers (each running its own group), the registrars'
 * public reads, and the forum host. TSP goes over the relay (the platform) or an in-memory bus (tests).
 * The platform adds the relay and the web app around this.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MembershipVerifier, commitmentOf, deriveSecret, initHashing } from "@zk-toip/anon-membership";
import { MemoryStore, type LogStore } from "@zk-toip/eventlog";
import { Bus, Endpoint, RelayTransport, identityFromSeed, seedFrom, toB64u, fromB64u, type Transport } from "@zk-toip/trust-core";
import { ForumHost, type GroupSource } from "../host/host";
import { serveHost, type HostServer } from "../host/server";
import { SqliteLogStore } from "../host/sqliteStore";
import { DemoIssuer, ISSUER_KINDS, type IssuerState } from "../issuers/issuers";
import { serveRegistrars } from "../registrar/server";
import type { AdvanceableClock } from "./net";

/** Simulated members per group, so anonymity sets look like a real group's (design §12.3 step 2). */
const SIMULATED: Record<string, (i: number) => Record<string, string>> = {
  cascade: (i) => ({ licenseType: i % 7 === 6 ? "LPN" : "RN", state: "WA", licensedSince: `${2010 + (i % 14)}-0${1 + (i % 9)}-15` }),
  pine: (i) => ({ licenseType: i % 10 === 9 ? "LPN" : "RN", state: "OR", licensedSince: `${2008 + (i % 16)}-0${1 + (i % 9)}-01` }),
  riverton: (i) => ({ district: i % 3 === 2 ? String(1 + (i % 8)) : "7", residentSince: `${2012 + (i % 12)}-0${1 + (i % 9)}-10` }),
};

export interface WorldOptions {
  clock: AdvanceableClock;
  /** "bus" for tests; a relay URL for the platform. */
  tsp: { bus: Bus } | { relayUrl: string };
  dataDir?: string;
  hostPort?: number;
  registrarPort?: number;
  hostname?: string;
  devClock?: boolean;
  /** Simulated members to seed each group with on first start. Default 40. */
  simulated?: number;
  rootCadenceSeconds?: number;
  /** How often the registrars poll status lists and publish due roots, in ms. Default 10 s; 0 turns it off. */
  tickMs?: number;
  log?: (line: string) => void;
}

interface Secrets {
  issuers: Record<string, string>;
  host: string;
  hostRotation: string;
}

export interface World {
  clock: AdvanceableClock;
  issuers: DemoIssuer[];
  byKey: Record<"cascade" | "pine" | "riverton", DemoIssuer>;
  host: ForumHost;
  hostServer: HostServer;
  registrarServer: { url: string; port: number; close(): Promise<void> };
  verifier: MembershipVerifier;
  endpoints: Endpoint[];
  store: LogStore;
  /** Polls status lists and publishes any due roots. */
  tick(): Promise<void>;
  close(): Promise<void>;
}

function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

export async function startWorld(o: WorldOptions): Promise<World> {
  await initHashing();
  const log = o.log ?? (() => {});
  const dir = o.dataDir;
  if (dir) mkdirSync(dir, { recursive: true });
  const rnd = () => toB64u(crypto.getRandomValues(new Uint8Array(32)));
  let secrets = dir ? readJson<Secrets>(join(dir, "secrets.json")) : undefined;
  if (!secrets) {
    secrets = { issuers: Object.fromEntries(ISSUER_KINDS.map((k) => [k.key, rnd()])), host: rnd(), hostRotation: rnd() };
    if (dir) writeJson(join(dir, "secrets.json"), secrets);
  }
  const savedIssuers = dir ? readJson<Record<string, IssuerState>>(join(dir, "issuers.json")) : undefined;

  // The registrars' public reads come first: issuers name their status-list URL in credentials.
  const issuers: DemoIssuer[] = [];
  const registrarServer = await serveRegistrars(issuers, { port: o.registrarPort ?? 0, hostname: o.hostname, log });
  for (const kind of ISSUER_KINDS) {
    const identity = identityFromSeed(fromB64u(secrets.issuers[kind.key]));
    const issuer = new DemoIssuer(kind, identity, o.clock, {
      statusUrl: `${registrarServer.url}/status/${encodeURIComponent(identity.did)}`,
      rootCadenceSeconds: o.rootCadenceSeconds,
      state: savedIssuers?.[kind.key],
    });
    issuer.log = log;
    issuer.registrar.log = log;
    issuers.push(issuer);
  }
  // serveRegistrars keeps the array it was given; it now holds the issuers.
  const byKey = Object.fromEntries(issuers.map((i) => [i.kind.key, i])) as World["byKey"];

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const saveNow = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
    if (dir) writeJson(join(dir, "issuers.json"), Object.fromEntries(issuers.map((i) => [i.kind.key, i.state()])));
  };
  const save = () => {
    if (!dir || saveTimer) return;
    saveTimer = setTimeout(saveNow, 200);
  };
  for (const i of issuers) i.onChange = save;

  // Seed each group with simulated members the first time: real did:keys, credentials and leaves.
  if (!savedIssuers) {
    const n = o.simulated ?? 40;
    for (const i of issuers) {
      const quiet = i.log;
      i.log = undefined;
      i.registrar.log = undefined;
      for (let k = 0; k < n; k++) {
        const seed = seedFrom(`agora/simulated/${i.kind.key}/${k}/${secrets.issuers[i.kind.key]}`);
        const member = identityFromSeed(seed);
        const vc = i.issue(member.did, SIMULATED[i.kind.key](k));
        await i.registrar.admitDirect(member.did, vc, commitmentOf(deriveSecret(seed, "agora/v1/identity-secret"), i.registrar.group.groupField));
      }
      i.log = quiet;
      i.registrar.log = quiet;
      log(`${i.kind.title}: seeded ${n} simulated members`);
    }
  }

  // TSP endpoints: each issuer answers credential requests and its registrar's tasks.
  const endpoints: Endpoint[] = [];
  const relays: RelayTransport[] = [];
  for (const i of issuers) {
    let transport: Transport;
    if ("bus" in o.tsp) transport = o.tsp.bus;
    else {
      const rt = new RelayTransport({ url: o.tsp.relayUrl, identity: i.identity });
      rt.start();
      relays.push(rt);
      transport = rt;
    }
    const ep = new Endpoint({ identity: i.identity, transport, clock: o.clock, timeoutMs: 15_000 });
    i.serve(ep);
    endpoints.push(ep);
  }

  const tick = async () => {
    for (const i of issuers) {
      await i.registrar.pollStatus();
      i.registrar.tick();
    }
  };
  await tick();

  const groups: GroupSource = {
    descriptor: async (g) => issuers.find((i) => i.registrar.groupId === g)?.registrar.descriptor,
    log: async (g) => issuers.find((i) => i.registrar.groupId === g)?.registrar.roots() ?? [],
  };
  const store: LogStore = dir ? SqliteLogStore.open(join(dir, "host.db")) : new MemoryStore();
  const verifier = await MembershipVerifier.create();
  const hostIdentity = identityFromSeed(fromB64u(secrets.host));
  const host = await ForumHost.open({ identity: hostIdentity, rotationSeed: fromB64u(secrets.hostRotation), clock: o.clock, store, groups, verifier });
  const hostServer = await serveHost(host, { port: o.hostPort ?? 0, hostname: o.hostname, clock: o.clock, devClock: o.devClock, onAdvance: tick, log });

  const timer = o.tickMs === 0 ? undefined : setInterval(() => void tick().catch((e) => log(`tick failed: ${e}`)), o.tickMs ?? 10_000);
  timer?.unref?.();

  return {
    clock: o.clock,
    issuers,
    byKey,
    host,
    hostServer,
    registrarServer,
    verifier,
    endpoints,
    store,
    tick,
    close: async () => {
      if (timer) clearInterval(timer);
      saveNow();
      for (const e of endpoints) e.close();
      for (const r of relays) r.stop();
      await hostServer.close();
      await registrarServer.close();
      if (store instanceof SqliteLogStore) store.close();
      await verifier.destroy();
    },
  };
}
