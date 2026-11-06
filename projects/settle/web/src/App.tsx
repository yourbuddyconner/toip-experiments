import { useEffect, useState } from "react";
import { A } from "./ui";
import { navigate, needsYou, usePath, useSession } from "./model";
import { accounts, activeAccountId, Session, setActiveAccount } from "./session";
import { unlockedAccount, type Account, type Unlocked } from "./vault";
import { Home } from "./pages/Home";
import { PaymentDetail, Payments } from "./pages/Payments";
import { Links } from "./pages/Links";
import { Wallet } from "./pages/Wallet";
import { Profile } from "./pages/Profile";
import { Checkout } from "./pages/Checkout";
import { Console } from "./pages/Console";
import { DevClock } from "./pages/DevClock";
import { ProtectBanner, Unlock, Welcome } from "./pages/Accounts";

export { Welcome };

/** Opens this tab's account, or asks which one to use. */
export interface AccountSession {
  session: Session | null;
  /** "unlock": the tab knows its account, but its key needs unlocking (after a reload). */
  state: "none" | "unlock" | "opening" | "open" | "locked" | "error";
  error?: string;
  /** The account waiting to be unlocked. */
  account?: Account;
  choose: (u: Unlocked) => void;
  leave: () => void;
}

/** The app keeps one session for the whole tab, so moving between pages never interrupts the party. */
function useAccountSession(enabled: boolean): AccountSession {
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<AccountSession["state"]>(activeAccountId() ? "opening" : "none");
  const [error, setError] = useState<string>();
  const [id, setId] = useState(activeAccountId());
  const [kick, setKick] = useState(0);
  const account = id ? accounts().find((x) => x.id === id) : undefined;
  useEffect(() => {
    const a = enabled && id ? accounts().find((x) => x.id === id) : undefined;
    if (!a) {
      setState("none");
      return;
    }
    const u = unlockedAccount(a.id);
    if (!u) {
      setState("unlock");
      return;
    }
    let cancelled = false;
    let opened: Session | null = null;
    setState("opening");
    Session.open(u)
      .then((s) => {
        if (cancelled) return s === "locked" ? undefined : s.close();
        if (s === "locked") {
          setActiveAccount(null);
          return setState("locked");
        }
        opened = s;
        setSession(s);
        setState("open");
      })
      .catch((e) => {
        setError(String(e?.message ?? e));
        setState("error");
      });
    return () => {
      cancelled = true;
      opened?.close();
    };
  }, [id, enabled, kick]);
  return {
    session,
    state,
    error,
    account,
    choose: (u) => {
      setActiveAccount(u.account.id);
      setId(u.account.id);
      setKick((k) => k + 1);
    },
    leave: () => {
      setActiveAccount(null);
      // Dropping the lock (and the key in memory) needs the tab to let go of the party entirely.
      location.assign("/");
    },
  };
}

export function App() {
  const path = usePath();
  const acct = useAccountSession(path !== "/console");
  if (path === "/console") return <Console />;
  if (path.startsWith("/pay/")) return <Checkout token={path.slice(5)} acct={acct} />;
  return <Dashboard path={path} acct={acct} />;
}

function Dashboard({ path, acct }: { path: string; acct: AccountSession }) {
  if (acct.state === "opening") return <Splash text="Opening your account…" />;
  if (acct.state === "error") return <Splash text={`Couldn't reach the Settle network: ${acct.error}. Is the platform running?`} />;
  if (acct.state === "unlock" && acct.account) return <Unlock account={acct.account} onOpen={acct.choose} onOther={acct.leave} />;
  if (!acct.session) return <Welcome locked={acct.state === "locked"} onOpen={acct.choose} />;
  return <Shell session={acct.session} path={path} onLeave={acct.leave} />;
}

export function Splash({ text }: { text: string }) {
  return (
    <main className="splash">
      <Wordmark />
      <p>{text}</p>
    </main>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark" aria-label="Settle">
      <svg viewBox="0 0 40 20" aria-hidden="true">
        <circle cx="8" cy="10" r="6" className="wm-fill" />
        <circle cx="20" cy="10" r="6" className="wm-ring" />
        <circle cx="32" cy="10" r="6" className="wm-fill" />
      </svg>
      Settle
    </span>
  );
}

const NAV: [string, string][] = [
  ["/", "Home"],
  ["/payments", "Payments"],
  ["/links", "Payment links"],
  ["/wallet", "Wallet"],
  ["/profile", "Profile"],
];

function Shell({ session, path, onLeave }: { session: Session; path: string; onLeave: () => void }) {
  useSession(session);
  const p = session.party;
  const waiting = p.list().filter((x) => needsYou(x, p.did)).length;
  const match = /^\/payments\/(.+)$/.exec(path);
  let page;
  if (path === "/") page = <Home s={session} />;
  else if (path === "/payments") page = <Payments s={session} />;
  else if (match) page = <PaymentDetail s={session} id={decodeURIComponent(match[1])} />;
  else if (path === "/links") page = <Links s={session} />;
  else if (path === "/wallet") page = <Wallet s={session} />;
  else if (path === "/profile") page = <Profile s={session} onLeave={onLeave} />;
  else page = <p>There's nothing at this address. <A to="/">Go home</A></p>;
  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <A to="/" className="rail-brand">
          <Wordmark />
        </A>
        <div className="rail-account">
          <span className="rail-name">{p.name}</span>
          <button type="button" className="linkish small" onClick={onLeave}>
            Switch account
          </button>
        </div>
        <ul>
          {NAV.map(([to, label]) => (
            <li key={to}>
              <A to={to} className={(to === "/" ? path === "/" : path.startsWith(to)) ? "active" : ""}>
                {label}
                {to === "/" && waiting > 0 && <span className="count" aria-label={`${waiting} need you`}>{waiting}</span>}
              </A>
            </li>
          ))}
        </ul>
        <div className="rail-foot">
          <span className="chip chip-network" title={session.config.rpcUrl}>
            {session.config.cluster === "local" ? "Local network" : `Solana ${session.config.cluster}`}
          </span>
          {session.config.devClock ? <DevClock now={session.now} /> : null}
          <a href="/console" target="_blank" rel="noreferrer" className="small">
            Operator view
          </a>
        </div>
      </nav>
      <main className="page">
        <ProtectBanner u={session.unlocked} onProtected={() => location.reload()} />
        {session.reset && (
          <p className="notice">
            This Settle network was started afresh, so payments from before are gone. Your account and keys are still here.
            <button type="button" className="linkish" onClick={() => ((session.reset = false), session.changed())}>
              Dismiss
            </button>
          </p>
        )}
        {page}
      </main>
    </div>
  );
}

export { navigate };
