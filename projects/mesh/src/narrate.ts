/** Prints an act as it happens: radio frames with airtime and who heard them, hops, narration, sizes. */
import { CAST } from "./cast";
import { fmtBytes, fmtMs, type Trace, type TraceFrame, type TraceHop, type TraceLog } from "./trace";
import type { RecorderHooks } from "./recorder";

export interface Style {
  color: boolean;
}

const code = (n: string) => (s: string, st: Style) => (st.color ? `\x1b[${n}m${s}\x1b[0m` : s);
const dim = code("2");
const bold = code("1");
const red = code("31");
const green = code("32");
const yellow = code("33");
const magenta = code("35");
const cyan = code("36");

const WHO: Record<string, (s: string, st: Style) => string> = {
  rosa: cyan,
  door: yellow,
  eve: red,
  building: dim,
  alice: magenta,
  ridge: dim,
  lodge: yellow,
  relay: dim,
  landlord: green,
  neighbor: cyan,
};

const label = (who: string) => (CAST as Record<string, string>)[who] ?? who;
const time = (ms: number) => `${(ms / 1000).toFixed(3).padStart(8)} s`;

export function frameLine(f: TraceFrame, st: Style): string {
  const who = (WHO[f.from] ?? ((s: string) => s))(label(f.from).padEnd(20), st);
  const heard = f.heard.map((h) => (h.ok ? green(`${label(h.to)} ✓`, st) : red(`${label(h.to)} ✗ ${h.reason}`, st))).join("  ");
  const what = `${f.attack ? red("REPLAY ", st) : ""}${f.label}`.padEnd(f.attack ? 20 : 13);
  const pid = f.pid ? dim(` pid ${f.pid}${f.packet ? ` ${f.packet.toUpperCase()}` : ""}`, st) : "";
  return dim(`${time(f.at)}  `, st) + `${who} ${dim("▲", st)} ${what} ${String(f.bytes).padStart(3)} B ${fmtMs(f.airtimeMs).padStart(7)}${pid}  ${dim("→", st)} ${heard}`;
}

export function logLine(l: TraceLog, st: Style): string {
  const who = (WHO[l.who] ?? ((s: string) => s))(label(l.who).padEnd(20), st);
  const tone = l.tone === "ok" ? green : l.tone === "bad" ? red : l.tone === "warn" ? yellow : l.tone === "attack" ? red : l.tone === "step" ? bold : (s: string) => s;
  let s = dim(`${time(l.at)}  `, st) + `${who}   ${tone(l.text, st)}`;
  if (l.sizes) {
    const z = l.sizes;
    const p = z.packet ? ` → on the air ${bold(`${z.packet.kind.toUpperCase()} ${fmtBytes(z.packet.bytes)}`, st)}, ${z.packet.frames} frames${z.jsonFrames ? ` (${z.jsonFrames} as JSON)` : ""}` : "";
    s += `\n${" ".repeat(34)}${dim("sizes:", st)} JSON TSP ${fmtBytes(z.jsonSealed)} → CTT1 TSP ${fmtBytes(z.compactSealed)}${p}`;
  }
  return s;
}

export function hopLine(h: TraceHop, st: Style): string {
  const icon = h.via === "usb" ? "⎘ USB" : "⇢ internet";
  return dim(`${time(h.at)}  `, st) + `${label(h.from).padEnd(20)}   ${cyan(icon, st)} → ${label(h.to)}: ${h.label}, ${fmtBytes(h.bytes)}`;
}

/** Hooks that print an act as it runs. */
export function printer(out: (s: string) => void, st: Style): RecorderHooks {
  return { onFrame: (f) => out(frameLine(f, st)), onLog: (l) => out(logLine(l, st)), onHop: (h) => out(hopLine(h, st)) };
}

export function actHeader(act: number, title: string, detail: string, st: Style): string {
  const head = `Act ${act} · ${title}`;
  return `\n${bold(head, st)}\n${dim(detail, st)}\n${dim("─".repeat(Math.max(head.length, 60)), st)}`;
}

export function summary(t: Trace, st: Style): string {
  const lines = [`\n  ${t.summary.ok ? green("✓ done", st) : red("✗ did not complete", st)}  ${dim(`${fmtMs(t.summary.airtimeMs)} of airtime in all, ${t.summary.frames} frames, ${t.summary.retries} retries, ${fmtBytes(t.summary.bytesOnAir)} on the air`, st)}`];
  for (const f of t.summary.facts) lines.push(`  ${dim(f.label.padEnd(34), st)} ${f.value}`);
  return lines.join("\n");
}
