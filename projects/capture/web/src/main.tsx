import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { navigate } from "./app";
import { CameraPage } from "./pages/Camera";
import { EditorPage } from "./pages/Editor";
import { VerifyPage } from "./pages/Verify";
import { SensorsPage } from "./pages/Sensors";
import { OwnerPage } from "./pages/Owner";

const PAGES = [
  { path: "/camera", name: "Camera", Page: CameraPage },
  { path: "/edit", name: "Editor", Page: EditorPage },
  { path: "/verify", name: "Verify", Page: VerifyPage },
  { path: "/sensors", name: "Sensors", Page: SensorsPage },
  { path: "/owner", name: "Owner", Page: OwnerPage },
];

function Mark() {
  return (
    <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="5" fill="#10263A" />
      <path d="M7 7h6M7 7v6M25 25h-6M25 25v-6" stroke="#E6EAEC" strokeWidth="2.4" fill="none" />
      <circle cx="16" cy="16" r="3.6" fill="#C8891B" />
    </svg>
  );
}

function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  const page = PAGES.find((p) => path.startsWith(p.path));
  useEffect(() => {
    if (!page) navigate("/verify");
    document.title = page ? `${page.name} · Capture` : "Capture";
  }, [page]);
  const go = (e: React.MouseEvent<HTMLAnchorElement>, to: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="shell-head">
        <a className="wordmark" href="/verify" onClick={(e) => go(e, "/verify")}>
          <Mark />
          <span>Capture</span>
        </a>
        <nav className="nav" aria-label="Capture">
          {PAGES.map((p) => (
            <a key={p.path} href={p.path} aria-current={page?.path === p.path ? "page" : undefined} onClick={(e) => go(e, p.path)}>
              {p.name}
            </a>
          ))}
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        {page ? <page.Page key={page.path} /> : null}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
