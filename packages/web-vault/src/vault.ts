/**
 * Where an account's key lives in the browser: sealed, never in the clear.
 *
 * The identity seed is encrypted with AES-GCM under a key that exists only while the account is unlocked:
 * - from a passkey, through the WebAuthn PRF extension (the authenticator derives a secret from the passkey
 *   and a salt; HKDF turns it into the AES key), so unlocking is Touch ID, Windows Hello or a security key;
 * - or, where the browser's passkeys can't do PRF, from a passphrase (PBKDF2-SHA256, 600,000 rounds).
 * The account's other data is sealed under the same key, as named blobs. Each sealed blob is bound to its
 * account and its name (AES-GCM associated data `<account id>|<name>`), so blobs can't be swapped.
 *
 * Storage, per app prefix `p`: `p.accounts` lists the accounts; `p.<name>.<did>` holds a blob.
 * Non-extractable CryptoKeys an app makes for an account are kept in IndexedDB (`p.keys`).
 *
 * Losing the passkey (or passphrase) loses the account, unless its backup code was kept.
 */
import { fromB64u, identityFromSeed, toB64u } from "@toip-tools/trust-core";

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

/** An account whose key is in memory: what a tab needs to act for it. */
export interface Unlocked {
  account: Account;
  seed: Uint8Array;
  /** Seals and opens this account's blobs. Null for an account that isn't protected yet. */
  key: CryptoKey | null;
}

export type Protection = { kind: "passkey" } | { kind: "passphrase"; passphrase: string };

export interface VaultConfig {
  /** Storage key prefix, one per app on an origin: letters, digits and dashes. */
  prefix: string;
  /** The passkey's relying-party name, shown in the passkey prompt. Default: the prefix. */
  rpName?: string;
  /** HKDF salt for the passkey-derived key. Default `<prefix>/account-key/v1`. */
  hkdfSalt?: string;
  /** Backup code prefix. Default `<prefix>-key-1-`. */
  backupPrefix?: string;
  /** PBKDF2 rounds for new passphrase locks. Default 600,000. */
  pbkdf2Rounds?: number;
  /** The account's DID from its seed. Default: the trust core's did:key. */
  didOf?: (seed: Uint8Array) => string;
  /** Default: `localStorage`. */
  storage?: Storage;
  /** Default: `navigator.credentials`. */
  credentials?: Pick<CredentialsContainer, "create" | "get">;
  /** The relying-party id. Default: `location.hostname`. */
  rpId?: string;
  /** Where CryptoKeys are kept. Default: `indexedDB`. */
  indexedDB?: IDBFactory;
}

export class PasskeyUnsupported extends Error {
  constructor() {
    super("this browser's passkeys can't protect a key yet (no PRF support)");
  }
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const buf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const BLOB_NAME = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED = new Set(["seed", "accounts", "keys"]);

async function seal(key: CryptoKey, plain: Uint8Array, aad: string): Promise<Sealed> {
  const iv = random(12);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, buf(plain)));
  return { iv: toB64u(iv), data: toB64u(data) };
}

async function open(key: CryptoKey, s: Sealed, aad: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(fromB64u(s.iv)), additionalData: utf8(aad) }, key, buf(fromB64u(s.data))));
}

