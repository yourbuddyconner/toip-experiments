import { useEffect, useRef, useState } from "react";
import { fromB64u } from "@toip-tools/trust-core";
import { decodeKeyRefSig, verifyBundle, verifySignature, type Bundle, type SignatureCheck } from "@toip-tools/eventlog";
import { buildView, type EvidenceView, type IdentifierView } from "../../src/view";
import { evidenceHolders, getBundle, getCaptures, getSamples, loadView, resetDemo, runStep, witnessClients, type Capture, type Sample, type State } from "./api";
import { Hash, IdentifierBody, Problems, Stamp } from "./components";

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data?: T; error?: string; loading: boolean } {
  const [s, set] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let live = true;
    set((x) => ({ ...x, loading: true }));
    fn().then(
      (data) => live && set({ data, loading: false }),
      (e: Error) => live && set({ error: e.message, loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return s;
}

function Loading({ what }: { what: string }) {
  return (
    <p className="quiet" role="status">
      Verifying {what} in this page…
    </p>
  );
}

function Verdict({ view }: { view: IdentifierView }) {
  const dup = view.evidence.length;
  return (
    <div className="verdict-line">
      <Stamp tone={view.ok ? "valid" : dup ? "bad" : "warn"} big>
        {view.ok ? "verified" : dup ? "duplicity" : "problems"}
      </Stamp>
      <p>
        {view.ok
          ? "Every message verifies: signatures, chains, key states, receipts and seals."
          : dup
            ? `Verification found ${dup} piece${dup === 1 ? "" : "s"} of duplicity evidence. The log still verifies message by message; see what was caught below.`
            : `Verification found ${view.problems.length} problem${view.problems.length === 1 ? "" : "s"}.`}{" "}
        {view.witnessChecked ? "Heads were compared with the witnesses just now, so nothing is hidden from the end." : "Offline: complete only up to the last head shown."}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ identifier

export function IdentifierPage({ state, aid }: { state: State; aid: string }) {
  const { data: view, error, loading } = useAsync(() => loadView(aid, state), [aid, state.progress]);
  const label = state.logs.find((l) => l.aid === aid)?.label ?? "Identifier";
  return (
    <article className="page">
      <header className="page-head">
        <h2>{label}</h2>
        <p className="aid">
          AID <Hash value={aid} n={22} />
        </p>
      </header>
      {error ? <p className="error">Couldn't load this identifier: {error}</p> : null}
      {!view && loading ? <Loading what={label} /> : null}
      {view ? (
        <>
          <Verdict view={view} />
          <dl className="facts">
            <dt>DID</dt>
            <dd>
              <code>{view.didKeri}</code>
            </dd>
            {view.bindings.map((b) => (
              <div key={b.did} className="fact">
                <dt>Bound to</dt>
                <dd>
                  <code>{b.did}</code> {b.ok ? <Stamp tone="valid">binding valid</Stamp> : <Stamp tone="bad">binding invalid</Stamp>}
                  {b.sealedAt !== undefined ? <span className="quiet"> sealed at KEL {b.sealedAt}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
          <p className="downloads">
            <DownloadBundle aid={aid} label={label} />
          </p>
          {view.evidence.length ? (
            <p className="callout">
              {view.evidence.length} duplicity finding{view.evidence.length === 1 ? "" : "s"} about {label}. <a href="#/evidence">See the evidence side by side</a>.
            </p>
          ) : null}
          <IdentifierBody view={view} />
        </>
      ) : null}
    </article>
  );
}

function DownloadBundle({ aid, label }: { aid: string; label: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="button quiet-button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const b = await getBundle(aid);
          const a = document.createElement("a");
          a.href = URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: "application/json" }));
          a.download = `${label.toLowerCase().replace(/\W+/g, "-")}-bundle.json`;
          a.click();
          URL.revokeObjectURL(a.href);
        } finally {
          setBusy(false);
        }
      }}
    >
      Download the bundle
    </button>
  );
}

// ------------------------------------------------------------------ verify

export function VerifyPage({ state }: { state: State }) {
  const samples = useAsync(getSamples, [state.progress]);
  const [current, setCurrent] = useState<{ title: string; bundle: Bundle } | null>(null);
  const [view, setView] = useState<IdentifierView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const check = async (title: string, bundle: Bundle) => {
    setBusy(true);
    setError(null);
    setView(null);
    setCurrent({ title, bundle });
    try {
      if (typeof bundle?.kel !== "string" || !Array.isArray(bundle.trails)) throw new Error("this isn't a Trail bundle: it needs a kel stream and a list of trails");
      const { view } = await buildView(bundle, { names: state.names, witnesses: witnessClients(state) });
      setView(view);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const readFile = async (f: File) => {
    try {
      await check(f.name, JSON.parse(await f.text()) as Bundle);
    } catch (e) {
      setError(`Couldn't read ${f.name}: ${(e as Error).message}`);
    }
  };

  return (
    <article className="page">
      <header className="page-head">
        <h2>Verify a bundle</h2>
        <p>A bundle is what gets handed around: a KEL, trails, disclosed bodies and DID bindings. It is checked here, in this page, and its heads are compared with the witnesses.</p>
      </header>
      <div
        className={`drop${drag ? " drop-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files[0];
          if (f) void readFile(f);
        }}
      >
        <p>Drop a bundle file here, or</p>
        <button type="button" className="button" onClick={() => fileRef.current?.click()}>
          Choose a bundle file
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" aria-label="Bundle file" onChange={(e) => e.target.files?.[0] && void readFile(e.target.files[0])} />
      </div>
      <section aria-labelledby="samples">
        <h3 id="samples">Bundles from the demo</h3>
        {samples.data?.length ? (
          <ul className="samples">
            {samples.data.map((s: Sample) => (
              <li key={s.id}>
                <button type="button" className="linkish" onClick={() => void check(s.title, s.bundle)}>
                  {s.title}
                </button>
                <span className="quiet"> {s.note}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="quiet">Run step 3 of the demo to get Scout's bundle; steps 4 and 8 add tampered and forged ones.</p>
        )}
      </section>
      <div aria-live="polite">
        {busy ? <Loading what={current?.title ?? "the bundle"} /> : null}
        {error ? <p className="error">{error}</p> : null}
        {view && current ? (
          <section className="result" aria-labelledby="result">
            <h3 id="result">{current.title}</h3>
            <div className="verdict-line">
              <Stamp tone={view.ok ? "valid" : "bad"} big>
                {view.ok ? "verified" : "failed"}
              </Stamp>
              <p>
                {view.ok ? "Every check passes." : `${view.problems.length} problem${view.problems.length === 1 ? "" : "s"}.`}{" "}
                {view.witnessChecked ? "Compared with the witnesses." : "Offline only: no witness answered."}
              </p>
            </div>
            <Problems problems={view.problems} empty="No problems." />
            <IdentifierBody view={view} />
          </section>
        ) : null}
      </div>
    </article>
  );
}

// ------------------------------------------------------------------ evidence

export function EvidencePage({ state }: { state: State }) {
  const { data, error, loading } = useAsync(async () => {
    const holders = await evidenceHolders();
    const views = await Promise.all(state.logs.map((l) => loadView(l.aid, state)));
    return { holders, evidence: views.flatMap((v) => v.evidence.map((e) => ({ e, label: v.label }))) };
  }, [state.progress]);
  return (
    <article className="page">
      <header className="page-head">
        <h2>Duplicity evidence</h2>
        <p>Two different signed versions at one place in a log. Each piece proves itself: it needs only the controller's KEL to check, so it doesn't matter who reported it.</p>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {loading && !data ? <Loading what="the evidence" /> : null}
      {data && !data.evidence.length ? <p className="quiet">No duplicity yet. Steps 5 and 6 of the demo produce some.</p> : null}
      {data?.evidence.map(({ e, label }, i) => (
        <EvidenceCard key={i} e={e} label={label} holders={data.holders.get(`${e.kind}|${e.logId}|${e.s}|${e.witness?.id ?? ""}`) ?? []} />
      ))}
    </article>
  );
}

function EvidenceCard({ e, label, holders }: { e: EvidenceView; label: string; holders: string[] }) {
  const differs = new Set(e.diff.map((d) => d.field));
  return (
    <section className="evidence" aria-label={`${e.kind} duplicity at entry ${e.s}`}>
      <h3>
        {e.kind === "controller" ? `Controller duplicity: ${label}, entry ${e.s}` : `Witness duplicity: ${e.witness?.name}, entry ${e.s}`}{" "}
        <Stamp tone={e.verified ? "bad" : "warn"}>{e.verified ? "proven" : "unverified"}</Stamp>
      </h3>
      <p>{e.explanation}</p>
      <p className="quiet">
        Held by {holders.length ? holders.join(", ") : e.detectedBy}. First detected by {e.detectedBy}.
      </p>
      <div className="versions">
        {(["a", "b"] as const).map((k) => (
          <figure key={k} className="version">
            <figcaption>
              Version {k.toUpperCase()} <Hash value={e[k].d} n={10} />
              <span className="quiet"> {e[k].sig}</span>
            </figcaption>
            <pre className="raw">{highlight(e[k].raw, differs)}</pre>
          </figure>
        ))}
      </div>
      {e.kind === "controller" ? (
        <table className="ledger diff">
          <caption>Fields that differ</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Version A</th>
              <th scope="col">Version B</th>
            </tr>
          </thead>
          <tbody>
            {e.diff.map((d) => (
              <tr key={d.field}>
                <td>
                  <code>{d.field}</code>
                </td>
                <td>
                  <code className="hash">{d.a}</code>
                </td>
                <td>
                  <code className="hash">{d.b}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

/** The raw JSON, with the differing fields marked. */
function highlight(raw: string, fields: Set<string>) {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw);
  } catch {
    return raw;
  }
  return (
    <>
      {"{\n"}
      {Object.entries(obj).map(([k, v], i, all) => {
        const line = `  "${k}": ${JSON.stringify(v)}${i < all.length - 1 ? "," : ""}\n`;
        return fields.has(k) ? (
          <mark key={k} className="diffmark">
            {line}
          </mark>
        ) : (
          <span key={k}>{line}</span>
        );
      })}
      {"}"}
    </>
  );
}

// ------------------------------------------------------------------ captures

export function CapturesPage({ state }: { state: State }) {
  const { data, error, loading } = useAsync(async () => {
    const { captures, camera } = await getCaptures();
    if (!camera) return { captures, checks: [] as SignatureCheck[] };
    const r = await verifyBundle(await getBundle(camera.aid), { witnesses: witnessClients(state) });
    const checks = await Promise.all(captures.map((c: Capture) => verifySignature({ bytes: fromB64u(c.bytes), sig: decodeKeyRefSig(c.sig), kel: r.kel, trails: r.trails })));
    return { captures, checks, camera };
  }, [state.progress]);
  return (
    <article className="page">
      <header className="page-head">
        <h2>Camera captures</h2>
        <p>Photos are signed outside the log, under a named key state, and anchored in the camera's captures trail. A signature still verifies after the key rotates; the anchor proves it was made while the key was current.</p>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {loading && !data ? <Loading what="the captures" /> : null}
      {data && !data.captures.length ? <p className="quiet">No captures yet. Step 9 of the demo provisions the camera.</p> : null}
      <ul className="captures">
        {data?.captures.map((c, i) => {
          const v = data.checks[i];
          const tone = !v?.valid ? "bad" : v.anchoredBeforeRetirement ? "valid" : "warn";
          return (
            <li key={c.label} className={`capture capture-${tone}`}>
              <h3>
                {c.label} <Stamp tone={tone}>{!v?.valid ? "invalid" : v.anchoredBeforeRetirement ? "anchored" : "retired key"}</Stamp>
              </h3>
              <p className="quiet">{c.note}.</p>
              {v ? (
                <dl className="facts">
                  <dt>Signature</dt>
                  <dd>{v.valid ? `valid, by key state ${v.keyState.estSn}` : "does not verify"}</dd>
                  <dt>Key state</dt>
                  <dd>{v.current ? "current" : `retired at KEL ${v.retiredAt}`}</dd>
                  <dt>Anchored</dt>
                  <dd>{v.anchoredBeforeRetirement ? `in captures entry ${v.anchored?.s}, before the key was retired` : "not anchored before the key was retired: it may have been made later by whoever holds the old key"}</dd>
                  {v.witnessedBy ? (
                    <>
                      <dt>Existed by</dt>
                      <dd>{v.witnessedBy}, the first witness receipt of its anchor</dd>
                    </>
                  ) : null}
                </dl>
              ) : null}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

// ------------------------------------------------------------------ demo

export function DemoPage({ state, onState }: { state: State; onState: (s: State) => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const next = state.steps.find((s) => !s.done);
  const run = async (n: number) => {
    setBusy(n);
    setError(null);
    try {
      const { state: s } = await runStep(n);
      onState(s);
      requestAnimationFrame(() => document.getElementById(`report-${n}`)?.focus());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <article className="page">
      <header className="page-head">
        <h2>The demo</h2>
        <p>
          Ada's agent, Scout, keeps an audit trail. Steps 4 to 8 are the red team: each attack runs against the real witnesses, and the explorer shows how it was caught. Ada's policy: {state.policy}
        </p>
      </header>
      <ol className="steps">
        {state.steps.map((s) => {
          const report = state.reports.find((r) => r.n === s.n);
          return (
            <li key={s.n} className={`step${s.done ? " step-done" : ""}${s.redTeam ? " step-red" : ""}${next?.n === s.n ? " step-next" : ""}`}>
              <h3>
                <span className="step-n">{s.n}</span> {s.title}
                {s.redTeam ? <span className="redteam">red team</span> : null}
              </h3>
              <p className="quiet">{s.summary}</p>
              {next?.n === s.n ? (
                <button type="button" className="button primary" disabled={busy !== null} onClick={() => void run(s.n)}>
                  {busy === s.n ? `Running step ${s.n}…` : `Run step ${s.n}: ${s.title}`}
                </button>
              ) : null}
              {report ? (
                <div className="report" id={`report-${s.n}`} tabIndex={-1} aria-label={`What happened in step ${s.n}`}>
                  {report.lines.map((l, i) => (
                    <p key={i} className={`line line-${l.tone ?? "info"}`}>
                      <span className="who">{l.who}</span> <span className="what">{l.text}</span>
                    </p>
                  ))}
                  <StepLinks n={s.n} state={state} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div aria-live="assertive">{error ? <p className="error">Step failed: {error}</p> : null}</div>
      <p>
        <button
          type="button"
          className="button quiet-button"
          disabled={busy !== null}
          onClick={async () => {
            if (!confirm("Start the demo over? Every log, key and witness store is forgotten.")) return;
            onState(await resetDemo());
          }}
        >
          Start the demo over
        </button>
      </p>
    </article>
  );
}

function StepLinks({ n, state }: { n: number; state: State }) {
  const scout = state.scout ? `#/id/${state.scout.aid}` : "#/";
  const links: Record<number, [string, string][]> = {
    1: [[scout, "See Scout's KEL"]],
    2: [[scout, "See Scout's trail"]],
    3: [["#/verify", "Verify the bundle yourself"]],
    4: [["#/verify", "Verify the tampered copies"]],
    5: [["#/evidence", "See the evidence"]],
    6: [["#/evidence", "See the evidence"], [scout, "See the rotation"]],
    7: [[scout, "See the cut entries"]],
    8: [["#/verify", "Verify Mallory's bundle"]],
    9: [["#/captures", "See the captures"]],
    10: [],
  };
  if (!links[n]?.length) return null;
  return (
    <p className="step-links">
      {links[n].map(([href, text]) => (
        <a key={text} href={href}>
          {text}
        </a>
      ))}
    </p>
  );
}
