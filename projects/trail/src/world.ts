/**
 * Everything the demo runs on: four witnesses (three in use at first), two watchers (Ada's and the supplier's),
 * the actors' stores and keys, and the demo's progress. Kept in a data folder, or in memory.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromB64u, identityFromSeed, SystemClock, toB64u, type Clock, type Identity } from "@zk-toip/trust-core";
import {
  coldKeysFromSeed,
  Controller,
  exportBundle,
  type DuplicityEvidence,
  httpWitnessClient,
  keyQb64,
  MemoryStore,
  nonTransferableAid,
  Watcher,
  type ColdKeys,
  type LogStore,
  type Signer,
  type StoreData,
  type WitnessClient,
} from "@zk-toip/eventlog";
import { JsonFileStore } from "@zk-toip/eventlog/node";
import { WitnessService } from "./witnesses";
import type { Bundle } from "@zk-toip/eventlog";

export interface Line {
  who: string;
  text: string;
  tone?: "ok" | "bad" | "warn" | "info" | "dim";
}

export interface StepReport {
  n: number;
  title: string;
  redTeam: boolean;
  lines: Line[];
  at: string;
}

/** A bundle the explorer's Verify page can load. */
export interface Sample {
  id: string;
  title: string;
  note: string;
  bundle: Bundle;
}

/** A photo signed outside the log (step 9). */
export interface Capture {
  label: string;
  /** The signed bytes, base64url. */
  bytes: string;
  /** The -F group: the key state that signed, and its signatures. */
  sig: string;
  note: string;
}

export interface KeripyOutcome {
  ran: boolean;
  /** Why it was skipped, or what failed. */
  reason?: string;
  python?: string;
  matches?: { aid: string; label: string; ok: boolean; ours: Record<string, unknown>; theirs?: Record<string, unknown>; differences: string[] }[];
}

interface Saved {
  version: 1;
  secrets: Record<string, string>;
  progress: number;
  reports: StepReport[];
  scout?: { aid: string; trailId: string; keySet: number };
  adaKeySet: number;
  camera?: { aid: string; trailId: string };
  /** Witness numbers in Scout's current list. */
  scoutWitnesses: number[];
  rogue: number[];
  samples: Sample[];
  captures: Capture[];
  keripy?: KeripyOutcome;
  /** Trails the supplier's watcher follows. */
  supplierWatches: { logId: string; controller: string }[];
}

export interface WorldOptions {
  /** Keep everything here. Without it, everything is in memory. */
  dataDir?: string;
  host?: string;
  /** Ports for witnesses 1 to 4. 0 picks a free one. */
  witnessPorts?: number[];
  clock?: Clock;
}

const SECRET_NAMES = ["w1", "w2", "w3", "w4", "ada", "adaRotation", "scout", "scoutCold", "camera", "supplier", "bram"] as const;

export class World {
  readonly witnesses: WitnessService[] = [];
  adaWatcher!: Watcher;
  supplierWatcher!: Watcher;
  scoutStore!: LogStore;
  cameraStore!: LogStore;
  /** Mallory's copy of Scout's logs, after she steals the key (step 7). */
  malloryStore?: LogStore;
  scout?: Controller;
  camera?: Controller;
  readonly clock: Clock;
  private saved!: Saved;
  private readonly stores: LogStore[] = [];

  private constructor(
    private readonly opts: WorldOptions,
  ) {
    this.clock = opts.clock ?? new SystemClock();
  }

  static async open(opts: WorldOptions = {}): Promise<World> {
    const w = new World(opts);
    await w.init();
    return w;
  }

  // ------------------------------------------------------------------ setup and persistence

  private path(name: string): string | undefined {
    return this.opts.dataDir ? join(this.opts.dataDir, name) : undefined;
  }

