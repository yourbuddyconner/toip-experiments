/**
 * The verifier (design §14, §15.4). Everything is checked here, in this browser: the server only helps
 * find a store, a fresher key log or a status list, and nothing it sends is believed without checking.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { MandateEngine } from "@toip-tools/mandates";
import {
  credentialKind,
  httpFetcher,
  KEY_CLASS_WORDS,
  sniffMime,
  tileRect,
  verifyAsset,
  type ChainStep,
  type Finding,
  type Report,
  type TrustEntry,
} from "../../../src/core";
import { mandateChecker } from "../../../src/core/mandate";
import { chains, clock, handoff, objectUrl, setHandoff, trust, trustList, untrust, when } from "../app";
import { readC2pa, type C2paResult } from "../c2pa";

const HEADLINE: Record<Report["verdict"], string> = {
  verified: "Verified capture",
  verifiedWithWarnings: "Verified, with warnings",
  untrustedIssuer: "Signed, issuer not trusted",
  broken: "Broken",
  none: "No provenance found",
};

let engineP: Promise<MandateEngine | null> | undefined;
const engine = () => (engineP ??= MandateEngine.load().catch(() => null));

interface Input {
  file: Uint8Array;
  name: string;
  sidecar?: Uint8Array;
}

export function VerifyPage() {
  const [input, setInput] = useState<Input | null>(() => {
    const h = handoff;
    setHandoff(null);
    return h;
  });
  const [offline, setOffline] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [c2pa, setC2pa] = useState<C2paResult | null>(null);
  const [trustNow, setTrust] = useState<TrustEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => void trustList().then(setTrust), []);

  useEffect(() => {
    if (!input) return;
    let alive = true;
    setBusy(true);
    setError("");
    (async () => {
      const t = await trustList();
      const e = await engine();
      const r = await verifyAsset(input.file, input.sidecar ?? null, {
        now: Date.now(),
        trust: t,
        drand: await chains(),
        ...(offline ? {} : { fetch: httpFetcher("") }),
        ...(e ? { mandates: mandateChecker(e) } : {}),
      });
      if (!alive) return;
      setTrust(t);
      setReport(r);
      setBusy(false);
      resultRef.current?.focus();
      const c = await readC2pa(input.file, sniffMime(input.file) === "application/octet-stream" ? "image/jpeg" : sniffMime(input.file));
      if (alive) setC2pa(c);
    })().catch((e) => {
      if (!alive) return;
      setError(String(e?.message ?? e));
      setBusy(false);
    });
    return () => {
      alive = false;
    };
  }, [input, offline, trustNow.length]);

  const take = async (files: FileList | File[]) => {
    const list = [...files];
    const side = list.find((f) => f.name.endsWith(".capture"));
    const main = list.find((f) => !f.name.endsWith(".capture"));
    if (!main) return setError("Drop the photo too, not only its .capture file.");
    setReport(null);
    setC2pa(null);
    setInput({ file: new Uint8Array(await main.arrayBuffer()), name: main.name, ...(side ? { sidecar: new Uint8Array(await side.arrayBuffer()) } : {}) });
  };

  return (
    <section>
      <h1>Verify a photo</h1>
      <p className="lede">See who signed it, when it can be proven to have been taken, and every change since. The checks run in this browser.</p>
      <div
        className={`drop ${over ? "over" : ""}`}
        style={{ marginTop: 18 }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void take(e.dataTransfer.files);
        }}
      >
        <strong>Drop a photo here, or a photo and its .capture file</strong>
        <div className="row">
          <button onClick={() => fileInput.current?.click()}>Choose files</button>
          <input ref={fileInput} type="file" multiple hidden aria-label="Photo to verify" data-testid="verify-input" onChange={(e) => e.target.files && void take(e.target.files)} />
          <button
            className="quiet"
            onClick={async () => {
              const b = new Uint8Array(await (await fetch("/samples/c2pa-sample.jpg")).arrayBuffer());
              setReport(null);
              setC2pa(null);
              setInput({ file: b, name: "c2pa-sample.jpg" });
            }}
          >
            Try a Content Credentials sample
          </button>
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={offline} onChange={(e) => setOffline(e.target.checked)} />
            Verify offline (use only what's in the file)
          </label>
        </div>
      </div>
      {error && (
        <p className="notice bad" role="alert">
          {error}
        </p>
      )}
      <div ref={resultRef} tabIndex={-1} aria-live="polite" aria-busy={busy}>
        {busy && <p className="muted" style={{ marginTop: 20 }}>Checking {input?.name}…</p>}
        {report && input && !busy && (
          <Result
            report={report}
            input={input}
            c2pa={c2pa}
            onTrust={async (e) => setTrust(await trust(e))}
            onUntrust={async (did) => setTrust(await untrust(did))}
            trustList={trustNow}
          />
        )}
      </div>
    </section>
  );
}

function sentence(r: Report): string {
  const cap = r.chain.find((s) => s.kind === "capture");
  const edits = r.chain.filter((s) => s.kind === "edit");
  if (r.verdict === "none") return "This file carries no Capture credentials, and none were found for it in the registry.";
  if (r.verdict === "broken") {
    const f = r.findings.find((x) => x.level === "fail");
    return f ? f.text : "A check failed.";
  }
  const parts: string[] = [];
  if (cap) {
    const who = cap.signer.label ? `${cap.signer.label}${cap.signer.owner?.name ? ` (${cap.signer.owner.name})` : ""}` : "a device";
    const i = cap.interval;
    if (i.notBefore !== undefined && i.notAfter !== undefined) parts.push(`Taken by ${who} between ${clock(i.notBefore)} and ${clock(i.notAfter)} UTC, ${new Date(i.notAfter).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}.`);
    else if (i.notBefore !== undefined) parts.push(`Taken by ${who} after ${when(i.notBefore)}; nothing proves yet how late.`);
    else if (i.notAfter !== undefined) parts.push(`Taken by ${who} before ${when(i.notAfter)}.`);
    else parts.push(`Taken by ${who}. Its time is only the device's own claim.`);
  }
  for (const e of edits) {
    const n = (e.redactions ?? []).reduce((k, x) => k + x.regions.length, 0);
    const by = e.signer.name || "an editor nobody you trust vouches for";
    if (n) parts.push(`Redacted in ${n === 1 ? "one area" : `${n} areas`} by ${by}.`);
    else parts.push(`Edited by ${by}.`);
  }
  if (r.verdict === "untrustedIssuer") parts.push("Everything checks, but you don't trust whoever vouches for this camera.");
  const warns = r.findings.filter((f) => f.level === "warn");
  if (r.verdict === "verifiedWithWarnings" && warns.length) parts.push(warns.length === 1 ? `One warning: ${warns[0].text[0].toLowerCase()}${warns[0].text.slice(1)}` : `${warns.length} warnings, listed below.`);
  return parts.join(" ");
}

function Result({ report: r, input, c2pa, onTrust, onUntrust, trustList: tl }: { report: Report; input: Input; c2pa: C2paResult | null; onTrust: (e: TrustEntry) => Promise<void>; onUntrust: (did: string) => Promise<void>; trustList: TrustEntry[] }) {
  const cap = r.chain.find((s) => s.kind === "capture");
  const top = r.chain[0];
  const fails = r.findings.filter((f) => f.level === "fail");
  const ownerIssuer = r.issuers.find((i) => i.role === "owner" && !i.trusted);
  const trustedOwner = r.issuers.find((i) => i.role === "owner" && i.trusted);
  return (
    <>
      <div className={`verdict ${r.verdict}`} data-testid="verdict" data-verdict={r.verdict}>
        <h2>{HEADLINE[r.verdict]}</h2>
        <p className="sentence">{sentence(r)}</p>
        <div className="row" style={{ marginTop: 10 }}>
          {ownerIssuer && (
            <button onClick={() => onTrust({ did: ownerIssuer.did, name: ownerIssuer.name ?? ownerIssuer.did, trustedFor: ["owner", "editor", "installer"] })}>Trust {ownerIssuer.name || "this owner"}</button>
          )}
          {trustedOwner && tl.some((t) => t.did === trustedOwner.did) && (
            <button className="quiet" onClick={() => onUntrust(trustedOwner.did)}>
              Stop trusting {trustedOwner.name || "this owner"}
            </button>
          )}
          <span className="muted small">
            {input.name} · fingerprint <span className="hash">{r.contentHash.slice(0, 16)}…</span> ·{" "}
            {r.storeSource === "embedded" ? "credentials inside the file" : r.storeSource === "sidecar" ? "credentials from the .capture file" : r.storeSource === "registry" ? "credentials found in the registry" : "no credentials"}
          </span>
        </div>
      </div>
      {r.verdict === "none" ? (
        <div className="report">
          <LightTable input={input} step={undefined} />
          <div>
            <C2paCard c2pa={c2pa} />
          </div>
        </div>
      ) : (
        <div className="report">
          <LightTable input={input} step={top} />
          <div>
            {fails.length > 0 && (
              <section className="card" aria-labelledby="breaks" style={{ borderColor: "var(--break)" }}>
                <h3 id="breaks" className="broken-text">
                  What's broken
                </h3>
                <ul className="findings">
                  {fails.map((f, i) => (
                    <li key={i} className="fail">
                      {f.text}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {cap && <DeviceCard step={cap} />}
            {cap && <TimeCard step={cap} />}
            <EditsCard chain={r.chain} />
            {cap && <LocationCard step={cap} />}
            <section className="card" aria-labelledby="checks">
              <h3 id="checks">Every check</h3>
              <ul className="findings">
                {r.findings.map((f: Finding, i) => (
                  <li key={i} className={f.level}>
                    {f.text}
                  </li>
                ))}
              </ul>
            </section>
            <C2paCard c2pa={c2pa} />
            <Raw report={r} />
          </div>
        </div>
      )}
    </>
  );
}

function LightTable({ input, step }: { input: Input; step: ChainStep | undefined }) {
  const mime = sniffMime(input.file);
  const url = useMemo(() => objectUrl(input.file, mime === "application/octet-stream" ? "image/jpeg" : mime), [input.file, mime]);
  const [overlay, setOverlay] = useState(true);
  const t = step?.tiles;
  const proof = step?.kind === "edit" ? (step.claim as { tileProof?: { offset: [number, number] } }).tileProof : undefined;
  const w = step?.content.width ?? 1;
  const h = step?.content.height ?? 1;
  return (
    <figure className="lighttable" style={{ margin: 0 }}>
      <div className="frame">
        <img src={url} alt={`The file being verified: ${input.name}`} />
        {t && proof && overlay && (
          <svg className="tile-overlay" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true" data-testid="tile-overlay">
            <defs>
              <pattern id="hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="10" height="10" fill="rgba(185,119,14,0.28)" />
                <line x1="0" y1="0" x2="0" y2="10" stroke="#9a6209" strokeWidth="4" />
              </pattern>
            </defs>
            {t.map.map((m, i) => {
              if (m === "cropped") return null;
              const r = tileRect(t.grid, i);
              const x = r.x - proof.offset[0] * t.grid.size;
              const y = r.y - proof.offset[1] * t.grid.size;
              if (m === "kept") return <rect key={i} x={x} y={y} width={r.w} height={r.h} fill="none" stroke="rgba(31,78,140,0.35)" strokeWidth={Math.max(1, w / 900)} />;
              if (m === "redacted") return <rect key={i} x={x} y={y} width={r.w} height={r.h} fill="url(#hatch)" stroke="#9a6209" strokeWidth={Math.max(1.5, w / 500)} />;
              return <rect key={i} x={x} y={y} width={r.w} height={r.h} fill="rgba(179,38,30,0.35)" stroke="#b3261e" strokeWidth={Math.max(2, w / 300)} />;
            })}
          </svg>
        )}
      </div>
      {t && proof && (
        <figcaption>
          <div className="legend">
            <span>
              <i style={{ border: "1px solid var(--proof)" }} />
              {t.kept} tiles exactly as the camera captured them
            </span>
            <span>
              <i style={{ background: "repeating-linear-gradient(45deg, #9a6209 0 3px, #f3e6cc 3px 7px)" }} />
              {t.redacted} redacted
            </span>
            {t.cropped > 0 && <span>{t.cropped} cropped away</span>}
            {t.failures.length > 0 && (
              <span className="broken-text">
                <i style={{ background: "var(--break)" }} />
                {t.failures.length} changed without saying so
              </span>
            )}
          </div>
          <label className="row small" style={{ gap: 6, marginTop: 8 }}>
            <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />
            Show the tile map
          </label>
        </figcaption>
      )}
    </figure>
  );
}

function DeviceCard({ step }: { step: ChainStep }) {
  const s = step.signer;
  const keyStatus =
    s.keyStatus === "current"
      ? "Still the device's current key."
      : s.keyStatus === "retiredAnchored"
        ? "Retired later by the owner; this photo was anchored before that."
        : s.keyStatus === "retiredUnanchored"
          ? "Retired later by the owner, and nothing proves this was signed before."
          : s.keyStatus === "retiredAfter"
            ? "Retired by the owner before this was signed."
            : "Unknown";
  return (
    <section className="card" aria-labelledby="device">
      <h3 id="device">Device</h3>
      <dl className="facts">
        <dt>Camera</dt>
        <dd>{s.label || <span className="claimed">no name: no owner vouches for it</span>}</dd>
        <dt>Owner</dt>
        <dd>
          {s.owner ? (
            <>
              {s.owner.name} {s.owner.trusted ? <span className="proven">(you trust them)</span> : <span className="muted">(not on your trust list)</span>}
              {s.owner.revoked && <span className="broken-text"> credential revoked</span>}
            </>
          ) : (
            <span className="claimed">none</span>
          )}
        </dd>
        <dt>Model</dt>
        <dd>{s.maker ? `${s.maker.model}, by ${s.maker.name}${s.maker.trusted ? "" : " (maker not trusted)"}` : "not stated"}</dd>
        <dt>Key</dt>
        <dd>
          {KEY_CLASS_WORDS[s.keyClass ?? ""] ?? "Unknown kind of key."}
          {s.keyClassEvidence === "self-reported" && <span className="muted"> The device says so itself; nobody checked the hardware.</span>}
        </dd>
        <dt>Key history</dt>
        <dd className={s.keyStatus === "retiredAfter" ? "broken-text" : s.keyStatus === "retiredUnanchored" ? "claimed" : ""}>{keyStatus}</dd>
        <dt>Identifier</dt>
        <dd className="hash">{s.id}</dd>
      </dl>
    </section>
  );
}

function TimeCard({ step }: { step: ChainStep }) {
  const i = step.interval;
  const dt = step.deviceTime;
  const lo = i.notBefore;
  const hi = i.notAfter;
  const wrong = (lo !== undefined && dt < lo - 120_000) || (hi !== undefined && dt > hi + 120_000);
  // the axis: the proven interval, padded; the device clock is drawn off-scale when it's far away
  const a = lo ?? hi ?? dt;
  const b = hi ?? lo ?? dt;
  const pad = Math.max(10_000, (b - a) * 0.35);
  const x0 = a - pad;
  const x1 = b + pad;
  const X = (t: number) => 20 + ((t - x0) / (x1 - x0)) * 560;
  const off = dt < x0 ? "left" : dt > x1 ? "right" : null;
  return (
    <section className="card" aria-labelledby="time">
      <h3 id="time">Time</h3>
      <p>
        {lo !== undefined && hi !== undefined ? (
          <>
            Captured between <span className="proven">{when(lo)}</span> and <span className="proven">{when(hi)}</span>.
          </>
        ) : lo !== undefined ? (
          <>
            Captured after <span className="proven">{when(lo)}</span>. No anchor yet proves how late.
          </>
        ) : hi !== undefined ? (
          <>
            Captured before <span className="proven">{when(hi)}</span>.
          </>
        ) : (
          <>Nothing proves when this was captured.</>
        )}
      </p>
      <div className="timeaxis" role="img" aria-label={`Proven interval ${lo ? when(lo) : "open"} to ${hi ? when(hi) : "open"}; the device clock said ${when(dt)}${wrong ? ", which is outside it" : ""}.`}>
        <svg viewBox="0 0 600 74">
          <line x1="20" x2="580" y1="40" y2="40" stroke="var(--rule)" strokeWidth="2" />
          {lo !== undefined && hi !== undefined && <rect x={X(lo)} y="32" width={Math.max(2, X(hi) - X(lo))} height="16" fill="var(--proof)" rx="2" />}
          {lo !== undefined && hi === undefined && <rect x={X(lo)} y="32" width={580 - X(lo)} height="16" fill="var(--proof-wash)" />}
          {lo !== undefined && <text x={X(lo)} y="22" textAnchor="middle" fontSize="12" fill="var(--proof)">{`not before ${clock(lo)}`}</text>}
          {hi !== undefined && <text x={X(hi)} y="68" textAnchor="middle" fontSize="12" fill="var(--proof)">{`not after ${clock(hi)}`}</text>}
          {off === null ? (
            <g>
              <line x1={X(dt)} x2={X(dt)} y1="26" y2="54" stroke={wrong ? "var(--break)" : "var(--pencil)"} strokeWidth="2" strokeDasharray="3 2" />
              <text x={X(dt)} y={lo !== undefined ? 68 : 22} dx={hi !== undefined ? 0 : 0} textAnchor="middle" fontSize="12" fill="var(--pencil)" opacity={hi !== undefined ? 0 : 1}>
                device clock
              </text>
            </g>
          ) : (
            <g>
              <path d={off === "left" ? "M24 40 l10 -7 v14 z" : "M576 40 l-10 -7 v14 z"} fill="var(--break)" />
            </g>
          )}
        </svg>
      </div>
      <dl className="facts small">
        <dt>Earliest</dt>
        <dd>{i.notBeforeWhy ?? <span className="claimed">no time beacon</span>}</dd>
        <dt>Latest</dt>
        <dd>{i.notAfterWhy ?? <span className="claimed">not anchored by witnesses yet</span>}</dd>
        <dt>Device clock</dt>
        <dd>
          <span className={wrong ? "struck" : ""}>{when(dt)}</span> <span className={wrong ? "broken-text" : "claimed"}>{wrong ? "wrong: outside what can be proven" : "a claim"}</span>
        </dd>
      </dl>
    </section>
  );
}

function EditsCard({ chain }: { chain: ChainStep[] }) {
  const steps = [...chain].reverse();
  return (
    <section className="card" aria-labelledby="edits">
      <h3 id="edits">From the camera to this file</h3>
      <div className="filmstrip">
        <ol aria-label="Edit chain, oldest first">
          {steps.map((s, k) => (
            <li key={s.id} className={s.ok ? "" : "bad"}>
              <span className="edge">
                {k + 1}. {s.kind === "capture" ? "Captured" : "Edited"} {clock(s.interval.notBefore ?? s.deviceTime)}
              </span>
              <span className="what">
                {s.kind === "capture"
                  ? `${s.content.width}×${s.content.height} ${s.content.mime.replace("image/", "").toUpperCase()}`
                  : describeActions(s)}
              </span>
              <span className="who">{s.kind === "capture" ? s.signer.label || "unnamed device" : `${s.signer.name || "unknown editor"}${s.signer.editorOf?.name ? `, for ${s.signer.editorOf.name}` : ""}`}</span>
              {s.redactions?.map((x, i) => x.reason && <span key={i} className="who">“{x.reason}”</span>)}
            </li>
          ))}
          <li style={{ flexBasis: 150, background: "transparent", border: "1px dashed #6f7f8b" }}>
            <span className="edge">This file</span>
            <span className="who">{chain[0]?.content.width}×{chain[0]?.content.height}</span>
          </li>
        </ol>
      </div>
      {chain.length === 1 && <p className="muted small" style={{ marginTop: 8 }}>No edits: this is the file the camera wrote.</p>}
    </section>
  );
}

function describeActions(s: ChainStep): string {
  const names: Record<string, string> = { "capture.redactedRegion": "redacted", "c2pa.cropped": "cropped", "c2pa.converted": "saved as PNG", "c2pa.resized": "resized", "c2pa.filtered": "filtered", "c2pa.adjustedColor": "colour adjusted" };
  const done = (s.actions ?? []).map((a) => names[a.action]).filter(Boolean);
  return done.length ? done.join(", ") : "opened";
}

function LocationCard({ step }: { step: ChainStep }) {
  const l = step.location;
  return (
    <section className="card" aria-labelledby="loc">
      <h3 id="loc">Location</h3>
      {l ? (
        <p>
          <span className="claimed">Claimed by the device</span> ({l.source}): {l.lat.toFixed(4)}, {l.lon.toFixed(4)}
          {l.accuracyM ? `, within about ${Math.round(l.accuracyM)} m` : ""}. A browser can be told any position, so this is not proof.
        </p>
      ) : (
        <p className="muted">Not given. The camera had location turned off.</p>
      )}
    </section>
  );
}

function C2paCard({ c2pa }: { c2pa: C2paResult | null }) {
  return (
    <section className="card" aria-labelledby="c2pa" data-testid="c2pa-card">
      <h3 id="c2pa">Content Credentials (C2PA)</h3>
      {!c2pa ? (
        <p className="muted">Reading…</p>
      ) : c2pa.present ? (
        <>
          <p>
            Present, signed by <strong>{c2pa.signer ?? "an unnamed certificate"}</strong>, {c2pa.trusted ? <span className="proven">on the C2PA trust list</span> : <span className="muted">not on your trust list</span>}.
          </p>
          <dl className="facts small">
            <dt>Made with</dt>
            <dd>{c2pa.claimGenerator ?? "not stated"}</dd>
            <dt>Validation</dt>
            <dd>{c2pa.state}</dd>
            {c2pa.actions?.length ? (
              <>
                <dt>Actions</dt>
                <dd>{c2pa.actions.join(", ")}</dd>
              </>
            ) : null}
          </dl>
          <p className="muted small">Shown for comparison. It doesn't change Capture's verdict.</p>
        </>
      ) : (
        <p className="muted">{c2pa.error ? `Couldn't be read: ${c2pa.error}` : "None in this file."}</p>
      )}
    </section>
  );
}

function Raw({ report }: { report: Report }) {
  const json = useMemo(
    () =>
      JSON.stringify(
        {
          verdict: report.verdict,
          contentHash: report.contentHash,
          chain: report.chain.map((s) => ({ id: s.id, kind: s.kind, signer: s.signer, interval: s.interval, claim: s.claim })),
          credentials: report.store?.credentials.map((c) => ({ type: credentialKind(c), issuer: c.issuer, subject: c.credentialSubject })),
          findings: report.findings,
        },
        (_, v) => (v instanceof Uint8Array ? `h'${[...v].map((x) => x.toString(16).padStart(2, "0")).join("")}'` : v),
        2,
      ),
    [report],
  );
  return (
    <details className="card raw">
      <summary>Raw manifests and credentials</summary>
      <pre>{json}</pre>
    </details>
  );
}
