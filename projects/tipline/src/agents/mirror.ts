/**
 * The outlet's mirror of an organization's root log and snapshots (design §6.6). It fetches from the
 * organization, checks signatures, the chain and each snapshot's hash, and serves what passed. A
 * source can then load the group without contacting the organization.
 *
 * `tamper` is for the demo: the organization colluding with the outlet's web host to serve a
 * different root. The mirror then serves that, and stops refreshing, until `untamper`.
 */
import { checkRootLog, snapshotMatches, type GroupRoot } from "@toip-tools/anon-membership";
import type { Clock } from "@toip-tools/trust-core";
import type { Fetcher } from "./logs";

export interface MirrorStatus {
  ok: boolean;
  checkedAt?: string;
  reason?: string;
  head?: { epoch: string; size: number };
  tampered: boolean;
}

export class Mirror {
  private log: GroupRoot[] = [];
  private readonly snapshots = new Map<string, Uint8Array>();
  private status: MirrorStatus = { ok: false, tampered: false, reason: "not fetched yet" };
  private tampered?: { log: GroupRoot[]; snapshots: Map<string, Uint8Array> };

  constructor(
    private readonly opts: {
      issuer: string;
      logUrl: string;
      snapshotUrl: (epoch: string) => string;
      fetcher: Fetcher;
      clock: Clock;
      /** How many recent epochs' snapshots to keep. */
      keep?: number;
    },
  ) {}

  async refresh(): Promise<MirrorStatus> {
    if (this.tampered) return this.status;
    try {
      const log = (await this.opts.fetcher.json(this.opts.logUrl)) as GroupRoot[];
      const check = await checkRootLog(log, this.opts.issuer, this.opts.clock);
      if (!check.ok) throw new Error(`the log doesn't check out: ${check.reason}`);
      const want = log.slice(-(this.opts.keep ?? 8));
      for (const doc of want) {
        if (this.snapshots.has(doc.epoch) && snapshotMatches(doc, this.snapshots.get(doc.epoch)!)) continue;
        const snap = await this.opts.fetcher.bytes(this.opts.snapshotUrl(doc.epoch)).catch(() => null);
        if (snap && snapshotMatches(doc, snap)) this.snapshots.set(doc.epoch, snap);
      }
      if (!this.snapshots.has(check.head.epoch)) throw new Error("the newest snapshot is missing or doesn't match its root");
      for (const e of [...this.snapshots.keys()]) if (!want.some((d) => d.epoch === e)) this.snapshots.delete(e);
      this.log = log;
      this.status = { ok: true, checkedAt: this.opts.clock.iso(), head: { epoch: check.head.epoch, size: check.head.size }, tampered: false };
    } catch (e) {
      this.status = { ...this.status, ok: this.log.length > 0, reason: e instanceof Error ? e.message : String(e), checkedAt: this.opts.clock.iso() };
    }
    return this.status;
  }

  serveLog(): GroupRoot[] {
    return this.tampered?.log ?? this.log;
  }

  serveSnapshot(epoch: string): Uint8Array | undefined {
    return (this.tampered?.snapshots ?? this.snapshots).get(epoch);
  }

  /** Replaces the newest root with `root` (same epoch and seq), and serves `snapshot` for it. */
  tamper(root: GroupRoot, snapshot: Uint8Array): void {
    const log = this.log.filter((d) => d.seq !== root.seq);
    log.push(root);
    const snapshots = new Map(this.snapshots);
    snapshots.set(root.epoch, snapshot);
    this.tampered = { log, snapshots };
    this.status = { ...this.status, tampered: true };
  }

  untamper(): void {
    this.tampered = undefined;
    this.status = { ...this.status, tampered: false };
  }

  state(): MirrorStatus {
    return this.status;
  }
}
