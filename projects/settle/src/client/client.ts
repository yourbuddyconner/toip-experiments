/**
 * Connecting a party to a Settle network: the few lines an app needs (design §17). Browser-safe.
 *
 *   const settle = new SettleApi("http://127.0.0.1:4300");
 *   const party = await settle.party({ identity, name: "Joe's Plumbing", policy });
 *   await party.start();
 *   await settle.addFunds(party, 500_000_000n);
 *   const link = await party.createLink({ title: "Fix the sink", units: 120_000_000n, release: "payer-confirms" });
 */
import { signDocument, SystemClock, type Clock, type Credential, type Identity, type OutboxStore } from "@zk-toip/trust-core";
import { Chain } from "../chain/chain";
import type { SettlePolicy } from "../protocol/policy";
import { Party, type PartySnapshot } from "../agents/party";
import type { Directory } from "../agents/base";
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

  constructor(readonly base = "") {}

  config(): Promise<PlatformConfig> {
    return (this.cfg ??= this.get<PlatformConfig>("/api/config"));
  }

  /** A party on this network, configured as a person's own device would be: it signs for itself, checks everything, and acts on its own. */
  async party(o: { identity: Identity; name: string; policy: SettlePolicy; clock?: Clock; outbox?: OutboxStore; onChange?: () => void; snapshot?: PartySnapshot }): Promise<Party> {
    const config = await this.config();
    const chain = await Chain.connect(config.rpcUrl, config.programId);
    const directory: Directory = {
      names: { ...config.names },
      processor: config.processor.did,
      processorFeeAccount: config.processor.feeAccount,
      arbiter: config.arbiter,
      licensingBoard: config.verifier,
      mint: config.mint,
      fee: config.processor.fee,
    };
    const party = new Party({ name: o.name, identity: o.identity, relayUrl: config.relayUrl, clock: o.clock ?? new SystemClock(), chain, policy: o.policy, directory, outbox: o.outbox, onChange: o.onChange });
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
    const res = await fetch(this.base + path, init);
    const out = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(out.error ?? `${res.status} from ${path}`);
    return out;
  }
}
