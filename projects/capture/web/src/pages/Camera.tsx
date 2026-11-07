/** The camera (design §15.1): a browser key the page can't export signs every photo at the shutter. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Unlocked } from "@toip-tools/web-vault";
import { encodeCbor } from "@toip-tools/cose";
import {
  CameraDevice,
  decodeStore,
  embedStore,
  encodeStore,
  publishStore,
  roundTime,
  sha,
  utf8,
  type LocationClaim,
  type SavedCamera,
} from "../../../src/core";
import { chains, clock, download, gallery, navigate, objectUrl, setHandoff, tileKeyName, vault, type Shot } from "../app";
import { CreateAccount, UnlockAccount, useRoleAccount } from "./Unlock";

const VIRTUAL = /virtual|obs|fake|snap camera|manycam|droidcam/i;

async function openCamera(u: Unlocked): Promise<CameraDevice | null> {
  const saved = (await vault.readJson(u, "camera")) as SavedCamera | null;
  const priv = await vault.getCryptoKey(u.account, "capture-key");
  const pub = await vault.getCryptoKey(u.account, "capture-pub");
  if (!saved || !priv || !pub) return null;
  return CameraDevice.restore(saved, { base: "", pair: { privateKey: priv, publicKey: pub } });
}

export function CameraPage() {
  const role = useRoleAccount("camera");
  const [u, setU] = useState<Unlocked | null>(() => (role.account ? vault.unlockedAccount(role.account.id) ?? null : null));
  const [cam, setCam] = useState<CameraDevice | null>(null);
  const [error, setError] = useState("");
  const [, force] = useState(0);

  useEffect(() => {
    if (!u) return;
    openCamera(u)
      .then(setCam)
      .catch((e) => setError(String(e?.message ?? e)));
  }, [u]);

  if (!role.account || (u && !cam && !error)) {
    if (role.account && u) return <p className="muted">Opening the camera…</p>;
    return (
      <section>
        <h1>Make this browser a camera</h1>
        <p className="lede">
          This browser makes a signing key it can never give out, and the photo desk's owner key vouches for it. Every photo you take is signed the moment you take it.
        </p>
        <CreateAccount
          nameLabel="Camera name"
          defaultName="Dana's laptop camera"
          cta="Make this a camera"
          onDone={async (unlocked, name) => {
            const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
            await vault.putCryptoKey(unlocked.account, "capture-key", pair.privateKey);
            await vault.putCryptoKey(unlocked.account, "capture-pub", pair.publicKey);
            const device = await CameraDevice.enroll(name, { base: "", pair });
            await vault.writeJson(unlocked, "camera", device.savedState());
            role.remember(unlocked);
            setCam(device);
            setU(unlocked);
          }}
        />
        {error && <p className="notice bad">{error}</p>}
      </section>
    );
  }
  if (!u)
    return (
      <section>
        <h1>Camera</h1>
        <UnlockAccount
          account={role.account}
          onUnlocked={async (x) => setU(x)}
          onForget={() => {
            role.forget();
            force((n) => n + 1);
          }}
        />
      </section>
    );
  if (error || !cam) return <p className="notice bad">The camera couldn't open: {error}</p>;
  return <Viewfinder u={u} cam={cam} />;
}

function Viewfinder({ u, cam }: { u: Unlocked; cam: CameraDevice }) {
  const video = useRef<HTMLVideoElement>(null);
  const [track, setTrack] = useState<{ label: string; deviceIdHash: Uint8Array; width: number; height: number; facingMode?: string } | null>(null);
  const [mediaError, setMediaError] = useState("");
  const [beaconAge, setBeaconAge] = useState<number | null>(null);
  const [location, setLocation] = useState<"off" | "rounded" | "precise">("off");
  const [shots, setShots] = useState<Shot[]>([]);
  const [flash, setFlash] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ current: boolean } | null>(null);
  const [message, setMessage] = useState("");
  const pending = useRef<{ shot: Shot; id: Uint8Array }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const owner = cam.saved.credentials.find((c) => c.type.includes("DeviceOwnerCredential"))?.credentialSubject.ownerName as string | undefined;

  const refresh = useCallback(async () => setShots((await gallery.all()).filter((s) => s.account === u.account.id)), [u]);
  useEffect(() => void refresh(), [refresh]);
  useEffect(() => {
    cam
      .status()
      .then(setStatus)
      .catch((e) => {
        console.warn("couldn't check the camera's key with the witnesses", e);
        setStatus(null);
      });
  }, [cam]);

  useEffect(() => {
    let stream: MediaStream | undefined;
    navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then(async (s) => {
        stream = s;
        if (video.current) video.current.srcObject = s;
        const t = s.getVideoTracks()[0];
        const st = t.getSettings();
        setTrack({ label: t.label, deviceIdHash: sha(utf8(st.deviceId ?? t.id)), width: st.width ?? 0, height: st.height ?? 0, facingMode: st.facingMode });
      })
      .catch((e) => setMediaError(e?.name === "NotAllowedError" ? "Camera access was refused. Allow the camera for this page to take photos." : `No camera is available: ${e?.message ?? e}`));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const b = await cam.beacon();
      if (!alive) return;
      if (!b) return setBeaconAge(null);
      const chain = (await chains()).find((c) => c.kind === b.beacon.kind);
      setBeaconAge(chain ? Math.max(0, Math.round((Date.now() - roundTime(chain, b.beacon.round)) / 1000)) : null);
    };
    void tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [cam]);

  const anchorPending = useCallback(async () => {
    const batch = pending.current.splice(0);
    if (!batch.length) return;
    const items = batch.map((b) => ({ id: b.id, store: decodeStore(b.shot.store) }));
    try {
      const r = await cam.anchor(items);
      await vault.writeJson(u, "camera", cam.savedState());
      for (const [k, b] of batch.entries()) await gallery.put({ ...b.shot, store: encodeStore(items[k].store), anchored: r.witnessed >= 2, witnessed: r.witnessed });
      if (r.witnessed < 2) setMessage("The witnesses refused to anchor this photo. This camera's key may have been retired by its owner.");
    } catch (e) {
      setMessage(`Couldn't reach the witnesses: ${(e as Error).message}. The photo is signed; it will show no "not after" time.`);
    }
    await refresh();
  }, [cam, u, refresh]);

  const shoot = async () => {
    const v = video.current;
    if (!v || !v.videoWidth || busy) return;
    setBusy(true);
    setFlash((n) => n + 1);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      canvas.getContext("2d")!.drawImage(v, 0, 0);
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.92));
      const file = new Uint8Array(await blob.arrayBuffer());
      let loc: LocationClaim | undefined;
      if (location !== "off") {
        const pos = await new Promise<GeolocationPosition | null>((r) => navigator.geolocation.getCurrentPosition(r, () => r(null), { timeout: 4000 }));
        if (pos) {
          const round = (x: number) => (location === "rounded" ? Math.round(x * 100) / 100 : x);
          loc = { lat: round(pos.coords.latitude), lon: round(pos.coords.longitude), accuracyM: location === "rounded" ? Math.max(1000, pos.coords.accuracy) : pos.coords.accuracy, source: "browser-geolocation", at: pos.timestamp };
        }
      }
      const cap = await cam.shoot(file, {
        sensor: { type: "camera", pipeline: "getUserMedia+canvas", trackLabel: track?.label, deviceIdHash: track?.deviceIdHash, settings: { width: canvas.width, height: canvas.height, ...(track?.facingMode ? { facingMode: track.facingMode } : {}) } },
        app: { name: "capture-camera", version: "0.1.0", origin: window.location.origin },
        ...(loc ? { location: loc } : {}),
      });
      const shot: Shot = { id: cap.idText, takenAt: Date.now(), file, store: encodeStore(cap.store), mime: "image/jpeg", width: canvas.width, height: canvas.height, anchored: false, published: false, account: u.account.id, kind: "capture" };
      await vault.writeBlob(u, tileKeyName(shot.id), cap.tileKey);
      await gallery.put(shot);
      pending.current.push({ shot, id: cap.id });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void anchorPending(), 1200);
      await refresh();
    } catch (e) {
      setMessage(`The photo wasn't signed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const virtual = track && VIRTUAL.test(track.label);
  return (
    <section>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h1>Camera</h1>
        <p className="muted small">
          Key: <span title={cam.did}>this browser holds it and can't export it</span>
        </p>
      </div>
      {status && !status.current && (
        <p className="notice bad" role="status">
          The owner has retired this camera's key. Photos it signs now will verify as broken. Ask the owner to enroll a new key.
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <div className="camera" style={{ marginTop: 16 }}>
        <div>
          <div className="viewfinder">
            <video ref={video} autoPlay playsInline muted aria-label="Viewfinder" />
            <div className="corners" />
            <div key={flash} className={`flash ${flash ? "on" : ""}`} />
          </div>
          <div className="status-strip" aria-live="polite">
            <span>
              Signing as {cam.saved.label}
              {owner ? ` for ${owner}` : ""}
            </span>
            <span className={beaconAge === null ? "off" : ""}>{beaconAge === null ? "Offline: time will be this computer's clock only" : `Time beacon ${beaconAge} s old`}</span>
            <span className={location === "off" ? "off" : ""}>{location === "off" ? "Location off" : location === "rounded" ? "Location rounded to about 1 km" : "Precise location"}</span>
          </div>
          {mediaError && <p className="notice bad">{mediaError}</p>}
          {virtual && <p className="notice">This camera input is named “{track!.label}”, which looks like a virtual or test camera. Verifiers will be told.</p>}
          <div className="shutter-row">
            <button className="shutter" aria-label="Take a photo" onClick={() => void shoot()} disabled={busy || !track} />
            <fieldset className="segmented" aria-label="Location">
              {(["off", "rounded", "precise"] as const).map((l) => (
                <label key={l}>
                  <input type="radio" name="loc" checked={location === l} onChange={() => setLocation(l)} />
                  <span>{l === "off" ? "No location" : l === "rounded" ? "Rounded" : "Precise"}</span>
                </label>
              ))}
            </fieldset>
          </div>
          <p className="muted small" style={{ marginTop: 10 }}>
            All photos from this camera can be linked to each other by its identifier. Location is a claim the browser makes; it is shown as claimed, never as proven.
          </p>
        </div>
        <div>
          <h2 style={{ marginBottom: 10 }}>Photos</h2>
          {shots.length === 0 ? <p className="muted">Take a photo. It is signed at once, then anchored by the witnesses a moment later.</p> : null}
          <ul className="gallery" style={{ listStyle: "none", padding: 0, margin: 0 }} aria-label="Photos">
            {shots.map((s) => (
              <ShotRow key={s.id} shot={s} u={u} onChange={refresh} />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function ShotRow({ shot, u, onChange }: { shot: Shot; u: Unlocked; onChange: () => Promise<void> }) {
  const [url] = useState(() => objectUrl(shot.file, shot.mime));
  const [busy, setBusy] = useState("");
  const ext = shot.mime === "image/png" ? "png" : "jpg";
  const name = `capture-${new Date(shot.takenAt).toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const store = () => decodeStore(shot.store);
  const withStore = () => embedStore(shot.file, store());
  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy("");
    }
  };
  return (
    <li className="shot">
      <img src={url} alt={`${shot.kind === "edit" ? "Edited photo" : "Photo"} taken at ${clock(shot.takenAt)} UTC`} />
      <div>
        <div className="small muted">
          {shot.kind === "edit" ? "Edited" : "Taken"} {clock(shot.takenAt)} UTC · {shot.width}×{shot.height}
        </div>
        <div className="badges">
          <span className="badge proof">Signed</span>
          {shot.anchored ? <span className="badge proof">Anchored by {shot.witnessed ?? 0} witnesses</span> : <span className="badge grey">Not anchored yet</span>}
          {shot.published && <span className="badge proof">In the registry</span>}
        </div>
        <div className="actions">
          <button className="quiet" onClick={() => download(withStore(), `${name}.${ext}`, shot.mime)} aria-label={`Download photo ${clock(shot.takenAt)} with credentials inside`}>
            Download
          </button>
          <button
            className="quiet"
            onClick={() => {
              download(shot.file, `${name}.${ext}`, shot.mime);
              download(shot.store, `${name}.${ext}.capture`);
            }}
          >
            With sidecar
          </button>
          <button className="quiet" disabled={!!busy || shot.published} onClick={() => act("publish", async () => (await publishStore("", shot.store), await gallery.put({ ...shot, published: true }), await onChange()))}>
            {shot.published ? "Published" : "Publish"}
          </button>
          {shot.kind === "capture" && (
            <button className="quiet" onClick={() => navigate(`/edit?shot=${encodeURIComponent(shot.id)}`)}>
              Edit
            </button>
          )}
          {shot.kind === "capture" && (
            <button
              className="quiet"
              onClick={async () => {
                const tileKey = await vault.readBlob(u, tileKeyName(shot.id));
                download(encodeCbor({ v: 1, file: shot.file, store: shot.store, tileKey }), `${name}.capture-bundle`);
              }}
              title="The original, its credentials and its tile key, for an editor elsewhere. Don't publish it."
            >
              Private bundle
            </button>
          )}
          <button
            onClick={() => {
              setHandoff({ file: withStore(), name: `${name}.${ext}` });
              navigate("/verify");
            }}
          >
            Verify
          </button>
        </div>
        <div className="hash" title="Manifest id">
          {shot.id.slice(0, 28)}…
        </div>
      </div>
    </li>
  );
}
