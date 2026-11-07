import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { fromB64u, identityFromSeed, toB64u } from "@toip-tools/trust-core";
import { createVault, PasskeyUnsupported, type Vault, type VaultConfig } from "../src/index";
import { FakeAuthenticator, MemoryStorage, type AuthenticatorOptions } from "./fakes";

let storage: MemoryStorage;
let auth: FakeAuthenticator;

function vault(over: Partial<VaultConfig> = {}, a: AuthenticatorOptions = {}): Vault {
  auth = new FakeAuthenticator(a);
  return createVault({ prefix: "app", storage, credentials: auth.api, rpId: "localhost", pbkdf2Rounds: 1000, indexedDB: new IDBFactory(), ...over });
}

beforeEach(() => {
  storage = new MemoryStorage();
});

const pass = (passphrase: string) => ({ kind: "passphrase" as const, passphrase });

describe("accounts", () => {
  it("makes an account sealed with a passkey, and opens it again after a reload", async () => {
    const v = vault();
    const u = await v.createAccount("  Shop  ", { kind: "passkey" });
    expect(u.account.name).toBe("Shop");
    expect(u.account.did).toBe(identityFromSeed(u.seed).did);
    expect(u.account.lock?.kind).toBe("passkey");
    expect(u.key).not.toBeNull();
    expect(storage.getItem("app.accounts")).not.toContain(toB64u(u.seed));

    const create = auth.calls[0].options as CredentialCreationOptions;
    expect(create.publicKey?.rp).toEqual({ name: "app", id: "localhost" });
    expect(create.publicKey?.authenticatorSelection?.userVerification).toBe("required");

    // A reload: a new vault on the same storage and authenticator.
    const again = createVault({ prefix: "app", storage, credentials: auth.api, rpId: "localhost" });
    const [a] = again.accounts();
    expect(again.unlockedAccount(a.id)).toBeUndefined();
    const opened = await again.unlock(a);
    expect(opened.seed).toEqual(u.seed);
    const get = auth.calls.at(-1)!.options as CredentialRequestOptions;
    expect(get.publicKey?.userVerification).toBe("required");
    expect(get.publicKey?.rpId).toBe("localhost");
  });

  it("asks the passkey again for PRF when it gave none at creation", async () => {
    const v = vault({}, { prfOnlyOnGet: true });
    const u = await v.createAccount("A", { kind: "passkey" });
    expect(auth.calls.map((c) => c.op)).toEqual(["create", "get"]);
    v.lockAll();
    expect((await v.unlock(u.account)).seed).toEqual(u.seed);
  });

  it("says so when the passkey can't do PRF", async () => {
    const v = vault({}, { noPrf: true });
    await expect(v.createAccount("A", { kind: "passkey" })).rejects.toBeInstanceOf(PasskeyUnsupported);
    expect(v.accounts()).toEqual([]);
  });

  it("makes an account sealed with a passphrase, and refuses the wrong one", async () => {
    const v = vault();
    const u = await v.createAccount("A", pass("correct horse"));
    expect(u.account.lock).toMatchObject({ kind: "passphrase", iterations: 1000 });
    v.lockAll();
    await expect(v.unlock(u.account, "wrong horse")).rejects.toThrow("that passphrase isn't right");
    await expect(v.unlock(u.account)).rejects.toThrow("that passphrase isn't right");
    expect((await v.unlock(u.account, "correct horse")).seed).toEqual(u.seed);
  });

  it("uses 600,000 PBKDF2 rounds by default", async () => {
    const v = createVault({ prefix: "app", storage, credentials: new FakeAuthenticator().api, rpId: "localhost" });
    const u = await v.createAccount("A", pass("correct horse"));
    expect(u.account.lock).toMatchObject({ iterations: 600_000 });
  });

  it("refuses a short passphrase", async () => {
    await expect(vault().createAccount("A", pass("short"))).rejects.toThrow(/at least 8/);
  });

  it("keeps unlocked accounts for the tab until lockAll", async () => {
    const v = vault();
    const u = await v.createAccount("A", pass("correct horse"));
    expect(v.unlockedAccount(u.account.id)).toBe(u);
    expect(await v.unlock(u.account, "anything")).toBe(u);
    v.lockAll();
    expect(v.unlockedAccount(u.account.id)).toBeUndefined();
  });

  it("removes an account and everything stored for it", async () => {
    const v = vault();
    const a = await v.createAccount("A", pass("correct horse"));
    const b = await v.createAccount("B", pass("correct horse"));
    await v.writeJson(a, "state", { n: 1 });
    await v.writeJson(b, "state", { n: 2 });
    storage.setItem(`app.outbox.${a.account.did}`, "[]");
    storage.setItem("other.state." + a.account.did, "keep");
    await v.removeAccount(a.account.id);
    expect(v.accounts().map((x) => x.name)).toEqual(["B"]);
    expect(storage.keys().filter((k) => k.endsWith(a.account.did))).toEqual(["other.state." + a.account.did]);
    expect(v.unlockedAccount(a.account.id)).toBeUndefined();
    expect(await v.readJson(b, "state")).toEqual({ n: 2 });
  });
});

