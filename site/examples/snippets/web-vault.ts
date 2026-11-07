// In a browser: keep an account's identity seed sealed by a passkey, with a passphrase fallback.
import { PasskeyUnsupported, createVault } from "@toip-tools/web-vault";
import { identityFromSeed } from "@toip-tools/trust-core";

const vault = createVault({ prefix: "garden", rpName: "Community Garden" });

export async function signUp(name: string, passphrase: string) {
  try {
    return await vault.createAccount(name, { kind: "passkey" }); // Touch ID, Windows Hello, a security key
  } catch (e) {
    if (!(e instanceof PasskeyUnsupported)) throw e;
    return await vault.createAccount(name, { kind: "passphrase", passphrase });
  }
}

export async function signInAgain() {
  const [account] = vault.accounts();
  const unlocked = await vault.unlock(account); // the passkey prompt
  const me = identityFromSeed(unlocked.seed);
  await vault.writeJson(unlocked, "credentials", []); // sealed under the same key, bound to this account
  return { me, backup: vault.backupCode(unlocked) }; // show once; it restores the account elsewhere
}