  /** A store kept in the data folder, or in memory. `init` seeds a new one. */
  makeStore(name: string, init?: StoreData): LogStore {
    const p = this.path(`${name}.json`);
    let s: LogStore;
    if (!p) s = new MemoryStore(init);
    else {
      if (init) writeFileSync(p, JSON.stringify(init));
      s = new JsonFileStore(p, { flushMs: 50 });
    }
    this.stores.push(s);
    return s;
  }

  private async init(): Promise<void> {
    if (this.opts.dataDir) mkdirSync(this.opts.dataDir, { recursive: true });
    const statePath = this.path("state.json");
    if (statePath && existsSync(statePath)) this.saved = JSON.parse(readFileSync(statePath, "utf8")) as Saved;
    else {
      const secrets: Record<string, string> = {};
      for (const k of SECRET_NAMES) secrets[k] = toB64u(crypto.getRandomValues(new Uint8Array(32)));
      this.saved = { version: 1, secrets, progress: 0, reports: [], adaKeySet: 1, scoutWitnesses: [1, 2, 3], rogue: [], samples: [], captures: [], supplierWatches: [] };
    }
    const host = this.opts.host ?? "127.0.0.1";
    for (let n = 1; n <= 4; n++) {
      const w = new WitnessService(n, this.seed(`w${n}` as "w1"), this.makeStore(`witness-${n}`), this.clock);
      w.rogue = this.saved.rogue.includes(n);
      await w.listen(this.opts.witnessPorts?.[n - 1] ?? 0, host);
      this.witnesses.push(w);
    }
    this.scoutStore = this.makeStore("scout");
    this.cameraStore = this.makeStore("camera");
    if (this.path("mallory.json") && existsSync(this.path("mallory.json")!)) this.malloryStore = this.makeStore("mallory");
    this.adaWatcher = new Watcher({ id: "Ada's watcher", store: this.makeStore("watcher-ada"), sources: this.witnesses.map((w) => this.client(w.n)), clock: this.clock });
    this.supplierWatcher = new Watcher({ id: "Quarry's watcher", store: this.makeStore("watcher-supplier"), sources: [1, 2, 3].map((n) => this.client(n)), clock: this.clock });
    for (const x of this.saved.supplierWatches) this.supplierWatcher.watch(x.logId, x.controller);
    if (this.saved.scout) {
      this.scout = await Controller.load(this.saved.scout.aid, { hot: [this.scoutKey(this.saved.scout.keySet)], store: this.scoutStore, clock: this.clock });
      this.adaWatcher.watch(this.saved.scout.trailId, this.saved.scout.aid);
    }
    if (this.saved.camera) {
      this.camera = await Controller.load(this.saved.camera.aid, { cold: this.cameraCold, store: this.cameraStore, clock: this.clock });
      this.adaWatcher.watch(this.saved.camera.trailId, this.saved.camera.aid);
    }
  }

  /** Writes the demo's state. Stores write themselves. */
  save(): void {
    const p = this.path("state.json");
    if (!p) return;
    writeFileSync(`${p}.tmp`, JSON.stringify(this.saved));
    renameSync(`${p}.tmp`, p);
  }

  get state(): Saved {
    return this.saved;
  }

  async close(): Promise<void> {
    this.save();
    for (const w of this.witnesses) await w.close();
    for (const s of this.stores) (s as { close?: () => void }).close?.();
  }

  // ------------------------------------------------------------------ keys and identities

  seed(name: (typeof SECRET_NAMES)[number]): Uint8Array {
    return fromB64u(this.saved.secrets[name]);
  }

  /** Ada, the principal: her did:key, and the rotation keys she holds for Scout. */
  get ada(): Identity {
    return identityFromSeed(this.seed("ada"));
  }

  get adaCold(): ColdKeys {
    return coldKeysFromSeed(this.seed("adaRotation"), "ada/scout");
  }

  adaKey(set: number): Signer {
    return this.adaCold.release(set, 1)[0];
  }

  /** Scout, the agent: its did:key (for messages and the DID binding) and its AID keys. */
  get scoutId(): Identity {
    return identityFromSeed(this.seed("scout"));
  }

