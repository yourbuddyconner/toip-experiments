// A whole Tipline world in one Node process, for the integration tests and the terminal demo: a real relay, Acme's issuer
// serving enroll over TSP, the outlet's mirror, Sam's inbox, members' wallets, and sources. Logs and
// snapshots are served from memory through a Fetcher, as the platform serves them over HTTP.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MembershipProver, MembershipVerifier, epochOf, initHashing, loadArtifacts, CIRCUIT_ID } from "@zk-toip/anon-membership";
import { startRelay, type Relay, type StoredMessage } from "@zk-toip/relay";
import { DemoClock, Endpoint, RelayTransport, identityFromSeed, seedFrom, toB64u, type Identity } from "@zk-toip/trust-core";
import { OrgIssuer } from "./agents/issuer";
import { InboxAgent, type InboxState } from "./agents/inbox";
import { Mirror } from "./agents/mirror";
import type { Fetcher } from "./agents/logs";
import { enrollWallet } from "./agents/wallet";
import { signDescriptor, DEFAULT_LIMITS, type Descriptor } from "./protocol/descriptor";
import { FRESHNESS } from "./protocol/messages";

export const ACME_URL = "https://acme.example/";
export const OUTLET_URL = "https://ledger.example/";
export const STORY = "acme-valve-failures";
export const OTHER_STORY = "acme-pensions";

export const until = async (cond: () => boolean | Promise<boolean>, ms = 15_000, what = "condition") => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

export interface World {
  clock: DemoClock;
  relay: Relay;
  relayDb: string;
  stored: StoredMessage[];
  acme: OrgIssuer;
  acmeEndpoint: Endpoint;
  mirror: Mirror;
  fetcher: Fetcher;
  /** Requests the fetcher served, for checking who contacted whom. */
  requests: string[];
  sam: Identity;
  descriptor: Descriptor;
  prover: MembershipProver;
  verifier: MembershipVerifier;
  transports: RelayTransport[];
  startInbox(state?: InboxState): InboxAgent;
  wallet(name: string): Promise<{ identity: Identity; seed: Uint8Array; endpoint: Endpoint }>;
  /** Skips ahead whole days; Acme publishes a root for each, and the mirror refreshes. */
  skipDays(n: number): Promise<void>;
  close(): Promise<void>;
}

export async function makeWorld(): Promise<World> {
  await initHashing();
  const clock = new DemoClock("2026-11-06T09:30:00Z");
  const relayDb = join(mkdtempSync(join(tmpdir(), "tipline-relay-")), "relay.db");
  const stored: StoredMessage[] = [];
  const relay = await startRelay({ port: 0, host: "127.0.0.1", dbPath: relayDb, onStored: (m) => void stored.push(m) });
  const transports: RelayTransport[] = [];
  const connect = async (identity: Identity) => {
    const t = new RelayTransport({ url: relay.url, identity });
    transports.push(t);
    t.start();
    await until(() => t.status === "connected", 10_000, "relay connection");
    return t;
  };

  const acmeId = identityFromSeed(seedFrom("tipline-test/acme"));
  const acme = new OrgIssuer({ identity: acmeId, clock, org: "Acme Chemicals", name: "employees" });
  const acmeEndpoint = new Endpoint({ identity: acmeId, transport: await connect(acmeId), clock, timeoutMs: 15_000 });
  acme.serve(acmeEndpoint);

  const requests: string[] = [];
  let mirror: Mirror;
  const logUrl = `${ACME_URL}groups/employees/log.json`;
  const snapUrl = (e: string) => `${ACME_URL}groups/employees/snapshot/${e}.bin`;
  const mirrorBase = `${OUTLET_URL}dropbox/ledger-sam/mirror/acme-employees/`;
  const fetcher: Fetcher = {
    async json(url) {
      requests.push(url);
      if (url === logUrl) return structuredClone(acme.log());
      if (url === `${mirrorBase}log.json`) return structuredClone(mirror.serveLog());
      throw new Error(`${url}: HTTP 404`);
    },
    async bytes(url) {
      requests.push(url);
      let m = /snapshot\/(.+)\.bin$/.exec(url);
      if (m && url.startsWith(ACME_URL)) {
        const s = acme.group.snapshot(m[1]);
        if (s) return s;
      }
      m = /snapshot\/(.+)\.bin$/.exec(url);
      if (m && url.startsWith(mirrorBase)) {
        const s = mirror.serveSnapshot(m[1]);
        if (s) return s;
      }
      throw new Error(`${url}: HTTP 404`);
    },
  };
  // The mirror fetches from Acme through a fetcher of its own, so its requests aren't counted as the source's.
  mirror = new Mirror({
    issuer: acmeId.did,
    logUrl,
    snapshotUrl: snapUrl,
    clock,
    fetcher: { json: async () => structuredClone(acme.log()), bytes: async (u) => acme.group.snapshot(/snapshot\/(.+)\.bin$/.exec(u)![1])! },
  });

  const sam = identityFromSeed(seedFrom("tipline-test/sam-dropbox"));
  const artifacts = await loadArtifacts();
  const group = {
    group: acme.groupId,
    issuer: acmeId.did,
    label: "Acme Chemicals employees",
    log: logUrl,
    mirror: "/dropbox/ledger-sam/mirror/acme-employees/",
    minSize: 50,
    maxEpochAge: 3,
  };
  const descriptor = signDescriptor(
    {
      slug: "ledger-sam",
      outlet: "The Ledger",
      journalist: { name: "Sam Ortiz" },
      relay: relay.url,
      circuits: [{ id: CIRCUIT_ID, vkHash: artifacts.vkHash }],
      stories: [
        { id: STORY, title: "Valve failures at Acme's Riverside plant", opens: "2026-11-06", groups: [group] },
        { id: OTHER_STORY, title: "Acme's pension fund", opens: "2026-11-06", groups: [group] },
      ],
      limits: DEFAULT_LIMITS,
    },
    sam,
    clock,
  );
  const prover = await MembershipProver.create();
  const verifier = await MembershipVerifier.create();

  return {
    clock,
    relay,
    relayDb,
    stored,
    acme,
    acmeEndpoint,
    get mirror() {
      return mirror;
    },
    fetcher,
    requests,
    sam,
    descriptor,
    prover,
    verifier,
    transports,
    startInbox(state) {
      const t = new RelayTransport({ url: relay.url, identity: sam });
      transports.push(t);
      const inbox = new InboxAgent({ identity: sam, transport: t, clock, verifier, fetcher, outletUrl: OUTLET_URL, state });
      if (!state?.descriptor) inbox.setDescriptor(descriptor);
      t.start();
      return inbox;
    },
    async wallet(name) {
      const seed = seedFrom(`tipline-test/wallet/${name}`);
      const identity = identityFromSeed(seedFrom(`tipline-test/employee/${name}`));
      const endpoint = new Endpoint({ identity, transport: await connect(identity), clock, timeoutMs: 15_000, freshness: FRESHNESS });
      return { identity, seed, endpoint };
    },
    async skipDays(n) {
      for (let i = 0; i < n; i++) {
        clock.advance(86_400_000);
        acme.publishIfDue();
      }
      await mirror.refresh();
    },
    async close() {
      for (const t of transports) t.stop();
      await prover.destroy();
      await verifier.destroy();
      await relay.close();
    },
  } as World;
}

export { enrollWallet, epochOf, toB64u };
