import { useEffect, useReducer, useState } from "react";
import { Device } from "../todo/device";
import { Inspector } from "./Inspector";
import { ListView } from "./ListView";

type Boot = (name?: string) => Promise<Device | null>;

/** Re-renders whenever the device changes. */
function useDevice(device: Device | null) {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => (device ? device.subscribe(bump) : undefined), [device]);
}

function readInvite(): string | null {
  if (typeof location === "undefined") return null;
  const m = location.hash.match(/invite=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

export function App({ boot, inviteBase }: { boot: Boot; inviteBase: string }) {
  const [device, setDevice] = useState<Device | null>(null);
  const [state, setState] = useState<"loading" | "name" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    boot()
      .then((d) => {
        setDevice(d);
        setState(d ? "ready" : "name");
      })
      .catch((e) => {
        setError(String(e?.message ?? e));
        setState("error");
      });
  }, [boot]);

  if (state === "loading") return <p className="splash">Opening…</p>;
  if (state === "error") return <p className="splash">This device couldn't start: {error}</p>;
  if (state === "name" || !device) {
    return (
      <NameScreen
        onDone={async (name) => {
          const d = await boot(name);
          setDevice(d);
          setState(d ? "ready" : "name");
        }}
      />
    );
  }
  return <Shell device={device} inviteBase={inviteBase} />;
}

function NameScreen({ onDone }: { onDone: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  return (
    <main className="splash">
      <form
        className="first-run"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void onDone(name.trim());
        }}
      >
        <h1>Shared lists</h1>
        <p>Lists you share with the people you live or work with. Your key is made on this device, and nobody else holds your lists.</p>
        <label htmlFor="name">Your name</label>
        <input id="name" autoComplete="off" data-1p-ignore value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="What people in your lists will see" />
        <button type="submit" className="primary">
          Continue
        </button>
      </form>
    </main>
  );
}

function Shell({ device, inviteBase }: { device: Device; inviteBase: string }) {
  useDevice(device);
  const lists = device.lists();
  const [selected, setSelected] = useState<string | null>(lists[0]?.did ?? null);
  const [dialog, setDialog] = useState<"new" | "join" | null>(readInvite() ? "join" : null);
  const [inspecting, setInspecting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const current = selected && lists.some((l) => l.did === selected) ? selected : (lists[0]?.did ?? null);
  const status = device.connection();

  // Follow the browser's own idea of being online, so a phone losing signal shows "Offline" at once.
  useEffect(() => {
    const off = () => device.goOffline();
    const on = () => device.goOnline();
    window.addEventListener("offline", off);
    window.addEventListener("online", on);
    return () => {
      window.removeEventListener("offline", off);
      window.removeEventListener("online", on);
    };
  }, [device]);

  return (
    <div className={`shell ${inspecting ? "with-inspector" : ""}`}>
      <header className="topbar">
        <button className="lists-toggle" onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen}>
          Lists
        </button>
        <span className="me">{device.name}</span>
        <span className={`conn ${status}`} title={device.relayUrl}>
          {status === "connected" ? "Connected" : status === "connecting" ? "Connecting…" : "Offline"}
          {device.pendingSends() > 0 && status !== "connected" && ` · ${device.pendingSends()} waiting to send`}
        </span>
        <button className="ghost" onClick={() => setInspecting((x) => !x)} aria-pressed={inspecting}>
          {inspecting ? "Hide what's happening" : "Show what's happening"}
        </button>
      </header>

      <nav className={`sidebar ${menuOpen ? "open" : ""}`} aria-label="Your lists">
        <ul>
          {lists.map((l) => (
            <li key={l.did}>
              <button
                className={l.did === current ? "current" : ""}
                onClick={() => {
                  setSelected(l.did);
                  setMenuOpen(false);
                }}
              >
                <span className="list-name">{l.name}</span>
                <span className="list-meta">{l.pending ? "waiting" : l.removed ? "removed" : l.open > 0 ? l.open : ""}</span>
              </button>
            </li>
          ))}
        </ul>
        {lists.length === 0 && <p className="empty">No lists yet. Make one, or open an invitation someone sent you.</p>}
        <div className="sidebar-actions">
          <button onClick={() => setDialog("new")}>New list</button>
          <button className="ghost" onClick={() => setDialog("join")}>
            Join with a link
          </button>
        </div>
      </nav>

      <main className="main">
        {current ? <ListView device={device} listDid={current} inviteBase={inviteBase} /> : <Welcome onNew={() => setDialog("new")} />}
      </main>

      {inspecting && <Inspector device={device} listDid={current} />}

      {dialog === "new" && (
        <NewListDialog
          onClose={() => setDialog(null)}
          onCreate={async (name) => {
            const did = await device.createList(name);
            setSelected(did);
            setDialog(null);
          }}
        />
      )}
      {dialog === "join" && (
        <JoinDialog
          initial={readInvite() ?? ""}
          onClose={() => {
            setDialog(null);
            if (location.hash.includes("invite=")) history.replaceState(null, "", location.pathname + location.search);
          }}
          onJoin={async (text) => {
            await device.join(text);
            setSelected(Device.decodeInvitation(text).list);
            setDialog(null);
            if (location.hash.includes("invite=")) history.replaceState(null, "", location.pathname + location.search);
          }}
        />
      )}
    </div>
  );
}

function Welcome({ onNew }: { onNew: () => void }) {
  return (
    <section className="welcome">
      <h2>Make your first list</h2>
      <p>Then invite people with a link. They'll need this app open on their own device.</p>
      <button className="primary" onClick={onNew}>
        New list
      </button>
    </section>
  );
}

function NewListDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  return (
    <Dialog title="New list" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void onCreate(name.trim());
        }}
      >
        <label htmlFor="list-name">List name</label>
        <input id="list-name" autoComplete="off" data-1p-ignore value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Groceries" />
        <p className="hint">The list gets its own key on this device. You'll be its admin.</p>
        <button type="submit" className="primary">
          Create list
        </button>
      </form>
    </Dialog>
  );
}

function JoinDialog({ initial, onClose, onJoin }: { initial: string; onClose: () => void; onJoin: (text: string) => Promise<void> }) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState("");
  let preview = "";
  try {
    if (text.trim()) {
      const inv = Device.decodeInvitation(text);
      preview = `${inv.inviterName} invited you to "${inv.listName}" as ${inv.role === "viewer" ? "a viewer" : "an editor"}.`;
    }
  } catch {
    preview = "";
  }
  return (
    <Dialog title="Join a list" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          onJoin(text).catch((err) => setError(String(err?.message ?? err)));
        }}
      >
        <label htmlFor="invite">Invitation link</label>
        <textarea id="invite" value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Paste the link you were sent" />
        {preview && <p className="preview">{preview}</p>}
        {error && <p className="form-error">{error}</p>}
        <button type="submit" className="primary" disabled={!preview}>
          Ask to join
        </button>
      </form>
    </Dialog>
  );
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button className="ghost" onClick={onClose} aria-label="Close">
            Close
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