async function keyFromPassphrase(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", buf(utf8(passphrase.normalize("NFKC"))), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: buf(salt), iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

type PrfResults = { enabled?: boolean; results?: { first?: ArrayBuffer } };
const prfOf = (c: Credential | null) => ((c as PublicKeyCredential | null)?.getClientExtensionResults() as { prf?: PrfResults } | undefined)?.prf;

/** Whether this browser can make passkeys at all. PRF support is only known once one is made. Passkeys need a domain, not an IP address. */
export const passkeysAvailable = () =>
  typeof PublicKeyCredential !== "undefined" && !!navigator.credentials?.create && !/^\d+\.\d+\.\d+\.\d+$|^\[/.test(location.hostname);

/**
 * Creates a browser account vault with its own storage namespace and unlocked-account cache.
 * Seeds and blobs are sealed with an AES-GCM key derived from a passkey's PRF output or a passphrase.
 * Unlocked seeds and keys remain accessible to application code in memory.
 * @param config App-specific prefix and optional protection, browser API, storage, and identity settings.
 * The prefix must contain only letters, digits, and dashes; use a distinct prefix per app on an origin.
 * @returns Account, sealed-blob, backup, and IndexedDB CryptoKey methods. Call `lockAll()` when locking the UI.
 * @throws If the storage prefix contains unsupported characters or is empty.
 */
export function createVault(config: VaultConfig) {
  const { prefix } = config;
  if (!/^[A-Za-z0-9-]+$/.test(prefix)) throw new Error("the vault prefix must be letters, digits and dashes");
  const ACCOUNTS = `${prefix}.accounts`;
  const rpName = config.rpName ?? prefix;
  const hkdfSalt = config.hkdfSalt ?? `${prefix}/account-key/v1`;
  const backupPrefix = config.backupPrefix ?? `${prefix}-key-1-`;
  const rounds = config.pbkdf2Rounds ?? 600_000;
  const didOf = config.didOf ?? ((seed: Uint8Array) => identityFromSeed(seed).did);
  const storage = () => config.storage ?? localStorage;
  const credentials = () => config.credentials ?? navigator.credentials;
  const rpId = () => config.rpId ?? location.hostname;
  const blobKey = (name: string, did: string) => `${prefix}.${name}.${did}`;

  // ------------------------------------------------------------ accounts

  /**
   * Lists saved account metadata without unlocking seeds or prompting for a passkey.
   * @returns Stored accounts, or an empty list when the account record cannot be read or decoded.
   */
  function accounts(): Account[] {
    try {
      const list = JSON.parse(storage().getItem(ACCOUNTS) ?? "[]") as Account[];
      // Accounts from before keys were sealed don't record their DID.
      return list.map((a) => (a.did || !a.seed ? a : { ...a, did: didOf(fromB64u(a.seed)) }));
    } catch {
      return [];
    }
  }

  const saveAccounts = (list: Account[]) => storage().setItem(ACCOUNTS, JSON.stringify(list));
  const upsert = (a: Account) => saveAccounts([...accounts().filter((x) => x.id !== a.id), a]);

  /**
   * Removes account metadata, this prefix's data for its DID, and its unlocked-cache entry.
   * Does not remove the authenticator's passkey. Local storage is cleared before IndexedDB cleanup completes.
   * @param id Saved account ID to remove; an unknown ID is a no-op.
   * @returns Completion of attempted CryptoKey deletion. IndexedDB cleanup failures are swallowed.
   */
  function removeAccount(id: string): Promise<void> {
    const a = accounts().find((x) => x.id === id);
    if (!a) return Promise.resolve();
    const s = storage();
    const mine = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k !== ACCOUNTS && k.startsWith(`${prefix}.`) && k.endsWith(`.${a.did}`)) mine.push(k);
    }
    for (const k of mine) s.removeItem(k);
    saveAccounts(accounts().filter((x) => x.id !== id));
    unlocked.delete(id);
    return deleteCryptoKeys(a).catch(() => undefined);
  }

  // ------------------------------------------------------------ passkeys

  async function keyFromPrf(secret: ArrayBuffer, accountId: string): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: buf(utf8(hkdfSalt)), info: buf(utf8(accountId)) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  async function prfSecret(credentialId: Uint8Array, salt: Uint8Array): Promise<ArrayBuffer> {
    const c = await credentials().get({
      publicKey: {
        challenge: buf(random(32)),
        rpId: rpId(),
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
    const c = (await credentials().create({
      publicKey: {
        rp: { name: rpName, id: rpId() },
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

  // ------------------------------------------------------------ unlocking

  /** Accounts unlocked in this tab, so moving between pages never asks again. A reload does. */
  const unlocked = new Map<string, Unlocked>();
  /**
   * Reads this vault instance's unlocked cache without prompting.
   * @param id Account ID to look up.
   * @returns The in-memory seed/key handle, or `undefined` if this vault has not unlocked it.
   */
  const unlockedAccount = (id: string) => unlocked.get(id);

  async function lockFor(a: Pick<Account, "id" | "name">, seed: Uint8Array, how: Protection): Promise<{ lock: Lock; key: CryptoKey }> {
    const salt = random(32);
    if (how.kind === "passkey") {
      const { credentialId, secret } = await newPasskey(a.name, salt);
      const key = await keyFromPrf(secret, a.id);
      return { key, lock: { kind: "passkey", credentialId: toB64u(credentialId), salt: toB64u(salt), seed: await seal(key, seed, `${a.id}|seed`) } };
    }
    if (how.passphrase.length < 8) throw new Error("use a passphrase of at least 8 characters");
    const key = await keyFromPassphrase(how.passphrase, salt, rounds);
    return { key, lock: { kind: "passphrase", salt: toB64u(salt), iterations: rounds, seed: await seal(key, seed, `${a.id}|seed`) } };
  }

  /**
   * Creates a saved account with its seed sealed from the start and caches its unlocked handle.
   * @param name Display name, trimmed and limited to 60 characters.
   * @param how Passkey protection or a passphrase of at least eight characters.
   * @param seed Identity seed to restore, normally decoded with `seedFromBackup`; defaults to 32 random bytes.
   * @returns The account metadata, plaintext seed, and derived sealing key.
   * @throws {PasskeyUnsupported} If the selected passkey does not provide usable PRF output.
   * @throws If passkey creation fails, the passphrase is too short, or cryptography/storage operations fail.
   */
  async function createAccount(name: string, how: Protection, seed: Uint8Array = random(32)): Promise<Unlocked> {
    const base = { id: crypto.randomUUID(), name: name.trim().slice(0, 60), created: new Date().toISOString(), did: didOf(seed) };
    const { lock, key } = await lockFor(base, seed, how);
    const account: Account = { ...base, lock };
    upsert(account);
    const u = { account, seed, key };
    unlocked.set(account.id, u);
    return u;
  }

  /**
   * Unlocks an account with its passkey or passphrase, reusing this instance's cached handle when present.
   * Legacy accounts with a clear seed return a handle with `key: null`; call `protect` to seal them.
   * @param a Saved account metadata from `accounts()`.
   * @param passphrase Required to decrypt a passphrase-protected account; unused for passkey protection.
   * @returns The account's plaintext seed and sealing key, also retained in the unlocked cache.
   * @throws {PasskeyUnsupported} If the passkey assertion provides no usable PRF output.
   * @throws If protection cannot open the seed, the account has no key, or the browser operation fails.
   */
  async function unlock(a: Account, passphrase?: string): Promise<Unlocked> {
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

  /**
   * Seals an account seed and removes the legacy clear seed from saved account metadata.
   * Existing blobs are not rewritten; rewriting them with `writeJson` seals them under the new key.
   * @param u Unlocked account whose seed will be protected.
   * @param how New passkey or passphrase protection.
   * @returns An updated saved account and cached unlocked handle with its sealing key.
   * @throws {PasskeyUnsupported} If passkey PRF output is unavailable.
   * @throws If protection, encryption, or persistence fails.
   */
  async function protect(u: Unlocked, how: Protection): Promise<Unlocked> {
    const { lock, key } = await lockFor(u.account, u.seed, how);
    const account: Account = { ...u.account, lock };
    delete account.seed;
    upsert(account);
    const next = { account, seed: u.seed, key };
    unlocked.set(account.id, next);
    return next;
  }

  /**
   * Clears this vault instance's unlocked cache. Seeds or keys retained by callers are not erased.
   */
  const lockAll = () => unlocked.clear();

  // ------------------------------------------------------------ sealed blobs

  function checkName(name: string) {
    if (!BLOB_NAME.test(name) || RESERVED.has(name)) throw new Error(`a blob name must be lowercase letters, digits and dashes, and not ${[...RESERVED].join(", ")}: ${JSON.stringify(name)}`);
  }

  /**
   * Reads bytes from a blob sealed to this account and blob name.
   * @param u Protected, unlocked account whose key decrypts the blob.
   * @param name Lowercase letters, digits, and dashes; `seed`, `accounts`, and `keys` are reserved.
   * @returns Decrypted bytes, or `null` when the blob is absent.
   * @throws If the name is invalid, the account is unprotected, or stored data cannot be parsed or decrypted.
   */
  async function readBlob(u: Unlocked, name: string): Promise<Uint8Array | null> {
    checkName(name);
    const raw = storage().getItem(blobKey(name, u.account.did));
    if (raw === null) return null;
    const v = JSON.parse(raw) as { sealed?: Sealed };
    if (!v?.sealed) throw new Error(`${name} isn't sealed`);
    if (!u.key) throw new Error("protect this account first");
    return open(u.key, v.sealed, `${u.account.id}|${name}`);
  }

  /**
   * Seals bytes with account/name-bound associated data and saves them in localStorage.
   * @param u Protected, unlocked account whose key seals the blob.
   * @param name Valid nonreserved blob name, as required by `readBlob`.
   * @param bytes Plaintext bytes to save.
   * @returns Completion of encryption and storage.
   * @throws If the name is invalid, the account is unprotected, or encryption/storage fails.
   */
  async function writeBlob(u: Unlocked, name: string, bytes: Uint8Array): Promise<void> {
    checkName(name);
    if (!u.key) throw new Error("protect this account first");
    storage().setItem(blobKey(name, u.account.did), JSON.stringify({ sealed: await seal(u.key, bytes, `${u.account.id}|${name}`) }));
  }

  /**
   * Reads a JSON blob. For an account that isn't protected yet, or a value written before it was,
   * the blob may be in the clear; that is accepted.
   * @param u Unlocked account; a sealing key is required when the stored value is encrypted.
   * @param name Valid nonreserved blob name.
   * @returns The parsed value, or `null` when absent. The generic type does not validate stored data.
   * @throws If the name is invalid or stored data cannot be read, decrypted, or parsed.
   */
  async function readJson<T>(u: Unlocked, name: string): Promise<T | null> {
    checkName(name);
    const raw = storage().getItem(blobKey(name, u.account.did));
    if (raw === null) return null;
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && "sealed" in v) {
      if (!u.key) throw new Error("protect this account first");
      return JSON.parse(new TextDecoder().decode(await open(u.key, v.sealed, `${u.account.id}|${name}`))) as T;
    }
    return v as T;
  }

  /**
   * Writes JSON sealed under the account's key, or in the clear for an unprotected legacy account.
   * @param u Unlocked account; call `protect` first when encryption is required.
   * @param name Valid nonreserved blob name.
   * @param value JSON-serializable value to save.
   * @returns Completion of serialization, optional encryption, and storage.
   * @throws If naming, JSON serialization, encryption, or storage fails.
   */
  async function writeJson(u: Unlocked, name: string, value: unknown): Promise<void> {
    checkName(name);
    const json = JSON.stringify(value);
    const stored = u.key ? JSON.stringify({ sealed: await seal(u.key, utf8(json), `${u.account.id}|${name}`) }) : json;
    storage().setItem(blobKey(name, u.account.did), stored);
  }

  function removeBlob(a: Account, name: string): void {
    checkName(name);
    storage().removeItem(blobKey(name, a.did));
  }

  /**
   * Reads the `state` JSON blob, accepting the legacy clear format.
   * @param u Unlocked account whose state is requested.
   * @returns Parsed state, or `null` when missing, unreadable, or unavailable without a sealing key.
   */
  async function readState<T>(u: Unlocked): Promise<T | null> {
    try {
      const raw = JSON.parse(storage().getItem(blobKey("state", u.account.did)) ?? "null");
      if (raw?.sealed && !u.key) return null;
      return await readJson<T>(u, "state");
    } catch {
      return null;
    }
  }

  const writeState = (u: Unlocked, value: unknown) => writeJson(u, "state", value);

  // ------------------------------------------------------------ CryptoKeys (IndexedDB)

  const STORE = "keys";
  function db(): Promise<IDBDatabase> {
    const factory = config.indexedDB ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
    if (!factory) return Promise.reject(new Error("IndexedDB isn't available"));
    return new Promise((resolve, reject) => {
      const req = factory.open(`${prefix}.keys`, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    const d = await db();
    try {
      return await new Promise<T | undefined>((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } finally {
      d.close();
    }
  }

  const cryptoKeyId = (a: Account, name: string) => `${a.id}|${name}`;

  /**
   * Keeps a CryptoKey, including a non-extractable key, in the app's IndexedDB key store.
   * This storage is separate from seed/blob encryption and does not require unlocking the account.
   * @param a Account that owns the key.
   * @param name Valid nonreserved key name.
   * @param key Browser CryptoKey to persist.
   * @returns Completion of the IndexedDB write transaction.
   * @throws If the name is invalid or IndexedDB is unavailable or fails.
   */
  async function putCryptoKey(a: Account, name: string, key: CryptoKey): Promise<void> {
    checkName(name);
    await tx("readwrite", (s) => s.put(key, cryptoKeyId(a, name)));
  }

  /**
   * Loads a saved CryptoKey without unlocking the account seed.
   * @param a Account that owns the key.
   * @param name Valid nonreserved key name.
   * @returns The stored key, or `null` when absent.
   * @throws If the name is invalid or IndexedDB is unavailable or fails.
   */
  async function getCryptoKey(a: Account, name: string): Promise<CryptoKey | null> {
    checkName(name);
    return ((await tx<CryptoKey>("readonly", (s) => s.get(cryptoKeyId(a, name)))) ?? null) as CryptoKey | null;
  }

  async function deleteCryptoKeys(a: Account): Promise<void> {
    if (!config.indexedDB && typeof indexedDB === "undefined") return;
    await tx("readwrite", (s) => {
      const all = s.getAllKeys();
      all.onsuccess = () => {
        for (const k of all.result) if (typeof k === "string" && k.startsWith(`${a.id}|`)) s.delete(k);
      };
    });
  }

  // ------------------------------------------------------------ backups

  /**
   * Encodes the plaintext identity seed as this app's backup code. Keep the result secret.
   * @param u Unlocked account to back up.
   * @returns An app-prefixed base64url seed; blobs and separately stored CryptoKeys are not included.
   */
  const backupCode = (u: Unlocked) => backupPrefix + toB64u(u.seed);

  /**
   * Decodes a backup for restoration with `createAccount` and fresh protection.
   * @param code Backup text, with optional surrounding whitespace.
   * @returns A 32-byte seed, or `null` for another prefix or invalid seed encoding/length.
   */
  function seedFromBackup(code: string): Uint8Array | null {
    const t = code.trim();
    if (!t.startsWith(backupPrefix)) return null;
    try {
      const seed = fromB64u(t.slice(backupPrefix.length));
      return seed.length === 32 ? seed : null;
    } catch {
      return null;
    }
  }

  return {
    prefix,
    accounts,
    removeAccount,
    createAccount,
    unlock,
    unlockedAccount,
    protect,
    lockAll,
    passkeysAvailable,
    readBlob,
    writeBlob,
    readJson,
    writeJson,
    removeBlob,
    readState,
    writeState,
    putCryptoKey,
    getCryptoKey,
    backupCode,
    seedFromBackup,
    /** The storage key of a blob, for data an app keeps outside the vault but wants removed with the account. */
    storageKey: blobKey,
  };
}

export type Vault = ReturnType<typeof createVault>;
