/**
 * Simulated time to display time. Radio moments play at their real length (slowed by the speed
 * control); long quiet stretches, like "two minutes later", shrink to a short break on the strip.
 */
import type { Trace } from "../../src/trace";

export const GAP_MS = 2500;
export const BREAK_MS = 700;
export const HOP_MS = 1400;
export const FADE_MS = 500;

export interface Break {
  d0: number;
  d1: number;
  /** Simulated time skipped. */
  skippedMs: number;
}

export interface Timeline {
  total: number;
  breaks: Break[];
  toD(v: number): number;
  toV(d: number): number;
  inBreak(d: number): boolean;
}

export function timeline(t: Trace): Timeline {
  const knots = new Set<number>([0, t.durationMs]);
  for (const f of t.frames) {
    knots.add(f.at);
    knots.add(f.at + f.airtimeMs + FADE_MS);
  }
  for (const h of t.hops) {
    knots.add(h.at);
    knots.add(h.at + HOP_MS);
  }
  for (const l of t.log) knots.add(l.at);
  const vs = [...knots].filter((v) => v >= 0).sort((a, b) => a - b);
  const ds = [0];
  const breaks: Break[] = [];
  for (let i = 1; i < vs.length; i++) {
    const gap = vs[i] - vs[i - 1];
    const d = gap > GAP_MS ? BREAK_MS : gap;
    if (gap > GAP_MS) breaks.push({ d0: ds[i - 1], d1: ds[i - 1] + d, skippedMs: gap });
    ds.push(ds[i - 1] + d);
  }
  const total = ds[ds.length - 1] + 600;
  const interp = (x: number, xs: number[], ys: number[]) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1] + (x - xs[xs.length - 1]);
    let lo = 0;
    let hi = xs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const span = xs[hi] - xs[lo];
    return span === 0 ? ys[lo] : ys[lo] + ((x - xs[lo]) / span) * (ys[hi] - ys[lo]);
  };
  return {
    total,
    breaks,
    toD: (v) => interp(v, vs, ds),
    toV: (d) => interp(d, ds, vs),
    inBreak: (d) => breaks.some((b) => d >= b.d0 && d < b.d1),
  };
}

export function skipLabel(ms: number): string {
  if (ms >= 3600_000) return `${(ms / 3600_000).toFixed(1)} h later`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min later`;
  return `${Math.round(ms / 1000)} s later`;
}
