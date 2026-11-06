/**
 * Where an account's key lives in the browser: sealed, never in the clear (design §18).
 *
 * The identity seed is encrypted with AES-GCM under a key that exists only while the account is unlocked:
 * - from a passkey, through the WebAuthn PRF extension (the authenticator derives a secret from the passkey
 *   and a salt; HKDF turns it into the AES key), so unlocking is Touch ID, Windows Hello or a security key;
 * - or, where the browser's passkeys can't do PRF, from a passphrase (PBKDF2-SHA256, 600,000 rounds).
 * The account's saved payments are sealed under the same key. Each sealed blob is bound to its account and
 * purpose, so blobs can't be swapped between accounts.
 *
 * Losing the passkey (or passphrase) loses the account, unless its backup code was kept: Profile shows it.
 */
import { fromB64u, identityFromSeed, toB64u } from "@zk-toip/trust-core";

export interface Sealed {
  iv: string;
  data: string;
}

export type Lock =
  | { kind: "passkey"; credentialId: string; salt: string; seed: Sealed }
  | { kind: "passphrase"; salt: string; iterations: number; seed: Sealed };

export interface Account {
  id: string;
  name: string;
  created: string;
  did: string;
  lock?: Lock;
  /** Accounts made before keys were sealed kept the seed in the clear. Protecting one removes it. */
  seed?: string;
}

/** An account whose key is in memory: what a tab needs to run its party. */
export interface Unlocked {
  account: Account;
  seed: Uint8Array;
  /** Seals and opens this account's saved state. Null for an account that isn't protected yet. */
  key: CryptoKey | null;
}

const ACCOUNTS = "settle.accounts";
const PBKDF2_ROUNDS = 600_000;
const utf8 = (s: string) => new TextEncoder().encode(s);
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const buf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

export class PasskeyUnsupported extends Error {
  constructor() {
    super("this browser's passkeys can't protect a key yet (no PRF support)");
  }
}

// ---------------------------------------------------------------- accounts

export function accounts(): Account[] {
  try {
    const list = JSON.parse(localStorage.getItem(ACCOUNTS) ?? "[]") as Account[];
    // Accounts from before keys were sealed don't record their DID.
    return list.map((a) => (a.did || !a.seed ? a : { ...a, did: identityFromSeed(fromB64u(a.seed)).did }));
  } catch {
    return [];
  }
}

function saveAccounts(list: Account[]): void {
  localStorage.setItem(ACCOUNTS, JSON.stringify(list));
}

function upsert(a: Account): void {
  saveAccounts([...accounts().filter((x) => x.id !== a.id), a]);
}

export function removeAccount(id: string): void {
  const a = accounts().find((x) => x.id === id);
  if (!a) return;
  localStorage.removeItem(`settle.state.${a.did}`);
  localStorage.removeItem(`settle.outbox.${a.did}`);
  saveAccounts(accounts().filter((x) => x.id !== id));
  unlocked.delete(id);
}

// ---------------------------------------------------------------- crypto

async function seal(key: CryptoKey, plain: Uint8Array, aad: string): Promise<Sealed> {
  const iv = random(12);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, buf(plain)));
  return { iv: toB64u(iv), data: toB64u(data) };
}

async function open(key: CryptoKey, s: Sealed, aad: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(fromB64u(s.iv)), additionalData: utf8(aad) }, key, buf(fromB64u(s.data))));
}