describe("sealed blobs", () => {
  it("seals named blobs, as JSON or bytes, never in the clear", async () => {
    const v = vault();
    const u = await v.createAccount("A", pass("correct horse"));
    await v.writeJson(u, "credentials", [{ secret: "s3cret-value" }]);
    await v.writeBlob(u, "session-key", new Uint8Array([1, 2, 3]));
    expect(storage.getItem(`app.credentials.${u.account.did}`)).not.toContain("s3cret-value");
    expect(JSON.parse(storage.getItem(`app.credentials.${u.account.did}`)!)).toHaveProperty("sealed.iv");
    expect(await v.readJson(u, "credentials")).toEqual([{ secret: "s3cret-value" }]);
    expect(await v.readBlob(u, "session-key")).toEqual(new Uint8Array([1, 2, 3]));
    expect(await v.readBlob(u, "missing")).toBeNull();
    v.removeBlob(u.account, "session-key");
    expect(await v.readBlob(u, "session-key")).toBeNull();
  });

  it("binds each blob to its account: A's blob doesn't open as B's", async () => {
    const v = vault();
    const a = await v.createAccount("A", pass("correct horse"));
    const b = await v.createAccount("B", pass("correct horse"));
    await v.writeJson(a, "state", { owner: "A" });
    storage.setItem(`app.state.${b.account.did}`, storage.getItem(`app.state.${a.account.did}`)!);
    await expect(v.readJson(b, "state")).rejects.toThrow();
    expect(await v.readState(b)).toBeNull();
  });

  it("binds each blob to its account even under the same key", async () => {
    const v = vault();
    const a = await v.createAccount("A", pass("correct horse"));
    await v.writeJson(a, "state", { owner: "A" });
    // B shares A's AES key but has another id: the AAD still differs.
    const b = { ...a, account: { ...a.account, id: "another-id", did: "did:key:other" } };
    storage.setItem(`app.state.${b.account.did}`, storage.getItem(`app.state.${a.account.did}`)!);
    await expect(v.readJson(b, "state")).rejects.toThrow();
  });

  it("binds each blob to its name: one purpose can't be read as another", async () => {
    const v = vault();
    const u = await v.createAccount("A", pass("correct horse"));
    await v.writeJson(u, "receipts", ["r1"]);
    storage.setItem(`app.credentials.${u.account.did}`, storage.getItem(`app.receipts.${u.account.did}`)!);
    await expect(v.readJson(u, "credentials")).rejects.toThrow();
  });

  it("refuses names that would clash with the seed or the storage layout", async () => {
    const v = vault();
    const u = await v.createAccount("A", pass("correct horse"));
    for (const name of ["seed", "accounts", "a.b", "a|b", "", "Upper"]) await expect(v.writeJson(u, name, 1), name).rejects.toThrow(/name/);
  });

  it("keeps state in the clear for an account that isn't protected yet, then seals it when protected", async () => {
    const v = vault();
    const seed = crypto.getRandomValues(new Uint8Array(32));
    storage.setItem("app.accounts", JSON.stringify([{ id: "legacy-1", name: "Old", seed: toB64u(seed), created: "2026-01-01T00:00:00Z" }]));
    const [old] = v.accounts();
    expect(old.did).toBe(identityFromSeed(seed).did);
    const u = await v.unlock(old);
    expect(u.key).toBeNull();
    await v.writeState(u, { n: 1 });
    expect(JSON.parse(storage.getItem(`app.state.${old.did}`)!)).toEqual({ n: 1 });
    expect(await v.readState(u)).toEqual({ n: 1 });
    await expect(v.writeBlob(u, "bytes", new Uint8Array(1))).rejects.toThrow(/protect/);

    const p = await v.protect(u, pass("correct horse"));
    expect(p.account.seed).toBeUndefined();
    expect(storage.getItem("app.accounts")).not.toContain(toB64u(seed));
    expect(await v.readState(p)).toEqual({ n: 1 }); // the clear copy still reads
    await v.writeState(p, { n: 2 });
    expect(storage.getItem(`app.state.${old.did}`)).toContain("sealed");
    v.lockAll();
    expect(await v.readState(await v.unlock(v.accounts()[0], "correct horse"))).toEqual({ n: 2 });
  });
});

