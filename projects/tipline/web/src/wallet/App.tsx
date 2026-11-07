// An employee's own wallet. Not Tipline's: any member has one. It holds the employee's key, sealed
// with a passkey, makes group secrets from its own seed, enrolls the commitment with the employer, and
// shows the membership code. The employer never sees the secret.
import { useEffect, useState } from "react";
import { initHashing } from "@zk-toip/anon-membership";
import { Endpoint, RelayTransport, identityFromSeed } from "@zk-toip/trust-core";
import { createVault, PasskeyUnsupported, type Account, type Unlocked } from "@zk-toip/web-vault";
import { httpFetcher } from "../../../src/agents/logs";
import { checkMembership, enrollWallet, membershipCode, type MembershipCheck } from "../../../src/agents/wallet";
import { FRESHNESS } from "../../../src/protocol/messages";
import { ServerClock, getJson, longDate } from "../common/net";
import { Copyable, Field, Notice, useAction } from "../common/ui";

const vault = createVault({ prefix: "wallet", rpName: "Wallet" });
const clock = new ServerClock();

interface GroupInfo {
  org: string;
  label: string;
  group: string;
  issuer: string;
  log: string;
  snapshotBase: string;
}
interface Config {
  relayUrl: string;
  groups: GroupInfo[];
}
interface Joined {
  group: string;
  index: number;
  firstEpoch: string;
}

export function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [u, setU] = useState<Unlocked | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([clock.start(), getJson<Config>("/api/config"), initHashing()]).then(([, c]) => setConfig(c), (e) => setErr(String(e?.message ?? e)));
  }, []);
  return (
    <div className="wallet">
      <header className="wallet-bar">
        <span className="mark" aria-hidden="true" />
        <span>Wallet</span>
      </header>
      <main id="main" className="wallet-main">
        {err ? <Notice kind="bad">{err}</Notice> : !config ? <p className="muted">Loading…</p> : u ? <Home u={u} config={config} /> : <Start onOpen={setU} />}
      </main>
    </div>
  );
}