async function keyFromPrf(secret: ArrayBuffer, accountId: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: buf(utf8("settle/account-key/v1")), info: buf(utf8(accountId)) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function keyFromPassphrase(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", buf(utf8(passphrase.normalize("NFKC"))), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: buf(salt), iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// ---------------------------------------------------------------- passkeys

type PrfResults = { enabled?: boolean; results?: { first?: ArrayBuffer } };
const prfOf = (c: Credential | null) => ((c as PublicKeyCredential | null)?.getClientExtensionResults() as { prf?: PrfResults } | undefined)?.prf;

/** Whether this browser can make passkeys at all. PRF support is only known once one is made. */
export const passkeysAvailable = () => typeof PublicKeyCredential !== "undefined" && !!navigator.credentials?.create && !/^\d+\.\d+\.\d+\.\d+$|^\[/.test(location.hostname);

async function prfSecret(credentialId: Uint8Array, salt: Uint8Array): Promise<ArrayBuffer> {
  const c = await navigator.credentials.get({
    publicKey: {
      challenge: buf(random(32)),
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: buf(credentialId) }],
      userVerification: "required",
      extensions: { prf: { eval: { first: buf(salt) } } } as AuthenticationExtensionsClientInputs,
    },
  });
  const first = prfOf(c)?.results?.first;
  if (!first) throw new PasskeyUnsupported();
  return first;
}

async function newPasskey(name: string, salt: Uint8Array): Promise<{ credentialId: Uint8Array; secret: ArrayBuffer }> {
  const c = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "Settle", id: location.hostname },
      user: { id: buf(random(16)), name, displayName: name },
      challenge: buf(random(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -8 },
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      extensions: { prf: { eval: { first: buf(salt) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!c) throw new Error("no passkey was made");
  const prf = prfOf(c);
  if (!prf?.enabled && !prf?.results?.first) throw new PasskeyUnsupported();
  const credentialId = new Uint8Array(c.rawId);
  // Some authenticators only evaluate PRF when signing in, not when the passkey is made.
  return { credentialId, secret: prf.results?.first ?? (await prfSecret(credentialId, salt)) };
}

// ---------------------------------------------------------------- unlocking

/** Accounts unlocked in this tab, so moving between pages never asks again. A reload does. */
const unlocked = new Map<string, Unlocked>();
export const unlockedAccount = (id: string) => unlocked.get(id);

export type Protection = { kind: "passkey" } | { kind: "passphrase"; passphrase: string };

async function lockFor(a: Pick<Account, "id" | "name">, seed: Uint8Array, how: Protection): Promise<{ lock: Lock; key: CryptoKey }> {
  const salt = random(32);
  if (how.kind === "passkey") {
    const { credentialId, secret } = await newPasskey(a.name, salt);
    const key = await keyFromPrf(secret, a.id);
    return { key, lock: { kind: "passkey", credentialId: toB64u(credentialId), salt: toB64u(salt), seed: await seal(key, seed, `${a.id}|seed`) } };
  }
  if (how.passphrase.length < 8) throw new Error("use a passphrase of at least 8 characters");
  const key = await keyFromPassphrase(how.passphrase, salt, PBKDF2_ROUNDS);
  return { key, lock: { kind: "passphrase", salt: toB64u(salt), iterations: PBKDF2_ROUNDS, seed: await seal(key, seed, `${a.id}|seed`) } };
}

/** Makes an account, its key sealed from the start. With `seed`, restores one from its backup code. */
export async function createAccount(name: string, how: Protection, seed: Uint8Array = random(32)): Promise<Unlocked> {
  const base = { id: crypto.randomUUID(), name: name.trim().slice(0, 60), created: new Date().toISOString(), did: identityFromSeed(seed).did };
  const { lock, key } = await lockFor(base, seed, how);
  const account: Account = { ...base, lock };
  upsert(account);
  const u = { account, seed, key };
  unlocked.set(account.id, u);
  return u;
}

/** Opens an account's key: the passkey prompt, or the passphrase. */
export async function unlock(a: Account, passphrase?: string): Promise<Unlocked> {
  const done = unlocked.get(a.id);
  if (done) return done;
  let u: Unlocked;
  if (!a.lock) {
    if (!a.seed) throw new Error("this account has no key");
    u = { account: a, seed: fromB64u(a.seed), key: null };
  } else {
    const key =
      a.lock.kind === "passkey"
        ? await keyFromPrf(await prfSecret(fromB64u(a.lock.credentialId), fromB64u(a.lock.salt)), a.id)
        : await keyFromPassphrase(passphrase ?? "", fromB64u(a.lock.salt), a.lock.iterations);
    let seed: Uint8Array;
    try {
      seed = await open(key, a.lock.seed, `${a.id}|seed`);
    } catch {
      throw new Error(a.lock.kind === "passphrase" ? "that passphrase isn't right" : "that passkey doesn't open this account");
    }
    u = { account: a, seed, key };
  }
  unlocked.set(a.id, u);
  return u;
}

/** Seals an account that kept its key in the clear, and forgets the clear copy. */
export async function protect(u: Unlocked, how: Protection): Promise<Unlocked> {
  const { lock, key } = await lockFor(u.account, u.seed, how);
  const account: Account = { ...u.account, lock, seed: undefined };
  delete account.seed;
  upsert(account);
  const next = { account, seed: u.seed, key };
  unlocked.set(account.id, next);
  return next;
}

export function lockAll(): void {
  unlocked.clear();
}

// ---------------------------------------------------------------- the account's saved state

/** Reads the account's saved state, opening it with the account's key. Accepts state saved in the clear by older versions. */
export async function readState<T>(u: Unlocked): Promise<T | null> {
  try {
    const raw = JSON.parse(localStorage.getItem(`settle.state.${u.account.did}`) ?? "null");
    if (!raw) return null;
    if (raw.sealed && u.key) return JSON.parse(new TextDecoder().decode(await open(u.key, raw.sealed, `${u.account.id}|state`))) as T;
    return raw.sealed ? null : (raw as T);
  } catch {
    return null;
  }
}

export async function writeState(u: Unlocked, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  const stored = u.key ? JSON.stringify({ sealed: await seal(u.key, utf8(json), `${u.account.id}|state`) }) : json;
  localStorage.setItem(`settle.state.${u.account.did}`, stored);
}

// ---------------------------------------------------------------- backups

const BACKUP_PREFIX = "settle-key-1-";
export const backupCode = (u: Unlocked) => BACKUP_PREFIX + toB64u(u.seed);

export function seedFromBackup(code: string): Uint8Array | null {
  const t = code.trim();
  if (!t.startsWith(BACKUP_PREFIX)) return null;
  try {
    const seed = fromB64u(t.slice(BACKUP_PREFIX.length));
    return seed.length === 32 ? seed : null;
  } catch {
    return null;
  }
}
