import { useEffect, useState } from "react";
import { A, Field } from "./ui";
import { navigate, needsYou, usePath, useSession } from "./model";
import { accounts, activeAccountId, createAccount, Session, setActiveAccount, type Account } from "./session";
import { Home } from "./pages/Home";
import { PaymentDetail, Payments } from "./pages/Payments";
import { Links } from "./pages/Links";
import { Wallet } from "./pages/Wallet";
import { Profile } from "./pages/Profile";
import { Checkout } from "./pages/Checkout";
import { Console } from "./pages/Console";
import { DevClock } from "./pages/DevClock";

/** Opens this tab's account, or asks which one to use. */
export interface AccountSession {
  session: Session | null;
  state: "none" | "opening" | "open" | "locked" | "error";
  error?: string;
  choose: (a: Account) => void;
  leave: () => void;
}

/** The app keeps one session for the whole tab, so moving between pages never interrupts the party. */
function useAccountSession(enabled: boolean): AccountSession {
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<"none" | "opening" | "open" | "locked" | "error">(activeAccountId() ? "opening" : "none");
  const [error, setError] = useState<string>();
  const [id, setId] = useState(activeAccountId());
  useEffect(() => {
    const a = enabled ? accounts().find((x) => x.id === id) : undefined;
    if (!a) {
      setState("none");
      return;
    }
    let cancelled = false;
    let opened: Session | null = null;
    setState("opening");
    Session.open(a)
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
  }, [id, enabled]);
  return {
    session,
    state,
    error,
    choose: (a) => {
      setActiveAccount(a.id);
      setId(a.id);
    },
    leave: () => {
      setActiveAccount(null);
      // Dropping the lock needs the tab to let go of the party entirely.
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
  if (!acct.session) return <Welcome locked={acct.state === "locked"} onChoose={acct.choose} />;
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

export function Welcome({ locked, onChoose, title, placeholder }: { locked?: boolean; onChoose: (a: Account) => void; title?: string; placeholder?: string }) {
  const [name, setName] = useState("");
  const list = accounts();
  return (
    <main className="welcome">
      <Wordmark />
      <h1>{title ?? "Get paid when the work is done."}</h1>
      <p className="lede">
        Settle holds a payment in an escrow that nobody controls alone, and releases it when the work is confirmed. Your keys stay in this browser.
      </p>
      {locked && <p className="notice">That account is open in another tab. Pick another, or close that tab first.</p>}
      <form
        className="welcome-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onChoose(createAccount(name));
        }}
      >
        <Field label="Your name or your business's name" hint="People you pay or get paid by see this name.">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder ?? "Joe's Plumbing"} autoFocus maxLength={60} />
        </Field>
        <button className="btn btn-primary" disabled={!name.trim()}>
          Create account
        </button>
      </form>
      {list.length > 0 && (
        <section className="account-list">
          <h2>Accounts in this browser</h2>
          <ul>
            {list.map((a) => (
              <li key={a.id}>
                <button type="button" className="linkish" onClick={() => onChoose(a)}>
                  {a.name}
                </button>
              </li>
            ))}
          </ul>
          <p className="hint">Each tab can use a different account, so you can be the business in one tab and the customer in another.</p>
        </section>
      )}
    </main>
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
          <DevClock now={session.now} />
          <a href="/console" target="_blank" rel="noreferrer" className="small">
            Operator view
          </a>
        </div>
      </nav>
      <main className="page">
        {session.reset && (
          <p className="notice">
            The local network restarted, so payments from before are gone. Your account and keys are still here.
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