function Start({ onOpen }: { onOpen: (u: Unlocked) => void }) {
  const [accounts] = useState<Account[]>(() => vault.accounts());
  const [name, setName] = useState("");
  const [usePass, setUsePass] = useState(false);
  const [pass, setPass] = useState("");
  const a = useAction();
  if (accounts.length) {
    const acct = accounts[0];
    const needsPass = acct.lock?.kind === "passphrase";
    return (
      <section className="sheet">
        <h1>{acct.name}</h1>
        {needsPass && <Field label="Passphrase">{(id) => <input id={id} type="password" value={pass} onChange={(e) => setPass(e.target.value)} />}</Field>}
        <button disabled={a.busy} onClick={() => a.run(async () => onOpen(await vault.unlock(acct, needsPass ? pass : undefined)))}>
          Unlock {acct.name}
        </button>
        {a.error && <p className="error">{a.error}</p>}
      </section>
    );
  }
  return (
    <section className="sheet">
      <h1>Make your wallet</h1>
      <p>Your wallet keeps your keys on this device, sealed with a passkey. Organizations you belong to can let you prove membership with it.</p>
      <Field label="Your name">{(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      {usePass && <Field label="Passphrase" hint="At least 12 characters.">{(id) => <input id={id} type="password" value={pass} onChange={(e) => setPass(e.target.value)} />}</Field>}
      <div className="row">
        <button
          disabled={a.busy || !name.trim() || (usePass && pass.length < 12)}
          onClick={() =>
            a.run(async () => {
              try {
                onOpen(await vault.createAccount(name.trim(), usePass ? { kind: "passphrase", passphrase: pass } : { kind: "passkey" }));
              } catch (e) {
                if (e instanceof PasskeyUnsupported) {
                  setUsePass(true);
                  throw new Error("This browser's passkeys can't seal keys. Choose a passphrase.");
                }
                throw e;
              }
            })
          }
        >
          {usePass ? "Make wallet" : "Make wallet with a passkey"}
        </button>
        {!usePass && (
          <button className="quiet" onClick={() => setUsePass(true)}>
            Use a passphrase instead
          </button>
        )}
      </div>
      {a.error && <p className="error">{a.error}</p>}
    </section>
  );
}

function Home({ u, config }: { u: Unlocked; config: Config }) {
  const did = identityFromSeed(u.seed).did;
  return (
    <>
      <section className="sheet">
        <h1>{u.account.name}</h1>
        <p className="muted">Your wallet ID. Give it to an organization that wants to add you.</p>
        <Copyable value={did} label="Wallet ID" />
      </section>
      {config.groups.map((g) => (
        <GroupCard key={g.group} u={u} g={g} relayUrl={config.relayUrl} />
      ))}
    </>
  );
}

function GroupCard({ u, g, relayUrl }: { u: Unlocked; g: GroupInfo; relayUrl: string }) {
  const [joined, setJoined] = useState<Joined | null>(null);
  const [check, setCheck] = useState<MembershipCheck | null>(null);
  const [showCode, setShowCode] = useState(false);
  const a = useAction();
  const c = useAction();
  const key = `group-${g.org.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const refresh = () =>
    c.run(async () => {
      await clock.sync();
      setCheck(
        await checkMembership({ walletSeed: u.seed, groupId: g.group, issuer: g.issuer, logUrl: g.log, snapshotUrl: (e) => `${g.snapshotBase}${e}.bin`, fetcher: httpFetcher(), clock }),
      );
    });
  useEffect(() => {
    void vault.readJson<Joined>(u, key).then((j) => {
      setJoined(j);
      if (j) void refresh();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const join = () =>
    a.run(async () => {
      const identity = identityFromSeed(u.seed);
      const t = new RelayTransport({ url: relayUrl, identity });
      const ep = new Endpoint({ identity, transport: t, clock, timeoutMs: 15_000, freshness: FRESHNESS });
      t.start();
      try {
        const e = await enrollWallet(ep, g.issuer, g.group, u.seed);
        const j = { group: e.group, index: e.index, firstEpoch: e.firstEpoch };
        await vault.writeJson(u, key, j);
        setJoined(j);
      } finally {
        ep.close();
        t.stop();
      }
      await refresh();
    });

  return (
    <section className="sheet">
      <h2>{g.label}</h2>
      {!joined ? (
        <>
          <p>
            {g.org} runs a membership group for its employees. Joining sends {g.org} a commitment made from a secret only this wallet knows. {g.org} learns that the commitment is yours,
            and nothing it can use later to tell when you prove membership.
          </p>
          <button disabled={a.busy} onClick={join}>
            {a.busy ? "Joining…" : `Join ${g.label}`}
          </button>
          {a.error && <p className="error">{a.error === "not admitted to this group" ? `${g.org} hasn't added your wallet ID yet. Ask HR to add it, then try again.` : a.error}</p>}
        </>
      ) : (
        <>
          <p className="status" data-testid="joined">
            Joined as member number {joined.index + 1}.
          </p>
          {check?.state === "in" && (
            <p className="status good" data-testid="in-root">
              You are in the list {g.org} signed on {longDate(check.epoch)}, one of {check.size} members.
            </p>
          )}
          {check?.state === "pending" && <p className="status">Waiting for the next daily list from {g.org}{check.latest ? ` (the newest is from ${longDate(check.latest)})` : ""}.</p>}
          {check?.state === "removed" && (
            <Notice kind="warn" title="You are not in the newest member list">
              The list of {longDate(check.epoch)} no longer holds you. The last one that did is {longDate(check.lastSeen!)}.
            </Notice>
          )}
          {check?.state === "error" && <p className="error">{check.why}</p>}
          <div className="row">
            <button className="secondary" disabled={c.busy} onClick={refresh}>
              Check my membership
            </button>
            <button className="secondary" onClick={() => setShowCode((s) => !s)}>
              {showCode ? "Hide membership code" : "Show membership code"}
            </button>
          </div>
          {showCode && (
            <div className="code-box">
              <p>
                Paste this into a site that asks you to prove you're one of {g.label}. It never leaves your hands in a form {g.org} can match to you. Anyone who has it can prove
                membership as you, so treat it like a password.
              </p>
              <Copyable value={membershipCode(u.seed, g.group)} label="Membership code" className="big" />
            </div>
          )}
        </>
      )}
    </section>
  );
}
