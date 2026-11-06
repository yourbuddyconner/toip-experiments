import { useState } from "react";
import { Field } from "../ui";
import { Wordmark } from "../App";
import {
  accounts,
  backupCode,
  createAccount,
  PasskeyUnsupported,
  passkeysAvailable,
  protect,
  seedFromBackup,
  unlock,
  type Account,
  type Protection,
  type Unlocked,
} from "../vault";

const message = (e: unknown) => {
  const err = e as Error;
  if (err?.name === "NotAllowedError") return "The passkey prompt was closed. Try again when you're ready.";
  if (err?.name === "InvalidStateError") return "That passkey is already in use. Try again.";
  return String(err?.message ?? e);
};

/** How the key is protected: a passkey where the browser can, otherwise (or by choice) a passphrase. */
function ProtectionFields({ usePassphrase, setUsePassphrase, passphrase, setPassphrase, reason }: {
  usePassphrase: boolean;
  setUsePassphrase: (v: boolean) => void;
  passphrase: string;
  setPassphrase: (v: string) => void;
  reason?: string;
}) {
  if (!usePassphrase)
    return (
      <p className="hint">
        Your key is sealed with a passkey: you unlock Settle with Touch ID, Windows Hello or your phone.{" "}
        <button type="button" className="linkish small" onClick={() => setUsePassphrase(true)}>
          Use a passphrase instead
        </button>
      </p>
    );
  return (
    <>
      {reason && <p className="notice">{reason}</p>}
      <Field label="Passphrase" hint="At least 8 characters. It seals your key in this browser; Settle never sees it, and can't reset it.">
        <input type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} minLength={8} />
      </Field>
      {passkeysAvailable() && !reason && (
        <p className="hint">
          <button type="button" className="linkish small" onClick={() => setUsePassphrase(false)}>
            Use a passkey instead
          </button>
        </p>
      )}
    </>
  );
}

/** Runs `make` with a passkey or a passphrase, falling back to a passphrase if the browser's passkeys can't seal a key. */
function useProtection() {
  const [usePassphrase, setUsePassphrase] = useState(!passkeysAvailable());
  const [passphrase, setPassphrase] = useState("");
  const [reason, setReason] = useState<string | undefined>(passkeysAvailable() ? undefined : "Passkeys need Settle at a web address (such as localhost), so this account uses a passphrase.");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const how: Protection = usePassphrase ? { kind: "passphrase", passphrase } : { kind: "passkey" };
  const run = async <T,>(make: (how: Protection) => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(undefined);
    try {
      return await make(how);
    } catch (e) {
      if (e instanceof PasskeyUnsupported) {
        setUsePassphrase(true);
        setReason("This browser's passkeys can't seal a key yet. Choose a passphrase instead.");
      } else setError(message(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const ready = !usePassphrase || passphrase.length >= 8;
  const fields = <ProtectionFields usePassphrase={usePassphrase} setUsePassphrase={setUsePassphrase} passphrase={passphrase} setPassphrase={setPassphrase} reason={reason} />;
  return { run, ready, busy, error, fields, usePassphrase };
}

export function Welcome({ locked, onOpen, title, placeholder }: { locked?: boolean; onOpen: (u: Unlocked) => void; title?: string; placeholder?: string }) {
  const [name, setName] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [code, setCode] = useState("");
  const p = useProtection();
  const list = accounts();
  const seed = restoring ? seedFromBackup(code) : undefined;
  return (
    <main className="welcome">
      <Wordmark />
      <h1>{title ?? "Get paid when the work is done."}</h1>
      <p className="lede">
        Settle holds a payment in an escrow that nobody controls alone, and releases it when the work is confirmed. Your keys stay in this browser, sealed.
      </p>
      {locked && <p className="notice">That account is open in another tab. Pick another, or close that tab first.</p>}
      <form
        className="welcome-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim() || (restoring && !seed)) return;
          const u = await p.run((how) => createAccount(name, how, seed ?? undefined));
          if (u) onOpen(u);
        }}
      >
        <Field label="Your name or your business's name" hint="People you pay or get paid by see this name.">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder ?? "Joe's Plumbing"} autoFocus maxLength={60} />
        </Field>
        {restoring && (
          <Field label="Backup code" hint={code && !seed ? "That isn't a Settle backup code." : "The code you saved from Profile, starting settle-key-1-."}>
            <input value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} autoComplete="off" className="mono" />
          </Field>
        )}
        {p.fields}
        {p.error && <p className="error">{p.error}</p>}
        <div className="actions">
          <button className="btn btn-primary" disabled={!name.trim() || !p.ready || p.busy || (restoring && !seed)}>
            {p.busy ? "Waiting for your passkey…" : restoring ? "Restore account" : p.usePassphrase ? "Create account" : "Create account with a passkey"}
          </button>
          <button type="button" className="linkish small" onClick={() => setRestoring(!restoring)}>
            {restoring ? "Make a new account instead" : "Restore from a backup code"}
          </button>
        </div>
      </form>
      {list.length > 0 && (
        <section className="account-list">
          <h2>Accounts in this browser</h2>
          <ul>
            {list.map((a) => (
              <li key={a.id}>
                <UnlockAccount account={a} onOpen={onOpen} />
              </li>
            ))}
          </ul>
          <p className="hint">Each tab can use a different account, so you can be the business in one tab and the customer in another.</p>
        </section>
      )}
    </main>
  );
}

