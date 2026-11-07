/**
 * Where an account's key lives in the browser: sealed with a passkey or a passphrase, never in the clear
 * (design §18). The vault itself is `@zk-toip/web-vault`; this is Settle's configuration of it. The prefix,
 * passkey name, HKDF salt and backup code prefix keep the storage format of accounts made before the move.
 */
import { createVault } from "@zk-toip/web-vault";

export { PasskeyUnsupported, passkeysAvailable, type Account, type Lock, type Protection, type Sealed, type Unlocked } from "@zk-toip/web-vault";

export const vault = createVault({ prefix: "settle", rpName: "Settle", hkdfSalt: "settle/account-key/v1", backupPrefix: "settle-key-1-" });

export const { accounts, removeAccount, createAccount, unlock, unlockedAccount, protect, lockAll, readState, writeState, backupCode, seedFromBackup } = vault;
