/** Making or unlocking an account in the vault: a passkey when the browser can, a passphrase otherwise. */
import { useState } from "react";
import { PasskeyUnsupported, type Unlocked } from "@toip-tools/web-vault";
import { vault } from "../app";

export function useRoleAccount(role: "camera" | "editor") {
  const key = `capture.role.${role}`;
  const id = localStorage.getItem(key);
  const account = vault.accounts().find((a) => a.id === id);
  return {
    account,
    remember: (u: Unlocked) => localStorage.setItem(key, u.account.id),
    forget: () => localStorage.removeItem(key),
  };
}

export function CreateAccount(props: { nameLabel: string; defaultName: string; cta: string; onDone: (u: Unlocked, name: string) => Promise<void> }) {
  const [name, setName] = useState(props.defaultName);
  const [passphrase, setPassphrase] = useState("");
  const [usePhrase, setUsePhrase] = useState(!vault.passkeysAvailable());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      let u: Unlocked;
      if (usePhrase) {
        if (passphrase.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
        u = await vault.createAccount(name, { kind: "passphrase", passphrase });
      } else {
        try {
          u = await vault.createAccount(name, { kind: "passkey" });
        } catch (e) {
          if (e instanceof PasskeyUnsupported) {
            setUsePhrase(true);
            throw new Error("This browser's passkeys can't seal keys here. Use a passphrase instead.");
          }
          throw e;
        }
      }
      await props.onDone(u, name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="panel"
      style={{ display: "grid", gap: 12, maxWidth: 520 }}
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <label className="field">
        {props.nameLabel}
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
      </label>
      {usePhrase && (
        <label className="field">
          Passphrase
          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="new-password" />
        </label>
      )}
      <div className="row">
        <button type="submit" disabled={busy || !name.trim()}>
          {busy ? "Working…" : usePhrase ? props.cta : `${props.cta} with a passkey`}
        </button>
        {!usePhrase && (
          <button type="button" className="quiet" onClick={() => setUsePhrase(true)}>
            Use a passphrase instead
          </button>
        )}
      </div>
      {error && (
        <p className="notice bad" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function UnlockAccount(props: { account: NonNullable<ReturnType<typeof useRoleAccount>["account"]>; onUnlocked: (u: Unlocked) => Promise<void>; onForget: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const phrase = props.account.lock?.kind === "passphrase";
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      await props.onUnlocked(await vault.unlock(props.account, phrase ? passphrase : undefined));
    } catch (e) {
      setError(phrase ? "That passphrase doesn't open this account." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="panel"
      style={{ display: "grid", gap: 12, maxWidth: 520 }}
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <p>
        <strong>{props.account.name}</strong> is locked in this browser.
      </p>
      {phrase && (
        <label className="field">
          Passphrase
          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="current-password" autoFocus />
        </label>
      )}
      <div className="row">
        <button type="submit" disabled={busy}>
          Unlock {props.account.name}
        </button>
        <button type="button" className="quiet" onClick={props.onForget}>
          Start over
        </button>
      </div>
      {error && (
        <p className="notice bad" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
