/**
 * The browser side of a Settle account: the identity lives in this browser's storage, the party runs in
 * this tab, and its state is saved after every change. One tab per account at a time (a Web Lock), so
 * two tabs never answer the same messages.
 */
import { fromB64u, identityFromSeed, toB64u, type OutboxItem, type OutboxStore } from "@zk-toip/trust-core";
import { SettleApi, type Person, type PlatformConfig } from "../../src/client/client";
import { SettlePolicy } from "../../src/protocol/policy";
import type { Party, PartySnapshot } from "../../src/agents/party";
import wasmUrl from "../../policies/policy.wasm?url";

export interface Account {
  id: string;
  name: string;
  seed: string;
  created: string;
}

const ACCOUNTS = "settle.accounts";
const ACTIVE = "settle.active";
export const api = new SettleApi("");

export function accounts(): Account[] {
  try {
    return JSON.parse(localStorage.getItem(ACCOUNTS) ?? "[]");
  } catch {
    return [];
  }
}

export function createAccount(name: string): Account {
  const a: Account = { id: crypto.randomUUID(), name: name.trim().slice(0, 60), seed: toB64u(crypto.getRandomValues(new Uint8Array(32))), created: new Date().toISOString() };
  localStorage.setItem(ACCOUNTS, JSON.stringify([...accounts(), a]));
  return a;
}

export function removeAccount(id: string): void {
  const a = accounts().find((x) => x.id === id);
  if (!a) return;
  const did = identityFromSeed(fromB64u(a.seed)).did;
  localStorage.removeItem(`settle.state.${did}`);
  localStorage.removeItem(`settle.outbox.${did}`);
  localStorage.setItem(ACCOUNTS, JSON.stringify(accounts().filter((x) => x.id !== id)));
}

/** The account this tab is using. Each tab picks its own, so one browser can be two people side by side. */
export const activeAccountId = (): string | null => sessionStorage.getItem(ACTIVE);
export const setActiveAccount = (id: string | null) => (id ? sessionStorage.setItem(ACTIVE, id) : sessionStorage.removeItem(ACTIVE));

/** Holds the account's lock for as long as this tab lives. False if another tab already has it. */
const held = new Set<string>();
function lockAccount(id: string): Promise<boolean> {
  if (!navigator.locks || held.has(id)) return Promise.resolve(true);
  return new Promise((resolve) => {
    void navigator.locks.request(`settle-account-${id}`, { ifAvailable: true }, (lock) => {
      if (lock) held.add(id);
      resolve(!!lock);
      return lock ? new Promise(() => {}) : undefined;
    });
  });
}

class LocalOutbox implements OutboxStore {
  constructor(private readonly key: string) {}
  async load(): Promise<OutboxItem[]> {
    try {
      return JSON.parse(localStorage.getItem(this.key) ?? "[]");
    } catch {
      return [];
    }
  }
  async save(items: OutboxItem[]): Promise<void> {
    localStorage.setItem(this.key, JSON.stringify(items));
  }
}

let policy: Promise<SettlePolicy> | undefined;
const loadPolicy = () => (policy ??= fetch(wasmUrl).then(async (r) => SettlePolicy.load(await r.arrayBuffer())));

export class Session {
  version = 0;
  wallet = 0n;
  now = 0;
  people: Person[] = [];
  /** Set when the local network restarted since this account last saved: its old payments are gone. */
  reset = false;
  private listeners = new Set<() => void>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private saveTimer?: ReturnType<typeof setTimeout>;

  private constructor(
    readonly account: Account,
    readonly config: PlatformConfig,
    readonly party: Party,
  ) {}

  static async open(account: Account): Promise<Session | "locked"> {
    if (!(await lockAccount(account.id))) return "locked";
    const config = await api.config();
    const identity = identityFromSeed(fromB64u(account.seed));
    const stateKey = `settle.state.${identity.did}`;
    let saved: { networkId: string; snapshot: PartySnapshot } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(stateKey) ?? "null");
    } catch {
      saved = null;
    }
    const fresh = !!saved && saved.networkId !== config.networkId;
    if (fresh) localStorage.removeItem(`settle.outbox.${identity.did}`);
    let session!: Session;
    const party = await api.party({
      identity,
      name: account.name,
      policy: await loadPolicy(),
      outbox: new LocalOutbox(`settle.outbox.${identity.did}`),
      snapshot: saved && !fresh ? saved.snapshot : undefined,
      onChange: () => session?.changed(),
    });
    session = new Session(account, config, party);
    session.reset = fresh;
    await party.start();
    await party.openWallet();
    await api.register(party).catch(() => {});
    session.timers.push(setInterval(() => void session.refresh(), 1500));
    session.timers.push(setInterval(() => void session.loadPeople(), 8000));
    await Promise.all([session.refresh(), session.loadPeople()]);
    return session;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  changed(): void {
    this.version++;
    this.listeners.forEach((l) => l());
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 250);
  }

  save(): void {
    localStorage.setItem(`settle.state.${this.party.did}`, JSON.stringify({ networkId: this.config.networkId, snapshot: this.party.snapshot() }));
  }

  async refresh(): Promise<void> {
    try {
      await this.party.tick();
      const [wallet, now] = await Promise.all([this.party.walletBalance(), this.party.chain.now()]);
      if (wallet !== this.wallet || Number(now) !== this.now) {
        this.wallet = wallet;
        this.now = Number(now);
        this.changed();
      }
    } catch (e) {
      // The network may be restarting; the next tick tries again.
      console.error("settle: tick failed", e);
    }
  }

  async loadPeople(): Promise<void> {
    try {
      this.people = await api.people();
      for (const p of this.people) if (p.did !== this.party.did) this.party.directory.names[p.did] = p.name;
      this.changed();
    } catch {
      // ignore
    }
  }

  close(): void {
    this.timers.forEach(clearInterval);
    this.save();
    this.party.stop();
  }
}
