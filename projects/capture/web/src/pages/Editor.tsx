/**
 * The editor (design §11.3, §15.3): redact and crop, then sign as the editor. Untouched tiles keep their
 * proof: the verifier can check every pixel outside the redaction against what the camera committed to.
 */
import { useEffect, useRef, useState } from "react";
import type { Unlocked } from "@zk-toip/web-vault";
import { decodeCbor, seedSigner } from "@zk-toip/cose";
import { identityFromSeed, type Credential, type StatusListDoc } from "@zk-toip/trust-core";
import { decodeStore, encodeStore, fromHex, intersects, makeEdit, publishStore, snapCrop, TILE, utf8, type Rect, type RedactMethod, type Store } from "../../../src/core";
import { download, gallery, navigate, objectUrl, setHandoff, tileKeyName, vault, type Shot } from "../app";
import { CreateAccount, UnlockAccount, useRoleAccount } from "./Unlock";

interface Bundle {
  file: Uint8Array;
  store: Store;
  tileKey: Uint8Array | null;
  shot?: Shot;
  name: string;
}

const METHODS: { id: RedactMethod; label: string }[] = [
  { id: "pixelate-16", label: "Pixelate" },
  { id: "gaussian-12", label: "Blur" },
  { id: "fill-black", label: "Black out" },
];

export function EditorPage() {
  const editorRole = useRoleAccount("editor");
  const cameraRole = useRoleAccount("camera");
  const [editor, setEditor] = useState<Unlocked | null>(() => (editorRole.account ? vault.unlockedAccount(editorRole.account.id) ?? null : null));
  const [camU, setCamU] = useState<Unlocked | null>(() => (cameraRole.account ? vault.unlockedAccount(cameraRole.account.id) ?? null : null));
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [error, setError] = useState("");
  const [, force] = useState(0);
  const shotId = new URLSearchParams(location.search).get("shot");

  useEffect(() => {
    if (!shotId) return;
    (async () => {
      const shot = await gallery.get(shotId);
      if (!shot) return setError("That photo isn't in this browser's gallery.");
      const tileKey = camU ? await vault.readBlob(camU, tileKeyName(shot.id)) : null;
      setBundle({ file: shot.file, store: decodeStore(shot.store), tileKey, shot, name: `photo ${new Date(shot.takenAt).toISOString().slice(11, 19)}` });
    })().catch((e) => setError(String(e?.message ?? e)));
  }, [shotId, camU]);

  if (!editorRole.account)
    return (
      <section>
        <h1>Editor</h1>
        <p className="lede">Edits are signed by the person who makes them. Make your editor identity first; the photo desk vouches for it.</p>
        <CreateAccount
          nameLabel="Your name, as readers will see it"
          defaultName="M. Chen"
          cta="Make my editor identity"
          onDone={async (u, name) => {
            const did = identityFromSeed(u.seed).did;
            const r = await fetch("/api/editors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ did, name }) });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error);
            await vault.writeJson(u, "editor", { name, credential: j.credential, statusList: j.statusList });
            editorRole.remember(u);
            setEditor(u);
          }}
        />
      </section>
    );
  if (!editor)
    return (
      <section>
        <h1>Editor</h1>
        <UnlockAccount
          account={editorRole.account}
          onUnlocked={async (u) => setEditor(u)}
          onForget={() => {
            editorRole.forget();
            force((n) => n + 1);
          }}
        />
      </section>
    );
  if (shotId && cameraRole.account && !camU)
    return (
      <section>
        <h1>Editor</h1>
        <p className="lede">The photo's tile key is sealed with the camera. Unlock the camera to edit with a redaction proof.</p>
        <UnlockAccount account={cameraRole.account} onUnlocked={async (u) => setCamU(u)} onForget={() => navigate("/edit")} />
      </section>
    );
  if (!bundle)
    return (
      <section>
        <h1>Editor</h1>
        <p className="lede">Open a photo from the camera's gallery, or a private bundle file (.capture-bundle) a camera gave you.</p>
        <div className="panel row" style={{ marginTop: 16 }}>
          <label className="button">
            Open a private bundle
            <input
              type="file"
              accept=".capture-bundle"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  const b = decodeCbor<{ file: Uint8Array; store: Uint8Array; tileKey: Uint8Array | null }>(new Uint8Array(await f.arrayBuffer()), { strict: false });
                  setBundle({ file: b.file, store: decodeStore(b.store), tileKey: b.tileKey, name: f.name });
                } catch {
                  setError("That file isn't a private bundle.");
                }
              }}
            />
          </label>
          <button className="quiet" onClick={() => navigate("/camera")}>
            Go to the camera's gallery
          </button>
        </div>
        {error && <p className="notice bad">{error}</p>}
      </section>
    );
  return <Workbench bundle={bundle} editor={editor} camAccount={camU?.account.id} />;
}

