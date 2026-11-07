/** Accounts in this browser: create one with a passkey, unlock one, or restore one from a backup code. */
import { useState } from "react";
import { PasskeyUnsupported } from "@toip-tools/web-vault";
import { vault } from "../services";
import { navigate } from "../router";
import { useApp } from "../state";
import { Notice } from "../ui";

export function AccountPage() {
  const { session, signIn } = useApp();
  const [name, setName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [code, setCode] = useState("");
  const [restoreName, setRestoreName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const [unlockPass, setUnlockPass] = useState("");
  const accounts = vault.accounts();
  const next = new URLSearchParams(location.search).get("next") ?? "/wallet";

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof PasskeyUnsupported) {
        setUsePassphrase(true);
        setError("This browser's passkeys can't seal a key here. Use a passphrase instead.");
      } else setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    act(async () => {
      const how = usePassphrase ? { kind: "passphrase" as const, passphrase } : { kind: "passkey" as const };
      const u = await vault.createAccount(name.trim(), how);
      await signIn(u);
      navigate(next);
    });

  const restore = () =>
    act(async () => {
      const seed = vault.seedFromBackup(code);
      if (!seed) throw new Error("That isn't an Agora backup code. It starts with agora-key-1-.");
      const u = await vault.createAccount(restoreName.trim() || "Restored account", { kind: "passkey" }, seed);
      await signIn(u);
      navigate("/wallet?restored=1");
    });

  if (session) {
    return (
      <section className="narrow">
        <h1 tabIndex={-1}>Your account</h1>
        <p>
          Signed in as <strong>{session.name}</strong>. Your account's DID is <code className="did">{session.client.did}</code>. Only issuers you ask for a
          credential, and the groups you join, ever see it. Forums never do.
        </p>
        <h2>Backup code</h2>
        <p>The backup code restores this account, its identity secret and so its pseudonyms, in another browser. Keep it somewhere safe. Anyone with it can post as you.</p>
        {showCode ? (
          <p>
            <label htmlFor="backup">Backup code</label>
            <input id="backup" className="mono" readOnly value={vault.backupCode(session.unlocked)} onFocus={(e) => e.currentTarget.select()} />
          </p>
        ) : (
          <button type="button" className="btn" onClick={() => setShowCode(true)}>
            Show backup code
          </button>
        )}
      </section>
    );
  }

  return (
    <section className="narrow">
      <h1 tabIndex={-1}>Sign in to Agora</h1>
      <p className="lede">Reading needs no account. To post or vote, you need credentials in a wallet, and the wallet lives in this browser, sealed with a passkey.</p>
      {error && <Notice tone="error">{error}</Notice>}

      {accounts.length > 0 && (
        <div className="panel">
          <h2>Accounts in this browser</h2>
          <ul className="plain">
            {accounts.map((a) => (
              <li key={a.id} className="account-row">
                {unlocking === a.id && a.lock?.kind === "passphrase" ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(async () => {
                        await signIn(await vault.unlock(a, unlockPass));
                        navigate(next);
                      });
                    }}
                  >
                    <label htmlFor={`pp-${a.id}`}>Passphrase for {a.name}</label>
                    <input id={`pp-${a.id}`} type="password" value={unlockPass} onChange={(e) => setUnlockPass(e.target.value)} autoFocus />
                    <button className="btn" disabled={busy}>
                      Unlock
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      a.lock?.kind === "passphrase"
                        ? setUnlocking(a.id)
                        : void act(async () => {
                            await signIn(await vault.unlock(a));
                            navigate(next);
                          })
                    }
                  >
                    Unlock {a.name}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <h2>Create an account</h2>
        <label htmlFor="name">Your name</label>
        <p className="hint" id="name-hint">
          Only this browser shows it. Forums never see it.
        </p>
        <input id="name" aria-describedby="name-hint" required value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        {usePassphrase && (
          <>
            <label htmlFor="passphrase">Passphrase</label>
            <input id="passphrase" type="password" required minLength={8} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </>
        )}
        <div className="row">
          <button className="btn btn-primary" disabled={busy || !name.trim()}>
            {usePassphrase ? "Create account" : "Create account with a passkey"}
          </button>
          {!usePassphrase && (
            <button type="button" className="btn btn-quiet" onClick={() => setUsePassphrase(true)}>
              Use a passphrase instead
            </button>
          )}
        </div>
      </form>

      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          void restore();
        }}
      >
        <h2>Restore from a backup code</h2>
        <label htmlFor="code">Backup code</label>
        <input id="code" className="mono" required value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} />
        <label htmlFor="restore-name">A name for it in this browser</label>
        <input id="restore-name" value={restoreName} onChange={(e) => setRestoreName(e.target.value)} />
        <button className="btn" disabled={busy || !code.trim()}>
          Restore account
        </button>
      </form>
    </section>
  );
}
