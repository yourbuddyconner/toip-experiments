import "@fontsource-variable/libre-franklin";
import "@fontsource/ibm-plex-mono/400.css";
import "../common/base.css";
import "./acme.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
