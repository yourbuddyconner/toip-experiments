import { createRoot } from "react-dom/client";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/public-sans";
import "./styles.css";
import { App } from "./App";

// No StrictMode: it mounts effects twice in development, and an account must run exactly one party per tab.
createRoot(document.getElementById("root")!).render(<App />);
