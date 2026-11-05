import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./styles.css";
import policyUrl from "../../policies/policy.wasm?url";
import { App } from "./App";

const loadPolicy = () => fetch(policyUrl).then((r) => r.arrayBuffer());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App loadPolicy={loadPolicy} />
  </StrictMode>,
);
