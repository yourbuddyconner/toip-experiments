/**
 * Act 1's two ends (design §4.2, §17): a door that answers `mesh-demo/door/open` offline, and a guest
 * that waits for the door's signed challenge beacon and presents a pass. Both run on any MeshTransport,
 * whatever its link: the simulator, the RAK miner through GWMP, or a RAK3172.
 */
import { ChallengeBeacon, type BeaconInfo, type MeshTransport } from "@zk-toip/mesh-transport";
import {
  Endpoint,
  PersistentReplayGuard,
  ctt1,
  fromB64u,
  memoryReplayStore,
  ourSpec,
  toB64u,
  type Clock,
  type Identity,
  type ReplayStore,
  type Transport,
} from "@zk-toip/trust-core";
import { checkPass, type DoorCache, type GuestPass, type PassVerdict } from "./pass";

/** Request `{credential, challenge}`, response `{open, reason?}` (design §16). */
export const DOOR_OPEN = ourSpec("mesh-demo/door/open");

export interface DoorRequest {
  credential: GuestPass;
  /** The beacon's nonce, base64url. Signing the request signs it with the pass key. */
  challenge: string;
}

export interface DoorAnswer {
  open: boolean;
  reason?: string;
}

type Guard = NonNullable<ConstructorParameters<typeof Endpoint>[0]["replayGuard"]>;

export type DoorEvent =
  | { type: "opened"; sender: string; pass: string; household: string; docId: string }
  | { type: "refused"; sender: string; code: Extract<PassVerdict, { ok: false }>["code"] | "stale-challenge"; reason: string; docId: string }
  | { type: "duplicate"; docId: string };

/** The door's replay record, watched so the demo can say when it stopped a replay. */
class WatchedGuard implements Guard {
  constructor(
    private readonly inner: PersistentReplayGuard,
    private readonly onDuplicate: (id: string) => void,
  ) {}
  async claim(id: string, digest: string, retainUntil: number | undefined, now: number) {
    const v = await this.inner.claim(id, digest, retainUntil, now);
    if (v.kind !== "fresh") this.onDuplicate(id);
    return v;
  }
  recordResponse(id: string, response: unknown) {
    return this.inner.recordResponse(id, response);
  }
  release(id: string, digest: string) {
    return this.inner.release(id, digest);
  }
}

/**
 * Offline endpoints tolerate 10 minutes of clock skew (design §6, §19.2), and accept a request up to
 * 10 minutes old: a radio message may spend minutes in retries. The replay record covers that window.
 */
export const OFFLINE_FRESHNESS = { skewMs: 10 * 60_000, maxAgeMs: 10 * 60_000, requireIssuedAt: true };

export class Door {
  readonly endpoint: Endpoint;
  readonly beacon: ChallengeBeacon;
  readonly events: DoorEvent[] = [];
  readonly replayStore: ReplayStore;

  constructor(
    private readonly opts: {
      identity: Identity;
      mesh: MeshTransport;
      clock: Clock;
      cache: DoorCache;
      /** Keep it on disk (fileReplayStore) so a reboot doesn't forget which passes were used. */
      replayStore?: ReplayStore;
      beaconEveryMs?: number;
      onEvent?: (e: DoorEvent) => void;
      /** Wraps the transport, to watch what the door sends. */
      tap?: (t: Transport) => Transport;
    },
  ) {
    this.replayStore = opts.replayStore ?? memoryReplayStore();
    const guard = new WatchedGuard(new PersistentReplayGuard(this.replayStore), (docId) => this.emit({ type: "duplicate", docId }));
    const mesh = opts.mesh;
    this.endpoint = new Endpoint({
      identity: opts.identity,
      transport: opts.tap ? opts.tap(mesh) : mesh,
      clock: opts.clock,
      freshness: OFFLINE_FRESHNESS,
      replayGuard: guard,
      bodyCodecFor: (to) => (mesh.supportsCompact(to) ? ctt1 : undefined),
      timeoutMs: 60_000,
    });
    this.beacon = new ChallengeBeacon({ identity: opts.identity, mesh, everyMs: opts.beaconEveryMs ?? 15_000 });
    this.endpoint.handle<DoorRequest, DoorAnswer>(DOOR_OPEN, async (doc, ctx) => {
      const { credential, challenge } = doc.payload ?? ({} as DoorRequest);
      const refuse = (code: Extract<DoorEvent, { type: "refused" }>["code"], reason: string): DoorAnswer => {
        this.emit({ type: "refused", sender: ctx.sender, code, reason, docId: doc.id });
        return { open: false, reason };
      };
      let nonce: Uint8Array;
      try {
        nonce = fromB64u(String(challenge));
      } catch {
        return refuse("stale-challenge", "no challenge");
      }
      const verdict = await checkPass(credential, { sender: ctx.sender, door: opts.identity.did, cache: opts.cache, clock: opts.clock });
      if (!verdict.ok) return refuse(verdict.code, verdict.reason);
      if (!this.beacon.isFresh(nonce)) return refuse("stale-challenge", "the challenge is stale: present again");
      this.emit({ type: "opened", sender: ctx.sender, pass: verdict.pass, household: verdict.household, docId: doc.id });
      return { open: true };
    });
  }

  private emit(e: DoorEvent): void {
    this.events.push(e);
    this.opts.onEvent?.(e);
  }

  start(): void {
    this.beacon.start();
  }

  stop(): void {
    this.beacon.stop();
    this.endpoint.close();
  }
}

/** Waits for the door's next signed challenge beacon. The guest's mesh must already know the door's DID. */
export function nextChallenge(mesh: MeshTransport, door: string, timeoutMs: number): Promise<BeaconInfo> {
  return new Promise((resolve, reject) => {
    const timer = mesh.scheduler.setTimeout(() => {
      off();
      reject(new Error(`no beacon from the door in ${Math.round(timeoutMs / 1000)} s: is it in range?`));
    }, timeoutMs);
    const off = mesh.onBeacon((b) => {
      if (b.role !== "verifier" || b.vid !== door || !b.nonce) return;
      off();
      mesh.scheduler.clearTimeout(timer);
      resolve(b);
    });
  });
}

/** The guest's side: a pass key's Endpoint on the mesh. */
export class Guest {
  readonly endpoint: Endpoint;

  constructor(
    private readonly opts: { identity: Identity; mesh: MeshTransport; clock: Clock; tap?: (t: Transport) => Transport },
  ) {
    const mesh = opts.mesh;
    this.endpoint = new Endpoint({
      identity: opts.identity,
      transport: opts.tap ? opts.tap(mesh) : mesh,
      clock: opts.clock,
      freshness: OFFLINE_FRESHNESS,
      bodyCodecFor: (to) => (mesh.supportsCompact(to) ? ctt1 : undefined),
    });
  }

  /** Presents the pass with this challenge. Resolves with the door's answer. */
  async present(door: string, credential: GuestPass, nonce: Uint8Array, timeoutMs?: number): Promise<DoorAnswer> {
    const ms = timeoutMs ?? this.opts.mesh.suggestedTimeoutMs(door, 1500);
    const res = await this.endpoint.request<DoorRequest, DoorAnswer>(door, DOOR_OPEN, { credential, challenge: toB64u(nonce) }, { timeoutMs: ms });
    return res.payload;
  }

  close(): void {
    this.endpoint.close();
  }
}
