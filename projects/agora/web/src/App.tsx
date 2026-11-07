import { useEffect, useState } from "react";
import type { Account } from "@zk-toip/web-vault";
import { vault } from "./services";
import { AccountPage } from "./pages/Account";
import { AboutPage } from "./pages/About";
import { ForumPage } from "./pages/Forum";
import { ForumsPage } from "./pages/Forums";
import { ModeratePage } from "./pages/Moderate";
import { NewForumPage } from "./pages/NewForum";
import { ThreadPage } from "./pages/Thread";
import { WalletPage } from "./pages/Wallet";
import { Link, navigate, urn, usePath } from "./router";
import { useApp } from "./state";
import { DevClock, Notice } from "./ui";

function Route({ path }: { path: string }) {
  const p = path.split("?")[0];
  let m: RegExpMatchArray | null;
  if (p === "/") return <ForumsPage />;
  if (p === "/account") return <AccountPage />;
  if (p === "/wallet") return <WalletPage />;
  if (p === "/new") return <NewForumPage />;
  if (p === "/about") return <AboutPage />;
  if ((m = p.match(/^\/f\/([0-9a-f-]{36})\/t\/([0-9a-f-]{36})$/))) return <ThreadPage forumId={urn(m[1])} threadId={urn(m[2])} />;
  if ((m = p.match(/^\/f\/([0-9a-f-]{36})$/))) return <ForumPage forumId={urn(m[1])} />;
  if ((m = p.match(/^\/moderate\/([0-9a-f-]{36})$/))) return <ModeratePage forumId={urn(m[1])} />;
  return (
    <section>
      <h1 tabIndex={-1}>Not here</h1>
      <p>
        There's no page at this address. <Link to="/">See the forums</Link>.
      </p>
    </section>
  );
}

const NAV = [
  ["/", "Forums"],
  ["/wallet", "Wallet"],
  ["/new", "New forum"],
  ["/about", "About"],
] as const;

export function App() {
  const path = usePath();
  const { services, error, session, signOut, signIn } = useApp();
  const [unlocking, setUnlocking] = useState(false);
  // After a reload, the tab remembers which account it used, but not its key.
  const lastId = sessionStorage.getItem("agora.active");
  const last = lastId ? vault.accounts().find((a) => a.id === lastId && a.lock?.kind === "passkey") : undefined;
  const unlock = async (a: Account) => {
    setUnlocking(true);
    try {
      await signIn(await vault.unlock(a));
    } catch {
      navigate("/account");
    } finally {
      setUnlocking(false);
    }
  };
  useEffect(() => {
    document.title = "Agora";
  }, [path]);
  const here = (to: string) => (to === "/" ? path === "/" || path.startsWith("/f/") : path.startsWith(to));
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="masthead">
        <div className="masthead-inner">
          <Link to="/" className="wordmark" aria-label="Agora, home">
            <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
              <circle cx="16" cy="16" r="14" fill="var(--civic)" />
              <path d="M16 2a14 14 0 0 1 14 14H16z" fill="var(--marigold)" />
              <circle cx="16" cy="16" r="5" fill="var(--ink)" />
            </svg>
            Agora
          </Link>
          <nav aria-label="Main">
            <ul>
              {NAV.map(([to, label]) => (
                <li key={to}>
                  <Link to={to} aria-current={here(to) ? "page" : undefined}>
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="who">
            {session ? (
              <>
                <span className="who-name">{session.name}</span>
                <button type="button" className="btn btn-small btn-quiet" onClick={signOut}>
                  Lock
                </button>
              </>
            ) : last ? (
              <button type="button" className="btn btn-small" disabled={unlocking} onClick={() => void unlock(last)}>
                Unlock {last.name}
              </button>
            ) : (
              <Link to="/account" className="btn btn-small">
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>
      <main id="main">
        {error ? (
          <Notice tone="error" title="Agora couldn't start">
            {error}. Is the platform running? Start it with <code>npm run agora</code>.
          </Notice>
        ) : !services ? (
          <p className="loading">Loading the prover and the host's clock…</p>
        ) : (
          <Route path={path} />
        )}
      </main>
      <footer className="footer">
        <DevClock />
      </footer>
    </>
  );
}
