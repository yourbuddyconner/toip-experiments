# @zk-toip/web-vault

Keeps an account's identity seed in the browser, sealed. It was Settle's `web/src/vault.ts`. Now Settle, Agora, Tipline and Capture can share it.

- **Passkey (preferred).** The WebAuthn PRF extension makes the passkey give a secret for a stored salt. HKDF-SHA-256 turns the secret into an AES-GCM key. Unlocking is Touch ID, Windows Hello or a security key.
- **Passphrase (fallback).** PBKDF2-SHA256, 600,000 rounds, for browsers whose passkeys can't do PRF, or pages that are not at a domain.
- **Sealed blobs.** Other data for the account (state, credentials, receipts, session keys) is sealed under the same key. Each blob is bound to its account and its name.
- **Backup code.** The seed as text. It restores the account in another browser. Without it, losing the passkey loses the account.
- **CryptoKeys.** A non-extractable `CryptoKey` (such as Capture's capture key) can be kept in IndexedDB next to the sealed seed.

## Use

```ts
import { createVault, PasskeyUnsupported } from "@zk-toip/web-vault";

const vault = createVault({ prefix: "agora", rpName: "Agora" });

let u;
try {
  u = await vault.createAccount("Ana", { kind: "passkey" });
} catch (e) {
  if (!(e instanceof PasskeyUnsupported)) throw e;
  u = await vault.createAccount("Ana", { kind: "passphrase", passphrase });
}

await vault.writeJson(u, "credentials", [vc]);
await vault.writeBlob(u, "session-key", bytes);

// After a reload:
const [account] = vault.accounts();
const again = await vault.unlock(account);            // passkey prompt
const creds = await vault.readJson(again, "credentials");
```

## API

`createVault(config)` returns a vault. Each vault keeps its own list of unlocked accounts.

Config:
- `prefix` (required): letters, digits and dashes. One per app on an origin.
- `rpName`: the name in the passkey prompt. Default: the prefix.
- `hkdfSalt`: default `<prefix>/account-key/v1`.
- `backupPrefix`: default `<prefix>-key-1-`.
- `pbkdf2Rounds`: default 600,000.
- `didOf(seed)`: default the trust core's did:key.
- `storage`, `credentials`, `rpId`, `indexedDB`: default `localStorage`, `navigator.credentials`, `location.hostname`, `indexedDB`. Tests pass stand-ins.

Accounts:
- `accounts()`: the accounts in this browser.
- `createAccount(name, how, seed?)`: makes an account, sealed from the start. `how` is `{ kind: "passkey" }` or `{ kind: "passphrase", passphrase }`. With `seed`, it restores an account from its backup code. Throws `PasskeyUnsupported` if the passkey has no PRF.
- `unlock(account, passphrase?)`: opens the seed. Returns `{ account, seed, key }`.
- `unlockedAccount(id)`, `lockAll()`: accounts stay unlocked in a tab until a reload or `lockAll()`.
- `protect(unlocked, how)`: seals an account that kept its seed in the clear (made by old Settle versions), and removes the clear copy.
- `removeAccount(id)`: removes the account, every `<prefix>.<name>.<did>` storage key for its DID, and its CryptoKeys.
- `passkeysAvailable()`: whether the browser can make passkeys here. It is false at an IP address.

Sealed blobs (names: lowercase letters, digits and dashes; `seed`, `accounts` and `keys` are reserved):
- `writeBlob(u, name, bytes)`, `readBlob(u, name)`: bytes. Needs a protected account.
- `writeJson(u, name, value)`, `readJson(u, name)`: JSON. For an account that isn't protected yet, the value is kept in the clear.
- `removeBlob(account, name)`.
- `readState(u)`, `writeState(u, value)`: the `state` blob. `readState` returns null when the blob is missing or doesn't open.
- `storageKey(name, did)`: the storage key for a name, for data an app keeps itself (Settle's outbox) and wants removed with the account.

`readBlob` and `readJson` return null when there is no blob. They throw when the blob doesn't open: another account's blob, another name's blob, or a changed one.

CryptoKeys:
- `putCryptoKey(account, name, key)`, `getCryptoKey(account, name)`: in the IndexedDB database `<prefix>.keys`.

Backups:
- `backupCode(u)`: `<backupPrefix><base64url seed>`.
- `seedFromBackup(code)`: the seed, or null if the code isn't this app's.

## Storage format

| What | Where | AES-GCM associated data |
|---|---|---|
| account list | `localStorage["<prefix>.accounts"]`, JSON | none; the seed inside each lock is sealed with `<account id>\|seed` |
| a blob | `localStorage["<prefix>.<name>.<did>"]`, JSON `{ "sealed": { "iv", "data" } }` | `<account id>\|<name>` |
| a CryptoKey | IndexedDB `<prefix>.keys`, store `keys`, key `<account id>\|<name>` | none (the browser keeps it) |

With `prefix: "settle"`, `rpName: "Settle"`, this is the format Settle used before the move. Accounts made then still open. The tests check this with accounts built the way the old code built them.

## Tests

`npm test` runs in Node with an in-memory `localStorage`, a fake PRF authenticator and `fake-indexeddb`. They cover sealing and unsealing, a wrong passphrase, blobs swapped between accounts or names, backup codes, two apps on one origin, Settle's format, and CryptoKeys. Settle's browser test (`npm run e2e --workspace @zk-toip/settle`) covers real passkeys with PRF in Chromium.

## Differences from the design

- The package is `packages/web-vault`, as Tipline names it. Agora and Capture called it `packages/vault`.
- It is a factory, `createVault(config)`, not module functions. Two apps on one origin need separate lists of unlocked accounts.
- The HKDF salt and the backup code prefix follow the storage prefix. So the same passkey gives a different key in each app, and one app's backup code is refused by another.
- `seed`, `accounts` and `keys` can't be blob names. A blob named `seed` would have the same associated data as the seed.
- `removeAccount` now returns a promise, for the IndexedDB part. The storage part is done before it returns.
- CryptoKeys are not sealed: they can't be exported, so the browser keeps them as they are. They are only as safe as the browser profile.