describe("backup codes", () => {
  it("round-trips the seed and restores the same identity", async () => {
    const v = vault();
    const u = await v.createAccount("A", pass("correct horse"));
    const code = v.backupCode(u);
    expect(code.startsWith("app-key-1-")).toBe(true);
    const seed = v.seedFromBackup(`  ${code}\n`);
    expect(seed).toEqual(u.seed);
    const restored = await v.createAccount("A again", pass("another phrase"), seed!);
    expect(restored.account.did).toBe(u.account.did);
    expect(restored.account.id).not.toBe(u.account.id);
  });

  it("refuses codes that aren't this app's, or aren't 32 bytes", () => {
    const v = vault();
    expect(v.seedFromBackup("other-key-1-" + toB64u(new Uint8Array(32)))).toBeNull();
    expect(v.seedFromBackup("app-key-1-" + toB64u(new Uint8Array(31)))).toBeNull();
    expect(v.seedFromBackup("app-key-1-!!!")).toBeNull();
    expect(v.seedFromBackup("")).toBeNull();
  });
});

describe("prefix isolation", () => {
  it("keeps two apps on one origin apart", async () => {
    const shared = new FakeAuthenticator();
    const agora = createVault({ prefix: "agora", storage, credentials: shared.api, rpId: "localhost", pbkdf2Rounds: 1000 });
    const tipline = createVault({ prefix: "tipline", storage, credentials: shared.api, rpId: "localhost", pbkdf2Rounds: 1000 });
    const a = await agora.createAccount("A", { kind: "passkey" });
    await agora.writeJson(a, "state", { app: "agora" });
    expect(tipline.accounts()).toEqual([]);
    expect(agora.accounts()).toHaveLength(1);
    expect(storage.keys().sort()).toEqual(["agora.accounts", `agora.state.${a.account.did}`]);

    // Same seed in both apps: each keeps its own state, and removing one leaves the other.
    const t = await tipline.createAccount("T", { kind: "passkey" }, a.seed);
    await tipline.writeJson(t, "state", { app: "tipline" });
    expect(await agora.readJson(a, "state")).toEqual({ app: "agora" });
    expect(await tipline.readJson(t, "state")).toEqual({ app: "tipline" });
    await tipline.removeAccount(t.account.id);
    expect(await agora.readJson(a, "state")).toEqual({ app: "agora" });
    expect(tipline.backupCode(a)).toMatch(/^tipline-key-1-/);
    expect(tipline.seedFromBackup(agora.backupCode(a))).toBeNull();
  });

  it("derives a different key per app from the same passkey secret", async () => {
    const shared = new FakeAuthenticator();
    const one = createVault({ prefix: "one", storage, credentials: shared.api, rpId: "localhost" });
    const u = await one.createAccount("A", { kind: "passkey" });
    await one.writeJson(u, "state", { x: 1 });
    // Another app adopting the same account record and passkey still can't open it: its HKDF salt differs.
    storage.setItem("two.accounts", storage.getItem("one.accounts")!);
    const two = createVault({ prefix: "two", storage, credentials: shared.api, rpId: "localhost" });
    await expect(two.unlock(two.accounts()[0])).rejects.toThrow("that passkey doesn't open this account");
  });

  it("refuses a prefix with a dot", () => {
    expect(() => createVault({ prefix: "a.b", storage })).toThrow(/prefix/);
  });
});

