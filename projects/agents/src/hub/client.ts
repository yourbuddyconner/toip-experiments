/** The hub's HTTP API, as agents, workers and consoles use it. Browser-safe. Everything on the hub is signed by its subject. */
import { signDocument, verifyDocument, type Clock, type Credential, type Identity, type StatusListDoc } from "@toip-tools/trust-core";

/** A worker's signed card in the hub's directory (design §5). */
export interface WorkerProfile {
  type: "agents/worker-profile";
  issuer: string;
  name: string;
  kind: "human" | "agent";
  skills: string[];
  rate?: string;
  /** An agent's USDC wallet (token account), so a delegator can fund it. */
  wallet?: string;
  /** Who runs it, for agents. */
  operator?: string;
  /** Credentials about the worker, such as Settle Verify's VerifiedBusiness. Checked by whoever reads the card. */
  credentials?: Credential[];
  at: string;
  proof?: unknown;
}

export function signProfile(identity: Identity, clock: Clock, p: Omit<WorkerProfile, "type" | "issuer" | "at" | "proof">): WorkerProfile {
  return signDocument({ type: "agents/worker-profile" as const, issuer: identity.did, ...p, at: clock.iso() }, identity, clock);
}

export async function verifyProfile(p: WorkerProfile, clock: Clock): Promise<boolean> {
  if (p?.type !== "agents/worker-profile" || typeof p.issuer !== "string" || typeof p.name !== "string" || !Array.isArray(p.skills)) return false;
  return (await verifyDocument(p, clock).catch(() => ({ valid: false }))).valid;
}

export interface HubPort {
  workers(): Promise<WorkerProfile[]>;
  putStatus(list: StatusListDoc): Promise<void>;
}

export class HubClient implements HubPort {
  constructor(
    readonly base: string,
    private readonly f: typeof fetch = (...a) => fetch(...a),
  ) {}

  get statusBase(): string {
    return `${this.base}/api/status`;
  }
  get witnessUrl(): string {
    return `${this.base}/witness`;
  }

  async workers(): Promise<WorkerProfile[]> {
    return (await this.get<{ workers: WorkerProfile[] }>("/api/workers")).workers;
  }
  async putWorker(profile: WorkerProfile): Promise<void> {
    await this.send("POST", "/api/workers", { profile });
  }
  async putStatus(list: StatusListDoc): Promise<void> {
    await this.send("PUT", "/api/status", { list });
  }
  async status(did: string): Promise<StatusListDoc | null> {
    const r = await this.f(`${this.base}/api/status/${encodeURIComponent(did)}`);
    return r.ok ? ((await r.json()) as StatusListDoc) : null;
  }
  async putPassport(passport: Credential): Promise<void> {
    await this.send("POST", "/api/passports", { passport });
  }
  async passport(did: string): Promise<Credential | null> {
    const r = await this.f(`${this.base}/api/passports/${encodeURIComponent(did)}`);
    return r.ok ? ((await r.json()) as Credential) : null;
  }
  async witnessInfo(): Promise<{ aid: string; did: string }> {
    return this.get("/witness/info");
  }

  private async get<T>(path: string): Promise<T> {
    const r = await this.f(this.base + path);
    if (!r.ok) throw new Error(`hub: ${r.status} from ${path}`);
    return (await r.json()) as T;
  }
  private async send(method: string, path: string, body: unknown): Promise<void> {
    const r = await this.f(this.base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`hub: ${r.status} from ${path}: ${await r.text()}`);
  }
}