function Workbench({ bundle, editor, camAccount }: { bundle: Bundle; editor: Unlocked; camAccount?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [regions, setRegions] = useState<Rect[]>([]);
  const [cropRect, setCrop] = useState<Rect | null>(null);
  const [tool, setTool] = useState<"redact" | "crop">("redact");
  const [method, setMethod] = useState<RedactMethod>("gaussian-12");
  const [reason, setReason] = useState("protect a bystander's identity");
  const [drag, setDrag] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ file: Uint8Array; store: Store; shot?: Shot } | null>(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ x: 0, y: 0, w: 128, h: 128 });

  useEffect(() => {
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = objectUrl(bundle.file, "image/jpeg");
  }, [bundle.file]);

  const W = img?.naturalWidth ?? 0;
  const H = img?.naturalHeight ?? 0;
  const area = cropRect ? snapCrop(cropRect, W, H) : null;

  useEffect(() => {
    const c = canvas.current;
    if (!c || !img) return;
    c.width = W;
    c.height = H;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    // faint tile grid
    g.strokeStyle = "rgba(245,247,248,0.28)";
    g.lineWidth = 1;
    for (let x = TILE; x < W; x += TILE) g.strokeRect(x, 0, 0, H);
    for (let y = TILE; y < H; y += TILE) g.strokeRect(0, y, W, 0);
    // tiles that will count as changed
    g.fillStyle = "rgba(154,98,9,0.35)";
    for (let y = 0; y < H; y += TILE)
      for (let x = 0; x < W; x += TILE) {
        const t = { x, y, w: Math.min(TILE, W - x), h: Math.min(TILE, H - y) };
        if (regions.some((r) => intersects(r, t))) g.fillRect(t.x, t.y, t.w, t.h);
      }
    g.lineWidth = Math.max(2, W / 400);
    g.strokeStyle = "#e7c46a";
    for (const r of regions) g.strokeRect(r.x, r.y, r.w, r.h);
    if (area) {
      g.fillStyle = "rgba(16,38,58,0.55)";
      g.fillRect(0, 0, W, area.y);
      g.fillRect(0, area.y + area.h, W, H - area.y - area.h);
      g.fillRect(0, area.y, area.x, area.h);
      g.fillRect(area.x + area.w, area.y, W - area.x - area.w, area.h);
      g.strokeStyle = "#f5f7f8";
      g.strokeRect(area.x, area.y, area.w, area.h);
    }
    if (drag) {
      g.setLineDash([8, 6]);
      g.strokeStyle = "#f5f7f8";
      g.strokeRect(Math.min(drag.x, drag.x2), Math.min(drag.y, drag.y2), Math.abs(drag.x2 - drag.x), Math.abs(drag.y2 - drag.y));
      g.setLineDash([]);
    }
  }, [img, regions, area?.x, area?.y, area?.w, area?.h, drag, W, H]);

  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) / r.width) * W), y: Math.round(((e.clientY - r.top) / r.height) * H) };
  };
  const finish = () => {
    if (!drag) return;
    const r = { x: Math.max(0, Math.min(drag.x, drag.x2)), y: Math.max(0, Math.min(drag.y, drag.y2)), w: Math.abs(drag.x2 - drag.x), h: Math.abs(drag.y2 - drag.y) };
    setDrag(null);
    if (r.w < 6 || r.h < 6) return;
    if (tool === "redact") setRegions((rs) => [...rs, r]);
    else setCrop(r);
  };

  const sign = async () => {
    setBusy(true);
    setError("");
    try {
      const ed = (await vault.readJson(editor, "editor")) as { name: string; credential: Credential; statusList: StatusListDoc } | null;
      if (!ed) throw new Error("Your editor identity has no credential. Make it again.");
      const did = identityFromSeed(editor.seed).did;
      if (!bundle.tileKey) throw new Error("This photo's tile key isn't available, so a redaction proof can't be made. Open it from the camera that took it.");
      const b = await fetch("/api/drand/latest")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const out = await makeEdit({
        original: bundle.file,
        store: bundle.store,
        tileKey: bundle.tileKey,
        regions,
        method,
        reason: reason.trim() || undefined,
        ...(area ? { crop: area } : {}),
        signer: seedSigner(editor.seed.slice(0, 32), utf8(did)),
        editor: did,
        deviceTime: Date.now(),
        ...(b ? { beacons: [{ kind: b.kind, round: b.round, prefix: fromHex(b.randomness).slice(0, 8) }], beaconSigs: { [`${b.kind}:${b.round}`]: fromHex(b.signature) } } : {}),
        tool: { name: "capture-editor", version: "0.1.0", did },
        extra: { credentials: [ed.credential], statusLists: [ed.statusList] },
      });
      const shot: Shot = { id: out.idText, takenAt: Date.now(), file: out.file, store: encodeStore(out.store), mime: "image/png", width: area?.w ?? W, height: area?.h ?? H, anchored: false, published: false, account: camAccount ?? editor.account.id, kind: "edit" };
      await gallery.put(shot);
      setDone({ file: out.file, store: out.store, shot });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <section>
        <h1>Signed</h1>
        <p className="lede">The edited PNG carries the whole chain, back to the camera, and the proof for every tile you didn't touch.</p>
        <div className="row" style={{ marginTop: 16 }}>
          <button onClick={() => download(done.file, "capture-edit.png", "image/png")}>Download PNG</button>
          <button
            className="quiet"
            onClick={async () => {
              await publishStore("", encodeStore(done.store));
              if (done.shot) await gallery.put({ ...done.shot, published: true });
              setDone({ ...done, shot: done.shot ? { ...done.shot, published: true } : undefined });
            }}
            disabled={done.shot?.published}
          >
            {done.shot?.published ? "Published" : "Publish to the registry"}
          </button>
          <button
            className="quiet"
            onClick={() => {
              setHandoff({ file: done.file, name: "capture-edit.png" });
              navigate("/verify");
            }}
          >
            Verify it
          </button>
          <button className="quiet" onClick={() => setDone(null)}>
            Keep editing
          </button>
        </div>
        <img src={objectUrl(done.file, "image/png")} alt="The edited photo" style={{ maxWidth: "100%", marginTop: 18, borderRadius: 3 }} />
      </section>
    );

  return (
    <section>
      <h1>Editor</h1>
      <p className="lede">
        Drag on the photo to mark an area to redact. Tiles your marks touch count as changed; every other tile stays provably as the camera captured it.
      </p>
      <div className="editor" style={{ marginTop: 16 }}>
        <div className="canvas-wrap">
          <canvas
            ref={canvas}
            aria-label={`The photo, ${W} by ${H} pixels. Drag to mark an area to ${tool === "redact" ? "redact" : "crop to"}.`}
            data-testid="editor-canvas"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              const p = at(e);
              setDrag({ x: p.x, y: p.y, x2: p.x, y2: p.y });
            }}
            onPointerMove={(e) => drag && setDrag({ ...drag, x2: at(e).x, y2: at(e).y })}
            onPointerUp={finish}
          />
        </div>
        <div className="panel" style={{ display: "grid", gap: 14 }}>
          <fieldset className="segmented" aria-label="Tool">
            <label>
              <input type="radio" name="tool" checked={tool === "redact"} onChange={() => setTool("redact")} />
              <span>Redact</span>
            </label>
            <label>
              <input type="radio" name="tool" checked={tool === "crop"} onChange={() => setTool("crop")} />
              <span>Crop</span>
            </label>
          </fieldset>
          <label className="field">
            How to redact
            <select value={method} onChange={(e) => setMethod(e.target.value as RedactMethod)}>
              {METHODS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Reason, shown to readers
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={140} />
          </label>
          <div>
            <strong>Areas to redact</strong>
            {regions.length === 0 ? (
              <p className="muted small">None yet.</p>
            ) : (
              <ul className="regions">
                {regions.map((r, i) => (
                  <li key={i}>
                    <span className="small">
                      {r.w}×{r.h} at {r.x}, {r.y}
                    </span>
                    <button className="quiet" onClick={() => setRegions(regions.filter((_, k) => k !== i))} aria-label={`Remove area ${i + 1}`}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <details>
              <summary className="small">Add an area by numbers</summary>
              <div className="row" style={{ marginTop: 8 }}>
                {(["x", "y", "w", "h"] as const).map((k) => (
                  <label key={k} className="field" style={{ width: 70 }}>
                    {k === "w" ? "Width" : k === "h" ? "Height" : k.toUpperCase()}
                    <input type="number" min={0} value={form[k]} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} />
                  </label>
                ))}
                <button className="quiet" onClick={() => setRegions([...regions, { ...form }])}>
                  Add area
                </button>
              </div>
            </details>
          </div>
          <div>
            <strong>Crop</strong>
            <p className="small muted">{area ? `${area.w}×${area.h} at ${area.x}, ${area.y}, snapped to the 64-pixel grid so whole tiles keep their proof.` : "None. Choose Crop and drag to set one."}</p>
            {area && (
              <button className="quiet" onClick={() => setCrop(null)}>
                Remove the crop
              </button>
            )}
          </div>
          {!bundle.tileKey && <p className="notice">This photo came without its tile key, so the edit can't carry a redaction proof.</p>}
          <button onClick={() => void sign()} disabled={busy || (!regions.length && !area)}>
            {busy ? "Signing…" : "Sign the edit and save as PNG"}
          </button>
          {error && (
            <p className="notice bad" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