describe("non-extractable keys next to the sealed seed (IndexedDB)", () => {
  it("stores and finds a CryptoKey per account and name, and removes it with the account", async () => {
    const v = vault();
    const u = await v.createAccount("A", pass("correct horse"));
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    await v.putCryptoKey(u.account, "capture", pair.privateKey);
    const back = await v.getCryptoKey(u.account, "capture");
    expect(back?.extractable).toBe(false);
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, back!, new Uint8Array([1]));
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, sig, new Uint8Array([1]))).toBe(true);
    expect(await v.getCryptoKey(u.account, "other")).toBeNull();
    await v.removeAccount(u.account.id);
    expect(await v.getCryptoKey(u.account, "capture")).toBeNull();
  });
});

describe("Settle's on-disk format", () => {
  // What Settle's web/src/vault.ts wrote before the move, rebuilt with plain WebCrypto.
  const utf8 = (s: string) => new TextEncoder().encode(s);
  async function settleSeal(key: CryptoKey, plain: Uint8Array, aad: string) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, plain as Uint8Array<ArrayBuffer>));
    return { iv: toB64u(iv), data: toB64u(data) };
  }

  it("opens a passphrase account and its state as Settle stored them", async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const id = crypto.randomUUID();
    const base = await crypto.subtle.importKey("raw", utf8("correct horse".normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 2000 }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const did = identityFromSeed(seed).did;
    const lock = { kind: "passphrase", salt: toB64u(salt), iterations: 2000, seed: await settleSeal(key, seed, `${id}|seed`) };
    storage.setItem("settle.accounts", JSON.stringify([{ id, name: "Shop", created: "2026-10-01T00:00:00.000Z", did, lock }]));
    storage.setItem(`settle.state.${did}`, JSON.stringify({ sealed: await settleSeal(key, utf8(JSON.stringify({ networkId: "n1" })), `${id}|state`) }));

    const v = createVault({ prefix: "settle", rpName: "Settle", storage, credentials: new FakeAuthenticator().api, rpId: "localhost" });
    const u = await v.unlock(v.accounts()[0], "correct horse");
    expect(u.seed).toEqual(seed);
    expect(await v.readState(u)).toEqual({ networkId: "n1" });
    expect(v.backupCode(u)).toBe("settle-key-1-" + toB64u(seed));
  });

  it("opens a passkey account as Settle stored it (HKDF salt settle/account-key/v1, info = account id)", async () => {
    const a = new FakeAuthenticator();
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const made = await a.api.create({ publicKey: { extensions: { prf: { eval: { first: salt } } } } as unknown as PublicKeyCredentialCreationOptions });
    const credentialId = new Uint8Array((made as PublicKeyCredential).rawId);
    const secret = (made as PublicKeyCredential).getClientExtensionResults() as { prf: { results: { first: ArrayBuffer } } };
    const id = crypto.randomUUID();
    const hk = await crypto.subtle.importKey("raw", secret.prf.results.first, "HKDF", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: utf8("settle/account-key/v1"), info: utf8(id) }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const lock = { kind: "passkey", credentialId: toB64u(credentialId), salt: toB64u(salt), seed: await settleSeal(key, seed, `${id}|seed`) };
    storage.setItem("settle.accounts", JSON.stringify([{ id, name: "Shop", created: "2026-10-01T00:00:00.000Z", did: identityFromSeed(seed).did, lock }]));

    const v = createVault({ prefix: "settle", rpName: "Settle", storage, credentials: a.api, rpId: "localhost" });
    const u = await v.unlock(v.accounts()[0]);
    expect(u.seed).toEqual(seed);
    // And what the vault writes now, Settle's old code reads.
    await v.writeState(u, { networkId: "n2" });
    const raw = JSON.parse(storage.getItem(`settle.state.${u.account.did}`)!);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64u(raw.sealed.iv) as Uint8Array<ArrayBuffer>, additionalData: utf8(`${id}|state`) }, key, fromB64u(raw.sealed.data) as Uint8Array<ArrayBuffer>);
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual({ networkId: "n2" });
  });
});