  get scoutCold(): ColdKeys {
    return coldKeysFromSeed(this.seed("scoutCold"), "scout");
  }

  scoutKey(set: number): Signer {
    return this.scoutCold.release(set, 1)[0];
  }

  get cameraCold(): ColdKeys {
    return coldKeysFromSeed(this.seed("camera"), "camera", { curve: "p256" });
  }

  get supplier(): Identity {
    return identityFromSeed(this.seed("supplier"));
  }

  get bram(): Identity {
    return identityFromSeed(this.seed("bram"));
  }

  // ------------------------------------------------------------------ witnesses

  witness(n: number): WitnessService {
    return this.witnesses[n - 1];
  }

  /** An HTTP client for witness n, as any actor reaches it. */
  client(n: number): WitnessClient & { evidence: ReturnType<typeof httpWitnessClient>["evidence"] } {
    const w = this.witness(n);
    return httpWitnessClient(w.url, w.aid);
  }

  clients(ns: number[]) {
    return ns.map((n) => this.client(n));
  }

  /** Clients for the witnesses in Scout's current list. */
  scoutClients() {
    return this.clients(this.saved.scoutWitnesses);
  }

  /**
   * Ada's view of an AID: the logs as her watcher holds them (every version it has seen), with the bodies
   * and DID bindings the controller disclosed to her.
   */
  async adaBundle(aid: string): Promise<Bundle> {
    const b = await exportBundle(this.adaWatcher.store, aid);
    const own = aid === this.saved.scout?.aid ? this.scoutStore : aid === this.saved.camera?.aid ? this.cameraStore : undefined;
    if (own) {
      const disclosed = await exportBundle(own, aid, { bodies: "all" });
      b.bindings = disclosed.bindings;
      for (const t of b.trails) {
        const d = disclosed.trails.find((x) => x.id === t.id);
        if (d?.bodies) t.bodies = d.bodies;
      }
    }
    return b;
  }

  /** Every piece of duplicity evidence the watchers and witnesses hold, with who holds it. */
  async evidence(): Promise<{ holder: string; evidence: DuplicityEvidence }[]> {
    const out: { holder: string; evidence: DuplicityEvidence }[] = [];
    const add = (holder: string, list: DuplicityEvidence[]) => list.forEach((e) => out.push({ holder, evidence: e }));
    add("Ada's watcher", await this.adaWatcher.evidence());
    add("Quarry's watcher", await this.supplierWatcher.evidence());
    for (const w of this.witnesses) add(w.name, await w.witness.evidence());
    return out;
  }

  /** The identifiers the explorer lists. */
  logs(): { aid: string; label: string; trailId: string }[] {
    const out: { aid: string; label: string; trailId: string }[] = [];
    if (this.saved.scout) out.push({ aid: this.saved.scout.aid, label: "Scout", trailId: this.saved.scout.trailId });
    if (this.saved.camera) out.push({ aid: this.saved.camera.aid, label: "Camera K-7", trailId: this.saved.camera.trailId });
    return out;
  }

  /** Display names for AIDs and signers the explorer shows. */
  names(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const w of this.witnesses) out[w.aid] = w.name;
    out[nonTransferableAid(this.ada.signingPublic)] = "Ada (principal)";
    out[nonTransferableAid(this.supplier.signingPublic)] = "Quarry Supply";
    out[nonTransferableAid(this.bram.signingPublic)] = "Bram";
    if (this.saved.scout) out[this.saved.scout.aid] = "Scout";
    if (this.saved.camera) out[this.saved.camera.aid] = "Camera K-7";
    for (let j = 0; j < 4; j++) {
      out[keyQb64(this.scoutKey(j))] = `Scout key ${j}`;
      out[keyQb64(this.adaKey(j + 1))] = `Ada's rotation key ${j + 1}`;
      out[keyQb64(this.cameraCold.release(j, 1)[0])] = `Camera key ${j}`;
    }
    return out;
  }
}