/** One account in the list: opens with its passkey, or asks for its passphrase. */
export function UnlockAccount({ account, onOpen, primary }: { account: Account; onOpen: (u: Unlocked) => void; primary?: boolean }) {
  const [asking, setAsking] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const go = async (pass?: string) => {
    setBusy(true);
    setError(undefined);
    try {
      onOpen(await unlock(account, pass));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const kind = account.lock?.kind;
  return (
    <div className="unlock">
      {asking ? (
        <form
          className="unlock-pass"
          onSubmit={(e) => {
            e.preventDefault();
            void go(passphrase);
          }}
        >
          <Field label={`Passphrase for ${account.name}`}>
            <input type="password" autoComplete="current-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoFocus />
          </Field>
          <button className="btn btn-primary" disabled={busy || !passphrase}>
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </form>
      ) : (
        <button type="button" className={primary ? "btn btn-primary" : "linkish"} disabled={busy} onClick={() => (kind === "passphrase" ? setAsking(true) : void go())}>
          {primary ? `Unlock ${account.name}` : account.name}
        </button>
      )}
      {!primary && <span className="hint small">{kind === "passkey" ? " passkey" : kind === "passphrase" ? " passphrase" : " not protected"}</span>}
      {busy && kind === "passkey" && <span className="hint small"> Waiting for your passkey…</span>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** After a reload: the tab remembers which account it was using, but not its key. */
export function Unlock({ account, onOpen, onOther }: { account: Account; onOpen: (u: Unlocked) => void; onOther: () => void }) {
  return (
    <main className="welcome">
      <Wordmark />
      <h1>Welcome back, {account.name}.</h1>
      <p className="lede">{account.lock?.kind === "passphrase" ? "Enter your passphrase to unlock your account." : "Unlock your account with its passkey."}</p>
      <UnlockAccount account={account} onOpen={onOpen} primary />
      <p>
        <button type="button" className="linkish small" onClick={onOther}>
          Use another account
        </button>
      </p>
    </main>
  );
}

/** For an account from before keys were sealed: seal it now. */
export function ProtectBanner({ u, onProtected }: { u: Unlocked; onProtected: (u: Unlocked) => void }) {
  const p = useProtection();
  const [open, setOpen] = useState(false);
  if (u.account.lock) return null;
  return (
    <div className="notice protect">
      <p>
        <strong>This account's key isn't protected.</strong> Anyone with access to this browser could use it. Seal it with a passkey or a passphrase.
      </p>
      {open ? (
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            const next = await p.run((how) => protect(u, how));
            if (next) onProtected(next);
          }}
        >
          {p.fields}
          {p.error && <p className="error">{p.error}</p>}
          <button className="btn btn-primary" disabled={!p.ready || p.busy}>
            {p.busy ? "Waiting for your passkey…" : "Protect this account"}
          </button>
        </form>
      ) : (
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Protect it
        </button>
      )}
    </div>
  );
}

/** The account's backup code: the key itself, for restoring the account in another browser. */
export function Backup({ u }: { u: Unlocked }) {
  const [shown, setShown] = useState(false);
  return (
    <section className="section">
      <h2>Back up this account</h2>
      <p className="lede">
        Your key is sealed {u.account.lock?.kind === "passphrase" ? "with your passphrase" : u.account.lock ? "with your passkey" : "nowhere yet"}. If you lose that, or
        this browser's data, the backup code is the only way back into this account and any money in it. Keep it somewhere safe, like a password manager. Anyone with
        the code can use the account.
      </p>
      {shown ? (
        <>
          <p className="mono breakable backup-code">{backupCode(u)}</p>
          <button type="button" className="linkish small" onClick={() => setShown(false)}>
            Hide the backup code
          </button>
        </>
      ) : (
        <button type="button" className="btn" onClick={() => setShown(true)}>
          Show the backup code
        </button>
      )}
    </section>
  );
}
