/**
 * Connecting a party to a Settle network: the few lines an app needs (design §17). Browser-safe.
 *
 *   const settle = new SettleApi("http://127.0.0.1:4300");
 *   const party = await settle.party({ identity, name: "Joe's Plumbing", policy });
 *   await party.start();
 *   await settle.addFunds(party, 500_000_000n);
 *   const link = await party.createLink({ title: "Fix the sink", units: 120_000_000n, release: "payer-confirms" });
 */
import { signDocument, SystemClock, type Clock, type Credential, type Identity, type OutboxStore, type Traffic } from "@toip-tools/trust-core";
import { Chain } from "../chain/chain";
import type { SettlePolicy } from "../protocol/policy";
import { Party, type PartySnapshot } from "../agents/party";
import type { AgentEvent, Directory } from "../agents/base";
import type { PlatformConfig } from "../platform/platform";

export type { PlatformConfig };
export { encodeLink, decodeLink, verifyLink, type PaymentLink, type Party } from "../agents/party";

export interface Person {
  did: string;
  name: string;
  verified?: string;
}

export class SettleApi {
  private cfg?: Promise<PlatformConfig>;
  /** Outside a browser, the operator session cookie is kept here (a browser keeps it itself). */
  private cookie?: string;

  constructor(readonly base = "") {}

  config(): Promise<PlatformConfig> {
    return (this.cfg ??= this.get<PlatformConfig>("/api/config"));
  }

  /** A party on this network, configured as a person's own device would be: it signs for itself, checks everything, and acts on its own. */
  async party(o: {
    identity: Identity;
    name: string;
    policy: SettlePolicy;
    clock?: Clock;
    outbox?: OutboxStore;
    onChange?: () => void;
    snapshot?: PartySnapshot;
    /** Everything the party says, as it says it (S3). */
    onEvent?: (e: AgentEvent) => void;
    /** Every Trust Task it sends or receives (S3). */
    onTraffic?: (who: string, t: Traffic) => void;
  }): Promise<Party> {
    const config = await this.config();
    // A real cluster's clock only moves with the wall clock, so a reading is reused for a few seconds; a local one can jump.
    const chain = await Chain.connect(config.rpcUrl, config.programId, { clockCacheMs: config.devClock ? 0 : 3000 });
    const directory: Directory = {
      names: { ...config.names },
      processor: config.processor.did,
      processorFeeAccount: config.processor.feeAccount,
      arbiter: config.arbiter,
      licensingBoard: config.verifier,
      mint: config.mint,
      fee: config.processor.fee,
    };
    const party = new Party({
      name: o.name,
      identity: o.identity,
      relayUrl: config.relayUrl,
      clock: o.clock ?? new SystemClock(),
      chain,
      policy: o.policy,
      directory,
      outbox: o.outbox,
      onChange: o.onChange,
      onEvent: o.onEvent,
      onTraffic: o.onTraffic,
      // SOL for the party's own accounts comes from the platform's gas station, on any cluster.
      gas: async (address, lamports) => void (await this.post("/api/gas", { address, lamports: lamports.toString() })),
    });
    party.trustedLicensers = [config.verifier];
    party.requireLicense = false;
    party.autoRelease = true;
    party.setProcessorFeePayer(config.processor.feePayer);
    if (o.snapshot) await party.restore(o.snapshot);
    return party;
  }

  /** Puts a party's display name in the network's phone book, signed so nobody else can change it. */
  async register(party: Party): Promise<void> {
    const profile = signDocument({ type: "settle/profile" as const, issuer: party.did, name: party.name }, party.identity, party.clock);
    await this.post("/api/directory", { profile });
  }

  async people(): Promise<Person[]> {
    return (await this.get<{ people: Person[] }>("/api/directory")).people;
  }

  /** Test USDC into the party's wallet (development networks only). */
  async addFunds(party: Party, units: bigint): Promise<bigint> {
    const w = await party.openWallet();
    const r = await this.post<{ balance: string }>("/api/faucet", { tokenAccount: w.token, units: units.toString() });
    return BigInt(r.balance);
  }

  /** Asks Settle Verify to vouch for the party's business name, and keeps the credential it issues. */
  async verify(party: Party, businessName: string, category = ""): Promise<Credential> {
    const request = signDocument({ type: "settle/verify-request" as const, issuer: party.did, businessName, category }, party.identity, party.clock);
    const { credential } = await this.post<{ credential: Credential }>("/api/verify", { request });
    party.credentials.splice(0, party.credentials.length, ...party.credentials.filter((c) => !c.type.includes("VerifiedBusiness")), credential);
    return credential;
  }

  /**
   * Signs in as an operator of this platform by signing a one-time challenge with the identity's key.
   * With the setup code the platform printed, the identity becomes its first operator.
   */
  async operatorSignIn(identity: Identity, setupCode?: string): Promise<{ operator: string }> {
    const { nonce, audience } = await this.post<{ nonce: string; audience: string }>("/api/operator/challenge", {});
    const proof = signDocument({ type: "settle/operator-login" as const, issuer: identity.did, nonce, audience }, identity, new SystemClock());
    return this.post("/api/operator/login", setupCode === undefined ? { proof } : { proof, setupCode });
  }

  async operatorSignOut(): Promise<void> {
    await this.post("/api/operator/logout", {});
    this.cookie = undefined;
  }

  async now(): Promise<number> {
    return (await this.get<{ now: number }>("/api/time")).now;
  }

  /** Development only: moves the local chain's clock forward. */
  async advance(seconds: number): Promise<number> {
    return (await this.post<{ now: number }>("/api/dev/advance", { seconds })).now;
  }

  async get<T>(path: string): Promise<T> {
    return this.call<T>(path, { method: "GET" });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.call<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    const inBrowser = typeof document !== "undefined";
    if (!inBrowser && this.cookie) init.headers = { ...(init.headers as Record<string, string>), cookie: this.cookie };
    const res = await fetch(this.base + path, { ...init, credentials: "same-origin" });
    const set = !inBrowser ? res.headers.get("set-cookie") : null;
    if (set) this.cookie = set.split(";")[0];
    const out = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(out.error ?? `${res.status} from ${path}`);
    return out;
  }
}
