import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./styles.css";
import policyUrl from "../../policies/policy.wasm?url";
import { Policies, SystemClock } from "@toip-tools/trust-core";
import { Device } from "../todo/device";
import { App } from "./App";
import { IndexedDBStore } from "./idbStore";

const RELAY_URL: string = import.meta.env.VITE_RELAY_URL ?? "ws://localhost:8787/v1";
// ?profile=<name> keeps a separate device (keys and data) in this browser, for trying it with several people.
const profile = new URLSearchParams(location.search).get("profile")?.replace(/[^\w-]/g, "") || "default";
const root = createRoot(document.getElementById("root")!);

const policies = fetch(policyUrl)
  .then((r) => r.arrayBuffer())
  .then((b) => Policies.load(b));
const store = IndexedDBStore.open(`toip-todo-${profile}`);
let device: Promise<Device | null> | undefined;
const boot = (name?: string) => {
  if (!device || name) device = (async () => Device.open({ store: await store, relayUrl: RELAY_URL, policies: await policies, clock: new SystemClock(), name }))();
  return device;
};
const inviteBase = `${location.origin}${location.pathname}`;

function start() {
  root.render(
    <StrictMode>
      <App boot={boot} inviteBase={inviteBase} />
    </StrictMode>,
  );
}

// One tab per profile: a second tab would connect as the same device and fight the first.
if ("locks" in navigator) {
  void navigator.locks.request(`toip-todo-${profile}`, { ifAvailable: true }, (lock) => {
    if (!lock) {
      root.render(<p className="splash">This profile is open in another tab. Close that tab, or open this one with a different ?profile=.</p>);
      return;
    }
    start();
    return new Promise<void>(() => {}); // hold the lock while the tab lives
  });
} else {
  start();
}
