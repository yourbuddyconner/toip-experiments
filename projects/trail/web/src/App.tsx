import { useEffect, useState } from "react";
import { getState, type State } from "./api";
import { CapturesPage, DemoPage, EvidencePage, IdentifierPage, VerifyPage } from "./pages";

function useHash(): string {
  const [h, set] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => set(location.hash || "#/");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return h;
}

const NAV: [string, string][] = [
  ["#/demo", "Demo"],
  ["#/verify", "Verify"],
  ["#/evidence", "Evidence"],
  ["#/captures", "Captures"],
];

export function App() {
  const hash = useHash();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getState().then(setState, (e: Error) => setError(e.message));
  }, [hash]);
  useEffect(() => {
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [hash.split("/")[1]]);

  const route = hash.slice(2).split("/");
  let page = null;
  if (state) {
    if (route[0] === "id" && route[1]) page = <IdentifierPage key={route[1]} state={state} aid={route[1]} />;
    else if (route[0] === "verify") page = <VerifyPage state={state} />;
    else if (route[0] === "evidence") page = <EvidencePage state={state} />;
    else if (route[0] === "captures") page = <CapturesPage state={state} />;
    else if (route[0] === "demo" || !state.logs.length) page = <DemoPage state={state} onState={setState} />;
    else page = <IdentifierPage key={state.logs[0].aid} state={state} aid={state.logs[0].aid} />;
  }
  const current = (href: string) => hash.startsWith(href) || (href === "#/demo" && route[0] === "" && !state?.logs.length);

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to the content
      </a>
      <header className="bar">
        <h1 className="mark">
          <a href="#/">
            <span className="mark-word">Trail</span>
            <span className="mark-sub">explorer for verifiable audit trails</span>
          </a>
        </h1>
        <nav aria-label="Pages">
          <ul>
            {NAV.map(([href, label]) => (
              <li key={href}>
                <a href={href} aria-current={current(href) ? "page" : undefined}>
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <div className="body">
        <aside className="rail" aria-label="Identifiers and witnesses">
          <h2>Case files</h2>
          {state?.logs.length ? (
            <ul className="files">
              {state.logs.map((l) => (
                <li key={l.aid}>
                  <a href={`#/id/${l.aid}`} aria-current={route[1] === l.aid || (route[0] === "" && state.logs[0].aid === l.aid) ? "page" : undefined}>
                    <span className="file-name">{l.label}</span>
                    <code className="hash">{l.aid.slice(0, 12)}…</code>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="quiet">None yet. Run step 1 of the demo.</p>
          )}
          <h2>Witnesses</h2>
          <ul className="witnesses">
            {state?.witnesses.map((w) => (
              <li key={w.n} className={w.rogue ? "rogue" : w.inUse ? "in-use" : "idle"}>
                <span className="w-name">{w.name}</span>
                <span className="w-state">{w.rogue ? (w.inUse ? "rogue" : "rogue, removed") : w.inUse ? "in use" : "standing by"}</span>
                <code className="hash" title={w.aid}>
                  {w.aid.slice(0, 10)}…
                </code>
              </li>
            ))}
          </ul>
          <p className="quiet small">Every check on these pages runs in your browser, with the same library the service uses. Nothing here trusts the server's word.</p>
        </aside>
        <main id="main" tabIndex={-1}>
          {error ? <p className="error">Couldn't reach the Trail service: {error}</p> : null}
          {!state && !error ? (
            <p className="quiet" role="status">
              Loading…
            </p>
          ) : null}
          {page}
        </main>
      </div>
    </div>
  );
}
