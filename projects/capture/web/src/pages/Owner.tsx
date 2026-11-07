/**
 * The owner (design §15.2). In this demo the owner's keys live in the capture server, which plays the
 * photo desk: it holds each device's recovery key and signs rotations with it.
 */
import { useCallback, useEffect, useState } from "react";
import { when } from "../app";

interface Device {
  aid: string;
  did: string;
  kind: "camera" | "sensor";
  label: string;
  enrolledAt: string;
  rotations: number;
  retired?: { at: string; reason: string };
  events: { s: number; t: string; receipts: number; at?: string }[];
}

const EVENT_WORDS: Record<string, string> = { icp: "Created", ixn: "Anchored a batch", rot: "Key rotated" };

export function OwnerPage() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const load = useCallback(async () => {
    const [d, c] = await Promise.all([fetch("/api/devices").then((r) => r.json()), fetch("/api/config").then((r) => r.json())]);
    setDevices([...d.devices].sort((a: Device, b: Device) => (a.kind === b.kind ? a.enrolledAt.localeCompare(b.enrolledAt) : a.kind === "camera" ? -1 : 1)));
    setOwner(c.owner.name);
  }, []);
  useEffect(() => void load(), [load]);

  const act = async (d: Device, action: "rotate" | "revoke") => {
    if (action === "rotate" && !confirm(`Retire ${d.label}'s key? Anything it signs from now on will verify as broken.`)) return;
    setBusy(d.aid + action);
    const r = await fetch(`/api/devices/${d.aid}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, reason: "phone lost" }) });
    const j = await r.json();
    setBusy("");
    setNote(r.ok ? (action === "rotate" ? `${d.label}'s key is retired. Photos it anchored before now still verify.` : `${d.label}'s owner credential is revoked.`) : `That didn't work: ${j.error}`);
    await load();
  };

  return (
    <section>
      <h1>Devices</h1>
      <p className="lede">{owner ? `${owner} owns these devices. It holds each one's recovery key, so it can retire a lost or stolen device's key and the thief can't.` : ""}</p>
      {note && (
        <p className="notice good" role="status">
          {note}
        </p>
      )}
      {!devices ? (
        <p className="muted">Loading…</p>
      ) : devices.length === 0 ? (
        <p className="muted">No devices yet. Open the camera to enroll one.</p>
      ) : (
        <div className="devices" style={{ marginTop: 16 }}>
          {devices.map((d) => (
            <article key={d.aid} className="panel" aria-labelledby={`dev-${d.aid}`}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <h2 id={`dev-${d.aid}`}>{d.label}</h2>
                  <p className="small muted">
                    {d.kind === "camera" ? "Camera, browser key" : "Sensor, key file"} · enrolled {when(Date.parse(d.enrolledAt))}
                  </p>
                </div>
                <div className="row">
                  {d.retired ? (
                    <span className="badge break">Key retired {when(Date.parse(d.retired.at))}</span>
                  ) : (
                    <button className="danger" disabled={!!busy} onClick={() => void act(d, "rotate")}>
                      Retire the key: device lost
                    </button>
                  )}
                  <button className="quiet" disabled={!!busy} onClick={() => void act(d, "revoke")}>
                    Revoke owner credential
                  </button>
                </div>
              </div>
              <ol className="kel" aria-label="Key history">
                {d.events.map((e) => (
                  <li key={e.s} className={e.t === "rot" ? "rot" : ""}>
                    {e.s}. {EVENT_WORDS[e.t] ?? e.t}
                    {e.at ? `, ${new Date(e.at).toISOString().slice(11, 19)}` : ""} · {e.receipts} witness{e.receipts === 1 ? "" : "es"}
                  </li>
                ))}
              </ol>
              <p className="hash">{d.did}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
