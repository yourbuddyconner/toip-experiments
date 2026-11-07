/** The sensor dashboard (design §15.5): every frame is checked in this browser; the server only carries them. */
import { useCallback, useEffect, useState } from "react";
import { b64, backfillRanges, httpFetcher, verifySensorFeed, type ReadingResult, type SensorCheck } from "../../../src/core";
import { chains, clock, trustList, when } from "../app";

interface Feed {
  sensors: Parameters<typeof verifySensorFeed>[0]["sensors"];
  gateway: { id: string; publicKey: string };
  loss: number;
  evil: boolean;
  stats: { bytes: { reading: number; seal: number } };
}

const STATUS_WORDS: Record<ReadingResult["status"], string> = {
  verified: "verified",
  pending: "pending",
  unlinked: "unlinked",
  invalid: "invalid",
  equivocation: "equivocation",
};

const post = (path: string, body: unknown) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function SensorsPage() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [checks, setChecks] = useState<SensorCheck[] | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const s = (await (await fetch("/api/sensors")).json()) as Feed;
      const frames = await (await fetch("/api/sensors/frames?since=0")).json();
      const recent = frames.frames.slice(-2500);
      const c = await verifySensorFeed(
        { sensors: s.sensors, frames: recent, rounds: frames.rounds, gateway: s.gateway },
        { chains: await chains(), keyLog: httpFetcher("").keyLog, trust: await trustList(), now: Date.now() },
      );
      setFeed(s);
      setChecks(c);
      setError("");
    } catch (e) {
      setError(`Couldn't load the readings: ${(e as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  const backfill = async () => {
    let n = 0;
    for (const c of checks ?? []) {
      const ranges = backfillRanges(c.readings);
      if (!ranges.length) continue;
      n += ranges.length;
      const dev = c.readings.readings[0]?.reading.dev;
      if (dev) await post("/api/sensors/backfill", { dev: b64(dev), ranges });
    }
    setNote(n ? `Asked the sensors to resend ${n} range${n === 1 ? "" : "s"} over the radio.` : "Nothing to backfill: every sealed reading is linked.");
    setTimeout(load, 2500);
  };

  return (
    <section>
      <h1>Sensors</h1>
      <p className="lede">Checked in your browser. The server could hide readings but can't change them: each batch is sealed with the sensor's own key.</p>
      {feed && (
        <div className="controls panel">
          <label className="field">
            Radio frame loss
            <select
              value={String(feed.loss)}
              onChange={async (e) => {
                await post("/api/sensors/loss", { loss: Number(e.target.value) });
                void load();
              }}
            >
              <option value="0">None</option>
              <option value="0.1">10%</option>
              <option value="0.3">30%</option>
            </select>
          </label>
          <label className="row small" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={feed.evil}
              onChange={async (e) => {
                await post("/api/sensors/evil", { on: e.target.checked });
                void load();
              }}
            />
            Dishonest gateway: change the next reading it hears
          </label>
          <button onClick={() => void backfill()}>Request backfill</button>
          <span className="muted small">
            On the air: {feed.stats.bytes.reading || "–"} bytes per reading, {feed.stats.bytes.seal || "–"} per seal
          </span>
        </div>
      )}
      {note && (
        <p className="notice good" role="status">
          {note}
        </p>
      )}
      {error && <p className="notice bad">{error}</p>}
      {!checks ? (
        <p className="muted">Checking readings…</p>
      ) : checks.length === 0 ? (
        <p className="muted">No sensors yet. Start one with npm run sensor.</p>
      ) : (
        <>
          <MiniMap checks={checks} />
          <div className="stations">
            {checks.map((c) => (
              <Station key={c.sensor.did} c={c} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function MiniMap({ checks }: { checks: SensorCheck[] }) {
  const pts = checks.map((c) => c.sensor.installation?.location).filter(Boolean) as { lat: number; lon: number }[];
  if (!pts.length) return null;
  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  const [a, b, c2, d] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  const X = (lon: number) => 20 + ((lon - c2) / Math.max(1e-4, d - c2)) * 170;
  const Y = (lat: number) => 110 - ((lat - a) / Math.max(1e-4, b - a)) * 90;
  return (
    <figure style={{ margin: "0 0 18px", display: "flex", gap: 14, alignItems: "center" }}>
      <svg className="minimap" viewBox="0 0 210 130" role="img" aria-label="Where the stations are installed, as their installation credentials claim">
        {checks.map((c) => {
          const l = c.sensor.installation?.location;
          if (!l) return null;
          return (
            <g key={c.sensor.did}>
              <circle cx={X(l.lon)} cy={Y(l.lat)} r="5" fill="var(--ink)" />
              <text x={X(l.lon) > 120 ? X(l.lon) - 8 : X(l.lon) + 8} y={Y(l.lat) + 4} fontSize="11" fill="var(--ink)" textAnchor={X(l.lon) > 120 ? "end" : "start"}>
                {c.sensor.label}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="small muted" style={{ maxWidth: "36ch" }}>
        Locations come from each station's installation credential: the owner's claim of where it was installed, not something the sensor proves.
      </figcaption>
    </figure>
  );
}

function Station({ c }: { c: SensorCheck }) {
  const rs = c.readings.readings;
  const count = (s: ReadingResult["status"]) => rs.filter((r) => r.status === s).length;
  const inst = c.installation?.credential.credentialSubject as { station?: string; location?: { lat: number; lon: number; method: string }; channels?: { kind: number; quantity: string; unit: string; scale: number }[] } | undefined;
  const channels = inst?.channels?.length ? inst.channels : [{ kind: 1, quantity: "air temperature", unit: "Cel", scale: 0.01 }];
  const verified = rs.filter((r) => r.status === "verified");
  const lastSeal = [...c.readings.seals].filter((s) => s.status === "valid").pop();
  const clockWrong = verified.filter((r) => r.clockWrong).length;
  const latest = verified[verified.length - 1];
  const skewH = latest && latest.notBefore !== undefined ? Math.round((latest.reading.t * 1000 - latest.notBefore) / 3_600_000) : 0;
  return (
    <article className="station" aria-labelledby={`st-${c.sensor.aid}`} data-testid="station">
      <div className="station-head">
        <div>
          <h2 id={`st-${c.sensor.aid}`}>{c.sensor.label}</h2>
          <p className="small muted">
            {inst?.location ? `Installed at ${inst.location.lat.toFixed(4)}, ${inst.location.lon.toFixed(4)} (${inst.location.method.replace("-", " ")})` : "No installation credential"}
            {c.installation ? (c.installation.ok ? (c.installation.trusted ? ", vouched for by an installer you trust" : ", vouched for by an installer you don't trust yet") : ", but its credential doesn't verify") : ""}.{" "}
            {c.keyLog === "ok" ? "Key history verified." : "Its key history couldn't be checked, so nothing from it can be verified."}
          </p>
        </div>
        <div className="tally" aria-label="Readings by status">
          <span className="proven">
            <b>{count("verified")}</b>verified
          </span>
          <span>
            <b>{count("pending")}</b>pending
          </span>
          <span className="muted">
            <b>{count("unlinked")}</b>unlinked
          </span>
          <span className="broken-text">
            <b>{count("invalid") + count("equivocation")}</b>invalid
          </span>
        </div>
      </div>
      {c.readings.equivocation && <p className="notice bad">This sensor signed two different readings with the same number. It is flagged: something is wrong with it or its key.</p>}
      {clockWrong > 0 && (
        <p className="notice">
          This sensor's clock is wrong: it reports times about {Math.abs(skewH)} hours {skewH < 0 ? "behind" : "ahead of"} what the beacons and the gateway's receipts prove. Its own times are shown struck out.
        </p>
      )}
      <div className="charts">
        {channels.map((ch) => (
          <Chart key={ch.kind} readings={rs} kind={ch.kind} label={`${ch.quantity[0].toUpperCase()}${ch.quantity.slice(1)}`} unit={ch.unit === "Cel" ? "°C" : ch.unit === "ug/m3" ? "µg/m³" : ch.unit} scale={ch.scale} gaps={c.readings.gaps} />
        ))}
      </div>
      <table className="batches">
        <caption className="small muted" style={{ textAlign: "left", captionSide: "top", paddingBottom: 4 }}>
          Latest sealed batches {lastSeal ? `(last seal ${Math.round((Date.now() - (lastSeal.notAfter ?? Date.now())) / 1000)} s ago)` : ""}
        </caption>
        <thead>
          <tr>
            <th scope="col">Readings</th>
            <th scope="col">Seal</th>
            <th scope="col">Proven interval</th>
            <th scope="col">Device clock</th>
            <th scope="col">Link</th>
          </tr>
        </thead>
        <tbody>
          {c.readings.seals
            .slice(-5)
            .reverse()
            .map((s) => {
              const inBatch = rs.filter((r) => r.seal?.hash === s.hash);
              const nb = Math.min(...inBatch.map((r) => r.notBefore ?? Infinity));
              const wrong = inBatch.some((r) => r.clockWrong);
              const t = inBatch[inBatch.length - 1]?.reading.t;
              return (
                <tr key={s.hash}>
                  <td>
                    #{s.firstSeq}–{s.lastSeq} ({s.linked} linked)
                  </td>
                  <td className={s.status === "valid" ? "proven" : "broken-text"}>{s.status === "valid" ? "signature valid" : "signature invalid"}</td>
                  <td>
                    {Number.isFinite(nb) ? clock(nb) : "?"} to {s.notAfter ? clock(s.notAfter) : "?"} UTC
                  </td>
                  <td className={wrong ? "struck" : "muted"}>{t ? when(t * 1000) : ""}</td>
                  <td className="muted">{s.meta ? `simulated LoRa, RSSI ${s.meta.rssi} dBm, SNR ${s.meta.snr} dB` : ""}</td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </article>
  );
}

function Chart({ readings, kind, label, unit, scale, gaps }: { readings: ReadingResult[]; kind: number; label: string; unit: string; scale: number; gaps: [number, number][] }) {
  const pts = readings
    .map((r) => ({ r, v: r.reading.values.find(([k]) => k === kind)?.[1], at: r.meta?.at ?? r.notAfter ?? r.reading.t * 1000 }))
    .filter((p): p is { r: ReadingResult; v: number; at: number } => p.v !== undefined)
    .slice(-90);
  if (!pts.length) return null;
  const vs = pts.map((p) => p.v * scale);
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  if (hi - lo < 1e-6) {
    lo -= 1;
    hi += 1;
  }
  const t0 = pts[0].at;
  const t1 = pts[pts.length - 1].at;
  const X = (t: number) => 34 + ((t - t0) / Math.max(1, t1 - t0)) * 300;
  const Y = (v: number) => 110 - ((v - lo) / (hi - lo)) * 90;
  const line = pts
    .filter((p) => p.r.status === "verified")
    .map((p, i) => `${i ? "L" : "M"}${X(p.at).toFixed(1)},${Y(p.v * scale).toFixed(1)}`)
    .join(" ");
  const seqAt = new Map(pts.map((p) => [p.r.seq, p.at]));
  const latest = pts[pts.length - 1];
  return (
    <figure className="chart" style={{ margin: 0 }}>
      <figcaption>
        {label}{" "}
        <span className="small muted">
          now {(latest.v * scale).toFixed(scale < 0.1 ? 2 : 1)} {unit} ({STATUS_WORDS[latest.r.status]})
        </span>
      </figcaption>
      <svg viewBox="0 0 340 128" role="img" aria-label={`${label}: ${pts.length} readings, ${pts.filter((p) => p.r.status === "verified").length} verified`}>
        <line x1="34" x2="334" y1="110" y2="110" stroke="var(--rule)" />
        <text x="30" y="24" textAnchor="end" fontSize="9" fill="var(--ink-2)">
          {hi.toFixed(1)}
        </text>
        <text x="30" y="112" textAnchor="end" fontSize="9" fill="var(--ink-2)">
          {lo.toFixed(1)}
        </text>
        <path d={line} fill="none" stroke="var(--proof)" strokeWidth="1.5" opacity="0.55" />
        {gaps.map(([a]) => {
          const t = seqAt.get(a - 1) ?? seqAt.get(a + 1);
          return t ? <line key={a} x1={X(t)} x2={X(t)} y1="106" y2="118" stroke="var(--break)" strokeWidth="2" /> : null;
        })}
        {pts.map((p) => {
          const x = X(p.at);
          const y = Y(p.v * scale);
          const k = `${p.r.seq}-${p.r.bytesHex.slice(0, 8)}`;
          if (p.r.status === "verified") return <circle key={k} cx={x} cy={y} r="2.8" fill="var(--proof)" data-status="verified" />;
          if (p.r.status === "pending") return <circle key={k} cx={x} cy={y} r="2.8" fill="var(--sheet)" stroke="var(--ink)" strokeWidth="1.2" data-status="pending" />;
          if (p.r.status === "unlinked") return <circle key={k} cx={x} cy={y} r="2.8" fill="#9aa5ad" data-status="unlinked" />;
          return <path key={k} d={`M${x - 4},${y - 4} L${x + 4},${y + 4} M${x + 4},${y - 4} L${x - 4},${y + 4}`} stroke="var(--break)" strokeWidth="2" data-status={p.r.status} />;
        })}
      </svg>
    </figure>
  );
}

