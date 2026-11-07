/**
 * The organization's side (design §5.1): an HR roster, the membership group (anon-membership's
 * GroupIssuer), daily signed roots, and the anon-membership/enroll task over TSP. In the demo the
 * organization is Acme Chemicals, the employer, which is also the adversary (design, decisions).
 *
 * It knows which employee DID owns which commitment. It never sees a member's secret.
 * `forkRoot` is the demo's cheat: a second signed root for today, built to single one member out.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  GroupIssuer,
  GroupTree,
  epochOf,
  fieldToHex,
  leafHash,
  memberSecret,
  commitmentOf,
  groupFieldOf,
  toField,
  type GroupIssuerState,
  type GroupRoot,
} from "@zk-toip/anon-membership";
import { identityFromSeed, signDocument, type Clock, type Endpoint, type Identity } from "@zk-toip/trust-core";

export interface Employee {
  did: string;
  name: string;
  /** "active", or "left" after HR removes them. */
  status: "active" | "left";
  added: string;
  /** Made by the seeding script, so the demo has a realistic group size. */
  seeded?: boolean;
}

export interface OrgIssuerState {
  v: 1;
  group: GroupIssuerState;
  roster: Employee[];
}

export interface MemberView extends Employee {
  index?: number;
  commitment?: string;
}

export class OrgIssuer {
  readonly group: GroupIssuer;
  readonly org: string;
  readonly identity: Identity;
  private readonly clock: Clock;
  private readonly roster = new Map<string, Employee>();

  constructor(opts: { identity: Identity; clock: Clock; org: string; name: string; state?: OrgIssuerState }) {
    this.identity = opts.identity;
    this.clock = opts.clock;
    this.org = opts.org;
    this.group = new GroupIssuer({ identity: opts.identity, clock: opts.clock, name: opts.name, state: opts.state?.group });
    for (const e of opts.state?.roster ?? []) this.roster.set(e.did, e);
  }

  get groupId(): string {
    return this.group.groupId;
  }

  addEmployee(name: string, did: string): Employee {
    if (!did.startsWith("did:key:z6Mk")) throw new Error("an employee's DID is an Ed25519 did:key");
    if (!name.trim()) throw new Error("give the employee's name");
    const e: Employee = { did, name: name.trim().slice(0, 80), status: "active", added: this.clock.iso() };
    this.roster.set(did, e);
    return e;
  }

  /** HR removes someone who left. Their leaf becomes 0 in the next root. */
  removeEmployee(did: string): void {
    const e = this.roster.get(did);
    if (!e) throw new Error("not on the roster");
    e.status = "left";
    if (this.group.member(did)) this.group.revoke(did);
  }

  /** Who may enroll: an active employee on the roster. */
  admits(did: string): boolean {
    return this.roster.get(did)?.status === "active";
  }

  /** Adds `n` employees who enroll from wallets this demo makes and then forgets. */
  seed(n: number, label = "Employee"): void {
    const start = [...this.roster.values()].filter((e) => e.seeded).length;
    for (let i = 0; i < n; i++) {
      const seed = crypto.getRandomValues(new Uint8Array(32));
      const did = identityFromSeed(seed).did;
      this.roster.set(did, { did, name: `${label} ${String(start + i + 1).padStart(3, "0")}`, status: "active", added: this.clock.iso(), seeded: true });
      const secret = memberSecret(crypto.getRandomValues(new Uint8Array(32)), this.groupId);
      this.group.enroll(did, commitmentOf(secret, groupFieldOf(this.groupId)));
    }
  }

  serve(endpoint: Endpoint): void {
    this.group.serve(endpoint, (did) => this.admits(did));
  }

  log(): GroupRoot[] {
    return this.group.log();
  }

  /** Publishes this epoch's root. */
  publish(): GroupRoot {
    return this.group.publish().root;
  }

  /** The issuer publishes once per epoch, even if nothing changed. Starts once the first root exists. */
  publishIfDue(): GroupRoot | null {
    const head = this.log().at(-1);
    if (!head || head.epoch === epochOf(this.clock.now())) return null;
    return this.publish();
  }

  members(): MemberView[] {
    return [...this.roster.values()].map((e) => {
      const m = this.group.member(e.did);
      return { ...e, ...(m ? { index: m.index, commitment: fieldToHex(m.leaf.commitment) } : {}) };
    });
  }

  /**
   * The demo's cheat (design §11 step 12): a second root for the current head's epoch, signed by the
   * organization, holding only `target`'s leaf and `fakes` made-up leaves. Anyone shown it next to
   * the real log holds proof that the organization equivocated.
   */
  forkRoot(target: string, fakes = 59): { root: GroupRoot; snapshot: Uint8Array } {
    const head = this.log().at(-1);
    if (!head) throw new Error("publish a root first");
    const m = this.group.member(target);
    if (!m) throw new Error("that DID has no leaf");
    const tree = new GroupTree(20);
    tree.append(leafHash(m.leaf));
    for (let i = 0; i < fakes; i++) tree.append(toField(crypto.getRandomValues(new Uint8Array(32))));
    const snapshot = tree.snapshot();
    const doc: GroupRoot = {
      ...head,
      id: `urn:uuid:${crypto.randomUUID()}`,
      root: fieldToHex(tree.root()),
      length: tree.length(),
      size: tree.size(),
      snapshotHash: bytesToHex(sha256(snapshot)),
      issuedAt: this.clock.iso(),
    };
    delete doc.proof;
    return { root: signDocument(doc, this.identity, this.clock), snapshot };
  }

  state(): OrgIssuerState {
    return { v: 1, group: this.group.state(), roster: [...this.roster.values()] };
  }
}
