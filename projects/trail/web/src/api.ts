/** Talking to the Trail service. Every verification happens here in the page, with the same library. */
import { evidenceFromJson, httpWitnessClient, type Bundle, type DuplicityEvidence } from "@zk-toip/eventlog";
import { buildView, type IdentifierView } from "../../src/view";

export interface Line {
  who: string;
  text: string;
  tone?: "ok" | "bad" | "warn" | "info" | "dim";
}
export interface StepReport {
  n: number;
  title: string;
  redTeam: boolean;
  lines: Line[];
  at: string;
}
export interface WitnessInfo {
  n: number;
  name: string;
  aid: string;
  url: string;
  path: string;
  rogue: boolean;
  inUse: boolean;
}
export interface KeripyOutcome {
  ran: boolean;
  reason?: string;
  python?: string;
  matches?: { aid: string; label: string; ok: boolean; ours: Record<string, unknown>; theirs?: Record<string, unknown>; differences: string[] }[];
}
export interface State {
  progress: number;
  steps: { n: number; title: string; redTeam: boolean; summary: string; done: boolean }[];
  reports: StepReport[];
  logs: { aid: string; label: string; trailId: string }[];
  witnesses: WitnessInfo[];
  ada: { did: string };
  scout: { aid: string; trailId: string; did: string } | null;
  policy: string;
  keripy: KeripyOutcome | null;
  names: Record<string, string>;
}
export interface Sample {
  id: string;
  title: string;
  note: string;
  bundle: Bundle;
}
export interface Capture {
  label: string;
  bytes: string;
  sig: string;
  note: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `${path}: HTTP ${r.status}`);
  return body;
}

const post = (path: string, body: unknown) => call<unknown>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const getState = () => call<State>("/api/state");
export const runStep = (n: number) => post("/api/step", { n }) as Promise<{ report: StepReport; state: State }>;
export const resetDemo = () => post("/api/reset", {}) as Promise<State>;
export const getSamples = () => call<Sample[]>("/api/samples");
export const getCaptures = () => call<{ captures: Capture[]; camera: { aid: string; trailId: string } | null }>("/api/captures");
export const getBundle = async (aid: string) => (await call<{ bundle: Bundle }>(`/api/bundle?aid=${encodeURIComponent(aid)}`)).bundle;

export async function getEvidence(): Promise<{ holder: string; evidence: DuplicityEvidence }[]> {
  const list = await call<{ holder: string; evidence: Parameters<typeof evidenceFromJson>[0] }[]>("/api/evidence");
  return list.map((x) => ({ holder: x.holder, evidence: evidenceFromJson(x.evidence) }));
}

/** Clients for the platform's witnesses, through this origin's /w/<n> routes. */
export function witnessClients(state: State) {
  return state.witnesses.map((w) => httpWitnessClient(`${location.origin}${w.path}`, w.aid));
}

/** Fetches an AID's bundle and the evidence held about it, and verifies it here, comparing heads with the witnesses. */
export async function loadView(aid: string, state: State): Promise<IdentifierView> {
  const [bundle, evidence] = await Promise.all([getBundle(aid), getEvidence()]);
  const { view } = await buildView(bundle, { names: state.names, witnesses: witnessClients(state), evidence: evidence.map((e) => e.evidence) });
  return view;
}

/** Where each piece of evidence is held. */
export async function evidenceHolders(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const { holder, evidence: e } of await getEvidence()) {
    const k = `${e.kind}|${e.logId}|${e.s}|${e.witness ?? ""}`;
    out.set(k, [...new Set([...(out.get(k) ?? []), holder])]);
  }
  return out;
}
