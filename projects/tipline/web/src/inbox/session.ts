// The inbox in Sam's browser: the drop box key is sealed in this browser with a passkey (web-vault),
// the InboxAgent runs in this tab, and its state and files are saved sealed after every change.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { CIRCUIT_ID, MembershipVerifier, loadArtifacts } from "@toip-tools/anon-membership";
import { RelayTransport, identityFromSeed, type Identity } from "@toip-tools/trust-core";
import { createVault, type Unlocked } from "@toip-tools/web-vault";
import { InboxAgent, type FileStore, type InboxState } from "../../../src/agents/inbox";
import { httpFetcher } from "../../../src/agents/logs";
import { DEFAULT_LIMITS, signDescriptor, type Descriptor, type Story } from "../../../src/protocol/descriptor";
import { postJson, type ServerClock } from "../common/net";

export const vault = createVault({ prefix: "tipline-inbox", rpName: "Tipline inbox" });

export interface Organization {
  org: string;
  label: string;
  group: string;
  issuer: string;
  log: string;
  mirrorSlug: string;
}

export interface InboxConfig {
  relayUrl: string;
  outletUrl: string;
  organizations: Organization[];
  bundle?: { url: string; sha256: string };
}

export interface Profile {
  journalist: string;
  outlet: string;
  slug: string;
}

/** Attachments sealed in this browser's storage; kept in memory for the session if storage is full. */
class VaultFiles implements FileStore {
  private readonly mem = new Map<string, Uint8Array>();
  constructor(private readonly u: Unlocked) {}
  private name(tipId: string, a: string) {
    return `file-${tipId.slice(-32, -16)}-${a}`;
  }
  async put(tipId: string, a: string, bytes: Uint8Array) {
    this.mem.set(this.name(tipId, a), bytes);
    try {
      await vault.writeBlob(this.u, this.name(tipId, a), bytes);
    } catch {
      // Storage full: the file stays readable until the tab closes.
    }
  }
  async get(tipId: string, a: string) {
    return this.mem.get(this.name(tipId, a)) ?? (await vault.readBlob(this.u, this.name(tipId, a)).catch(() => null));
  }
}

export function dropboxIdentity(seed: Uint8Array): Identity {
  return identityFromSeed(hmac(sha256, seed, utf8ToBytes("tipline/v1/dropbox")));
}

export class InboxSession {
  version = 0;
  private readonly listeners = new Set<() => void>();
  private saveTimer?: ReturnType<typeof setTimeout>;
  agent!: InboxAgent;

  private constructor(
    readonly unlocked: Unlocked,
    readonly profile: Profile,
    readonly identity: Identity,
    readonly config: InboxConfig,
    readonly clock: ServerClock,
    readonly transport: RelayTransport,
  ) {}

  static async open(u: Unlocked, config: InboxConfig, clock: ServerClock): Promise<InboxSession> {
    const profile = await vault.readJson<Profile>(u, "profile");
    if (!profile) throw new Error("this account has no drop box profile");
    const identity = dropboxIdentity(u.seed);
    const state = await vault.readJson<InboxState>(u, "inbox-state");
    const verifier = await MembershipVerifier.create();
    const transport = new RelayTransport({ url: config.relayUrl, identity });
    const s = new InboxSession(u, profile, identity, config, clock, transport);
    s.agent = new InboxAgent({
      identity,
      transport,
      clock,
      verifier,
      fetcher: httpFetcher(),
      outletUrl: config.outletUrl + "/",
      state: state ?? undefined,
      files: new VaultFiles(u),
      onChange: () => s.changed(),
    });
    transport.onStatus(() => s.notify());
    transport.start();
    // The outlet may have restarted: give it the signed descriptor again.
    const d = s.agent.getDescriptor();
    if (d) void postJson(`${config.outletUrl}/dropbox/${d.slug}/descriptor`, { descriptor: d }).catch(() => {});
    return s;
  }

  get tipUrl(): string {
    return `${this.config.outletUrl}/tip/${this.profile.slug}`;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private changed() {
    this.notify();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void vault.writeJson(this.unlocked, "inbox-state", this.agent.state()).catch(() => {}), 250);
  }

  /** Adds a story to the descriptor, signs it with the drop box key, and publishes it at the outlet. */
  async openStory(o: { title: string; org: Organization; minSize: number; maxEpochAge: number }): Promise<Descriptor> {
    const title = o.title.trim();
    if (!title) throw new Error("give the story a title");
    const prior = this.agent.getDescriptor();
    const base = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "story";
    let id = base;
    for (let n = 2; prior?.stories.some((s) => s.id === id); n++) id = `${base}-${n}`;
    const story: Story = {
      id,
      title,
      opens: this.clock.iso().slice(0, 10),
      groups: [
        {
          group: o.org.group,
          issuer: o.org.issuer,
          label: o.org.label,
          log: o.org.log,
          mirror: `/dropbox/${this.profile.slug}/mirror/${o.org.mirrorSlug}/`,
          minSize: o.minSize,
          maxEpochAge: o.maxEpochAge,
        },
      ],
    };
    const { vkHash } = await loadArtifacts();
    const d = signDescriptor(
      {
        slug: this.profile.slug,
        outlet: this.profile.outlet,
        journalist: { name: this.profile.journalist },
        relay: this.config.relayUrl,
        ...(this.config.bundle ? { appBundle: this.config.bundle } : {}),
        circuits: [{ id: CIRCUIT_ID, vkHash }],
        stories: [...(prior?.stories ?? []), story],
        limits: DEFAULT_LIMITS,
      },
      this.identity,
      this.clock,
    );
    await postJson(`${this.config.outletUrl}/dropbox/${d.slug}/descriptor`, { descriptor: d });
    this.agent.setDescriptor(d);
    return d;
  }

  close(): void {
    this.transport.stop();
  }
}
