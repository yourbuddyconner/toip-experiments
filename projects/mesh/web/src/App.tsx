import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtBytes, fmtMs, type MessageSizes, type Trace, type TraceFrame, type TraceLog, type TraceNode } from "../../src/trace";
import { FADE_MS, HOP_MS, skipLabel, timeline, type Timeline } from "./timeline";

const ACTS = [
  { n: 1, name: "The door", about: "A guest pass checked at a door with no internet, then a replay attack." },
  { n: 2, name: "The cabin", about: "A Settle attestation over two radio hops to a gateway and the relay." },
  { n: 3, name: "By hand", about: "The gateway is down: a sealed bundle on a USB stick." },
] as const;

const SPEEDS = [
  { v: 0.1, label: "0.1×" },
  { v: 0.25, label: "0.25×" },
  { v: 1, label: "1×" },
  { v: 4, label: "4×" },
];

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function App() {
  const [act, setAct] = useState<1 | 2 | 3 | null>(null);
  const [loss, setLoss] = useState(0);
  const [seed, setSeed] = useState(1);
  const [speed, setSpeed] = useState(0.25);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [d, setD] = useState(0);
  const [playing, setPlaying] = useState(false);
  const tl = useMemo(() => (trace ? timeline(trace) : null), [trace]);

  const run = useCallback(
    async (n: 1 | 2 | 3) => {
      setAct(n);
      setBusy(true);
      setError(null);
      setPlaying(false);
      try {
        const r = await fetch(`/api/act/${n}?loss=${loss}&seed=${seed}`);
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `the server answered ${r.status}`);
        setTrace(body as Trace);
        setD(0);
        setPlaying(true);
      } catch (e) {
        setError(`Act ${n} didn't run: ${(e as Error).message}. Is the server still running?`);
      } finally {
        setBusy(false);
      }
    },
    [loss, seed],
  );

  // The playback clock. Breaks (long quiet stretches) play at a fixed pace, whatever the speed.
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!playing || !tl) return;
    let raf = 0;
    const tick = (now: number) => {
      const dt = last.current === null ? 0 : now - last.current;
      last.current = now;
      setD((prev) => {
        const next = prev + dt * (tl.inBreak(prev) ? 1 : speed);
        if (next >= tl.total) {
          setPlaying(false);
          return tl.total;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      last.current = null;
    };
  }, [playing, tl, speed]);

  const done = !!tl && d >= tl.total;
  const togglePlay = () => {
    if (!tl) return;
    if (done) setD(0);
    setPlaying((p) => !p || done);
  };

  return (
    <div className="shell">
      <header className="bar">
        <div className="brand">
          <svg viewBox="0 0 32 32" aria-hidden="true" className="brand-mark">
            <path d="M16 18 L16 30" />
            <path d="M10 30 L22 30" />
            <circle cx="16" cy="15" r="2.5" />
            <path d="M10.5 9.5 a8 8 0 0 0 0 11" />
            <path d="M21.5 9.5 a8 8 0 0 1 0 11" />
            <path d="M6.5 5.5 a13.5 13.5 0 0 0 0 19" />
            <path d="M25.5 5.5 a13.5 13.5 0 0 1 0 19" />
          </svg>
          <div>
            <h1>Mesh field simulator</h1>
            <p>Trust Tasks and TSP over LoRa, US915, SF8 at 500 kHz. Simulated time.</p>
          </div>
        </div>
        <nav className="acts" aria-label="Acts">
          {ACTS.map((a) => (
            <button key={a.n} type="button" className={`act${act === a.n ? " current" : ""}`} aria-pressed={act === a.n} disabled={busy} onClick={() => run(a.n)} title={a.about}>
              <span className="act-n">Act {a.n}</span>
              <span className="act-name">Run {a.name.toLowerCase()}</span>
            </button>
          ))}
        </nav>
      </header>

      <main className="deck">
        <section className="field" aria-label="Field map">
          <FieldMap trace={trace} tl={tl} d={d} busy={busy} act={act} />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>

        <aside className="housing" aria-label="Controls and meters">
          <fieldset className="controls" disabled={busy}>
            <legend>Radio conditions</legend>
            <label className="slider">
              <span>Frame loss</span>
              <input type="range" min={0} max={0.5} step={0.05} value={loss} onChange={(e) => setLoss(Number(e.target.value))} aria-valuetext={`${Math.round(loss * 100)} percent`} />
              <output>{Math.round(loss * 100)}%</output>
            </label>
            <label className="seed">
              <span>Seed</span>
              <input type="number" min={0} max={9999} value={seed} onChange={(e) => setSeed(Math.max(0, Math.min(9999, Number(e.target.value) || 0)))} />
            </label>
            <p className="hint">Changes apply to the next run.</p>
          </fieldset>

          <div className="transport" role="group" aria-label="Playback">
            <button type="button" className="play" onClick={togglePlay} disabled={!tl}>
              {playing ? "Pause" : done ? "Play again" : "Play"}
            </button>
            <label className="speed">
              <span>Speed</span>
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                {SPEEDS.map((s) => (
                  <option key={s.v} value={s.v}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <Meters trace={trace} tl={tl} d={d} />
        </aside>

        <section className="strip-wrap" aria-label="Airtime strip">
          <AirtimeStrip trace={trace} tl={tl} d={d} onSeek={(x) => (setD(x), setPlaying(false))} />
        </section>

        <section className="log-wrap" aria-label="What happened">
          <Log trace={trace} tl={tl} d={d} />
          {trace && <Summary trace={trace} visible={done} />}
        </section>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------- the map

/** Topographic contours: fixed, irregular rings around two hills. */
function contours(): string[] {
  const out: string[] = [];
  const hills = [
    { cx: 330, cy: 210, rx: 330, ry: 220, seed: 1 },
    { cx: 760, cy: 420, rx: 260, ry: 170, seed: 2 },
  ];
  for (const h of hills) {
    for (let k = 1; k <= 7; k++) {
      const f = k / 7;
      const pts: string[] = [];
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        const wob = 1 + 0.07 * Math.sin(3 * a + h.seed + k) + 0.05 * Math.cos(5 * a - k * 0.7);
        pts.push(`${(h.cx + Math.cos(a) * h.rx * f * wob).toFixed(1)},${(h.cy + Math.sin(a) * h.ry * f * wob).toFixed(1)}`);
      }
      out.push(`M${pts.join(" L")}Z`);
    }
  }
  return out;
}
const CONTOURS = contours();

const isRadio = (n: TraceNode) => !!n.radio;

function NodeMark({ n, transmitting }: { n: TraceNode; transmitting: boolean }) {
  const down = /down/.test(n.note ?? "");
  const cls = `node role-${n.role}${transmitting ? " tx" : ""}${down ? " down" : ""}`;
  return (
    <g className={cls} transform={`translate(${n.x} ${n.y})`}>
      {isRadio(n) ? (
        <>
          <line x1={0} y1={-6} x2={0} y2={-26} className="mast" />
          <circle cx={0} cy={-28} r={3.2} className="lamp" />
          <path d="M-13 9 L0 -9 L13 9 Z" className="marker" />
        </>
      ) : (
        <rect x={-11} y={-11} width={22} height={22} rx={2} className="marker" />
      )}
      <text y={30} className="label">
        {n.label}
      </text>
      {n.note && (
        <text y={46} className="note">
          {n.note}
        </text>
      )}
    </g>
  );
}

function FieldMap({ trace, tl, d, busy, act }: { trace: Trace | null; tl: Timeline | null; d: number; busy: boolean; act: number | null }) {
  const reduce = reducedMotion();
  const nodes = new Map((trace?.nodes ?? []).map((n) => [n.id, n]));
  const active = trace && tl ? trace.frames.filter((f) => d >= tl.toD(f.at) && d <= tl.toD(f.at + f.airtimeMs) + FADE_MS) : [];
  const hops = trace && tl ? trace.hops.filter((h) => d >= tl.toD(h.at) && d <= tl.toD(h.at) + HOP_MS) : [];
  const tx = new Set(active.filter((f) => d <= tl!.toD(f.at + f.airtimeMs)).map((f) => f.from));
  const v = tl ? tl.toV(d) : 0;
  const describe = trace
    ? `${trace.title}. ${trace.nodes.map((n) => n.label).join(", ")}. ${trace.frames.filter((f) => f.at <= v).length} of ${trace.frames.length} frames sent so far.`
    : "No act has run yet.";
  return (
    <svg viewBox="0 0 1000 600" className="map" role="img" aria-label={describe}>
      <rect width={1000} height={600} className="paper" />
      <g className="contours">
        {CONTOURS.map((p, i) => (
          <path key={i} d={p} />
        ))}
      </g>
      <g className="grid">
        {Array.from({ length: 9 }, (_, i) => (
          <text key={`x${i}`} x={(i + 1) * 100} y={14}>
            {(i + 1) * 100} m
          </text>
        ))}
      </g>
      {!trace && (
        <g className="empty">
          <text x={500} y={290}>
            {busy ? `Running act ${act} on the simulator…` : "Choose an act above to run it on the simulator."}
          </text>
          <text x={500} y={318} className="empty-sub">
            Frames, airtime and sizes come from the real mesh library and trust core.
          </text>
        </g>
      )}
      {trace && (
        <>
          <g className="ranges">
            {trace.links.map(([a, b]) => {
              const na = nodes.get(a)!;
              const nb = nodes.get(b)!;
              return <line key={`${a}-${b}`} x1={na.x} y1={na.y - 28} x2={nb.x} y2={nb.y - 28} />;
            })}
          </g>
          <g className="wires">
            {trace.nodes
              .filter((n) => !isRadio(n))
              .flatMap((n) =>
                trace.hops
                  .filter((h) => h.to === n.id || h.from === n.id)
                  .map((h) => {
                    const a = nodes.get(h.from)!;
                    const b = nodes.get(h.to)!;
                    return <line key={`${h.from}-${h.to}-${n.id}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={h.via} />;
                  }),
              )}
          </g>
          <g className="frames">
            {active.map((f, i) => (
              <Pulse key={`${f.at}-${f.from}-${i}`} f={f} nodes={nodes} tl={tl!} d={d} reduce={reduce} />
            ))}
          </g>
          <g className="hops">
            {hops.map((h, i) => {
              const a = nodes.get(h.from)!;
              const b = nodes.get(h.to)!;
              const p = Math.min(1, (d - tl!.toD(h.at)) / (HOP_MS * 0.8));
              return (
                <g key={`${h.at}-${i}`} className={`hop ${h.via}`}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                  <circle cx={a.x + (b.x - a.x) * p} cy={a.y + (b.y - a.y) * p} r={7} />
                  <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 12}>
                    {h.via === "usb" ? "USB stick" : "internet"} · {fmtBytes(h.bytes)}
                  </text>
                </g>
              );
            })}
          </g>
          <g className="nodes">
            {trace.nodes.map((n) => (
              <NodeMark key={n.id} n={n} transmitting={tx.has(n.id)} />
            ))}
          </g>
          <text x={984} y={588} className="clock" textAnchor="end">
            t = {(v / 1000).toFixed(3)} s
          </text>
        </>
      )}
    </svg>
  );
}

function Pulse({ f, nodes, tl, d, reduce }: { f: TraceFrame; nodes: Map<string, TraceNode>; tl: Timeline; d: number; reduce: boolean }) {
  const s = nodes.get(f.from);
  if (!s) return null;
  const start = tl.toD(f.at);
  const end = tl.toD(f.at + f.airtimeMs);
  const p = Math.min(1, (d - start) / Math.max(1, end - start));
  const fading = d > end ? 1 - (d - end) / FADE_MS : 1;
  const R = 150;
  return (
    <g className={`pulse type-${f.type}${f.attack ? " attack" : ""}`} opacity={Math.max(0, fading)}>
      <circle cx={s.x} cy={s.y - 28} r={reduce ? R * 0.6 : 8 + p * R} className="ring" />
      {d > end &&
        f.heard.map((h) => {
          const r = nodes.get(h.to);
          if (!r) return null;
          const mx = (s.x + r.x) / 2;
          const my = (s.y + r.y) / 2 - 28;
          return (
            <g key={h.to} className={h.ok ? "got" : "lost"}>
              <line x1={s.x} y1={s.y - 28} x2={r.x} y2={r.y - 28} />
              {h.ok ? (
                <circle cx={r.x} cy={r.y - 28} r={6} />
              ) : (
                <>
                  <path d={`M${mx - 6} ${my - 6} L${mx + 6} ${my + 6} M${mx + 6} ${my - 6} L${mx - 6} ${my + 6}`} />
                  <text x={mx} y={my - 10}>
                    {h.reason}
                  </text>
                </>
              )}
            </g>
          );
        })}
      <text x={s.x} y={s.y - 44} className="frame-label">
        {f.attack ? "replay · " : ""}
        {f.label} · {f.bytes} B · {Math.round(f.airtimeMs)} ms
      </text>
    </g>
  );
}

// ---------------------------------------------------------------- meters

function Meters({ trace, tl, d }: { trace: Trace | null; tl: Timeline | null; d: number }) {
  if (!trace || !tl) return <p className="meters-empty">Meters show each radio's airtime once an act runs.</p>;
  const v = tl.toV(d);
  const radios = trace.nodes.filter(isRadio);
  return (
    <ul className="meters" aria-label="Airtime per radio">
      {radios.map((n) => {
        const sent = trace.frames.filter((f) => f.from === n.id && f.at <= v);
        const air = sent.reduce((s, f) => s + Math.min(f.airtimeMs, Math.max(0, v - f.at)), 0);
        const longest = sent.reduce((m, f) => Math.max(m, f.airtimeMs), 0);
        const share = n.radio!.budgetMsPerHour;
        const frac = air / share;
        const transmitting = sent.some((f) => v < f.at + f.airtimeMs);
        const SEG = 20;
        const lit = Math.min(SEG, Math.ceil((frac / 0.01) * SEG - 1e-9));
        return (
          <li key={n.id} className={`meter${transmitting ? " tx" : ""}`}>
            <div className="meter-head">
              <span className="lamp" aria-hidden="true" />
              <strong>{n.label}</strong>
              <span className="meter-air">{fmtMs(air)}</span>
            </div>
            <div className="segments" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={Math.min(1, frac / 0.01)} aria-label={`${n.label}: ${(frac * 100).toFixed(2)}% of its hourly airtime share`}>
              {Array.from({ length: SEG }, (_, i) => (
                <span key={i} className={i < lit ? "on" : ""} />
              ))}
            </div>
            <p className="meter-note">
              {(frac * 100).toFixed(2)}% of its hourly share (1% full scale), {sent.length} {sent.length === 1 ? "frame" : "frames"}, longest {Math.round(longest)} ms of the {n.radio!.maxFrameMs ?? "∞"} ms limit
            </p>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- the airtime strip

function AirtimeStrip({ trace, tl, d, onSeek }: { trace: Trace | null; tl: Timeline | null; d: number; onSeek: (d: number) => void }) {
  if (!trace || !tl) return <div className="strip strip-empty">The airtime strip draws each radio's transmissions, to scale, as the act plays.</div>;
  const radios = trace.nodes.filter(isRadio);
  const W = 1000;
  const lane = 22;
  const top = 18;
  const H = top + radios.length * lane + 8;
  const x = (dd: number) => (dd / tl.total) * W;
  return (
    <div className="strip">
      <div className="strip-names" aria-hidden="true" style={{ paddingTop: `${(top / H) * 8.5}rem` }}>
        {radios.map((n) => (
          <span key={n.id} style={{ height: `${(lane / H) * 8.5}rem` }}>
            {n.label}
          </span>
        ))}
      </div>
      <div className="strip-body">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="strip-svg"
        aria-hidden="true"
        onClick={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          onSeek(((e.clientX - r.left) / r.width) * tl.total);
        }}
      >
        {radios.map((n, i) => (
          <g key={n.id}>
            <rect x={0} y={top + i * lane} width={W} height={lane - 4} className="lane" />
            {trace.frames
              .filter((f) => f.from === n.id)
              .map((f, j) => {
                const x0 = x(tl.toD(f.at));
                const x1 = x(tl.toD(f.at + f.airtimeMs));
                const allLost = f.heard.length > 0 && f.heard.every((h) => !h.ok);
                return <rect key={j} x={x0} y={top + i * lane + 2} width={Math.max(1.2, x1 - x0)} height={lane - 8} className={`burst type-${f.type}${f.attack ? " attack" : ""}${allLost ? " lost" : ""}`} />;
              })}
          </g>
        ))}
        {tl.breaks.map((b, i) => (
          <g key={i} className="break">
            <rect x={x(b.d0)} y={top - 2} width={Math.max(2, x(b.d1) - x(b.d0))} height={H - top} />
          </g>
        ))}
        <line x1={x(d)} x2={x(d)} y1={4} y2={H} className="playhead" />
      </svg>
      <div className="strip-breaks" aria-hidden="true">
        {tl.breaks
          .filter((b, i, all) => i === 0 || b.d0 - all[i - 1].d0 > tl.total * 0.09)
          .map((b, i) => (
            <span key={i} style={{ left: `${(x(b.d0) / W) * 100}%` }}>
              {skipLabel(b.skippedMs)}
            </span>
          ))}
      </div>
      <label className="scrub">
        <span className="sr-only">Position in the act</span>
        <input type="range" min={0} max={Math.round(tl.total)} step={10} value={Math.round(d)} onChange={(e) => onSeek(Number(e.target.value))} aria-valuetext={`${(tl.toV(d) / 1000).toFixed(1)} seconds of simulated time`} />
      </label>
      </div>
      <ul className="strip-key" aria-label="Key to the airtime strip">
        <li>
          <i className="k-data" /> data frame
        </li>
        <li>
          <i className="k-ack" /> acknowledgement
        </li>
        <li>
          <i className="k-beacon" /> beacon
        </li>
        <li>
          <i className="k-attack" /> replayed by an attacker
        </li>
        <li>
          <i className="k-break" /> quiet time, shortened
        </li>
        <li>Width is airtime. Faded: nobody received it.</li>
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- the log

const WHO_ROLE: Record<string, string> = {};

function Log({ trace, tl, d }: { trace: Trace | null; tl: Timeline | null; d: number }) {
  const listRef = useRef<HTMLOListElement>(null);
  const v = tl ? tl.toV(d) : 0;
  const shown = trace ? trace.log.filter((l) => l.at <= v + 0.5) : [];
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length]);
  if (!trace) return <p className="log-empty">The narration and each message's sizes appear here.</p>;
  const label = (id: string) => trace.nodes.find((n) => n.id === id)?.label ?? id;
  for (const n of trace.nodes) WHO_ROLE[n.id] = n.role;
  return (
    <div className="log">
      <h2>
        Act {trace.act}: {trace.title}
        <span className="log-sub">
          {trace.subtitle}. Plan {trace.plan}, frame loss {Math.round(trace.loss * 100)}%, seed {trace.seed}.
        </span>
      </h2>
      <ol ref={listRef} aria-live="polite" aria-relevant="additions">
        {shown.map((l, i) => (
          <LogEntry key={i} l={l} who={label(l.who)} />
        ))}
      </ol>
    </div>
  );
}

function LogEntry({ l, who }: { l: TraceLog; who: string }) {
  return (
    <li className={`entry tone-${l.tone}`}>
      <span className="when">{(l.at / 1000).toFixed(3)} s</span>
      <span className={`who role-${WHO_ROLE[l.who] ?? "x"}`}>{who}</span>
      <span className="what">
        {l.text}
        {l.sizes && <SizeBars s={l.sizes} />}
      </span>
    </li>
  );
}

/** The same message three ways, to one scale, with the cuts where 250-byte frames would split it. */
function SizeBars({ s }: { s: MessageSizes }) {
  const max = s.jsonSealed;
  const per = 242;
  const rows: { name: string; bytes: number; frames?: number; cls: string }[] = [
    { name: "sealed, JSON body", bytes: s.jsonSealed, frames: s.jsonFrames, cls: "json" },
    { name: "sealed, CTT1 body", bytes: s.compactSealed, cls: "ctt1" },
    ...(s.packet ? [{ name: `on the air, ${s.packet.kind.toUpperCase()}`, bytes: s.packet.bytes, frames: s.packet.frames, cls: "air" }] : []),
  ];
  return (
    <span className="sizes" role="table" aria-label={`Sizes of ${s.what}`}>
      {rows.map((r) => (
        <span className="size-row" role="row" key={r.name}>
          <span className="size-name" role="rowheader">
            {r.name}
          </span>
          <span className="size-bar" role="cell" aria-label={`${fmtBytes(r.bytes)}${r.frames ? `, ${r.frames} frames` : ""}`}>
            <span className={`fill ${r.cls}`} style={{ width: `${(r.bytes / max) * 100}%` }}>
              {r.frames && r.cls !== "ctt1"
                ? Array.from({ length: Math.ceil(r.bytes / per) - 1 }, (_, i) => <i key={i} style={{ left: `${(((i + 1) * per) / r.bytes) * 100}%` }} />)
                : null}
            </span>
          </span>
          <span className="size-num" role="cell">
            {fmtBytes(r.bytes)}
            {r.frames ? ` · ${r.frames} frames` : ""}
          </span>
        </span>
      ))}
    </span>
  );
}

function Summary({ trace, visible }: { trace: Trace; visible: boolean }) {
  if (!visible)
    return (
      <div className="summary">
        <p className="summary-wait">The results appear when the act has played to the end. Drag the position slider to the end to see them now.</p>
      </div>
    );
  return (
    <div className="summary shown" role="status">
      <p className={`verdict ${trace.summary.ok ? "ok" : "bad"}`}>
        {trace.summary.ok ? "Act complete" : "The act didn't complete"}: {fmtMs(trace.summary.airtimeMs)} of airtime, {trace.summary.frames} frames, {trace.summary.retries} retries.
      </p>
      <dl>
        {trace.summary.facts.map((f) => (
          <div key={f.label}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
