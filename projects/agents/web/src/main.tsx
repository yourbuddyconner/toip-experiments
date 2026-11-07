import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Console } from "./Console";
import { Courier } from "./Courier";

const path = location.pathname.replace(/\/+$/, "");
const page = path === "/courier" ? <Courier /> : <Console />;
document.title = path === "/courier" ? "Dana Ruiz · courier" : "Agent oversight · Conner Swann";

createRoot(document.getElementById("root")!).render(<StrictMode>{page}</StrictMode>);
