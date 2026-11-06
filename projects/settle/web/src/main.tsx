import { createRoot } from "react-dom/client";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/public-sans";
import "./styles.css";
import { App } from "./App";

// Passkeys need a domain, not an IP address: on this machine, Settle is used at localhost.
if (location.hostname === "127.0.0.1") {
  location.replace(`${location.protocol}//localhost:${location.port}${location.pathname}${location.search}${location.hash}`);
} else {
  // No StrictMode: it mounts effects twice in development, and an account must run exactly one party per tab.
  createRoot(document.getElementById("root")!).render(<App />);
}
