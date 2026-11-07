/**
 * What one act of the demo did, as data: the radio frames (with who heard each one), the hops over the
 * internet and by hand, and a narrated log. The terminal demo prints it as it happens; the visualizer
 * plays it back. Times are milliseconds of simulated time from the start of the act.
 *
 * This file is shared with the web app, so it imports nothing.
 */

export type NodeRole = "guest" | "door" | "listener" | "tenant" | "relay" | "gateway" | "internet" | "party" | "courier";

export interface TraceNode {
  id: string;
  label: string;
  role: NodeRole;
  /** On a 1000 × 600 field. */
  x: number;
  y: number;
  /** A radio node: its airtime budget per hour (ms) and the setting it transmits on. */
  radio?: { budgetMsPerHour: number; setting: string; maxFrameMs?: number };
  note?: string;
}

export interface TraceFrame {
  at: number;
  from: string;
  airtimeMs: number;
  bytes: number;
  type: "data" | "ack" | "beacon" | "junk";
  /** "DATA 1/3", "ACK", "BEACON door". */
  label: string;
  pid?: string;
  index?: number;
  count?: number;
  /** For fragment 0 of a packet: its kind (intro, pair, via, receipt). */
  packet?: string;
  /** Set when the frame was sent by an attacker. */
  attack?: boolean;
  heard: { to: string; ok: boolean; reason?: string }[];
}

/** A hop that isn't radio: a gateway posting to the relay, the relay delivering, a file on a USB stick. */
export interface TraceHop {
  at: number;
  from: string;
  to: string;
  via: "internet" | "usb";
  bytes: number;
  label: string;
}

/** Sizes of one Trust Task message: sealed with the standard JSON body, sealed with CTT1, and as a radio packet. */
export interface MessageSizes {
  what: string;
  jsonSealed: number;
  compactSealed: number;
  packet?: { kind: string; bytes: number; frames: number; route: string };
  /** Frames the JSON-sealed message would have needed. */
  jsonFrames?: number;
}

export type Tone = "info" | "ok" | "bad" | "warn" | "attack" | "step";

export interface TraceLog {
  at: number;
  who: string;
  text: string;
  tone: Tone;
  sizes?: MessageSizes;
}

export interface Fact {
  label: string;
  value: string;
}

export interface Trace {
  act: 1 | 2 | 3;
  title: string;
  subtitle: string;
  plan: string;
  loss: number;
  seed: number;
  /** Wall-clock start of the simulated act (ISO). */
  startedAt: string;
  durationMs: number;
  nodes: TraceNode[];
  /** Pairs in radio range. */
  links: [string, string][];
  frames: TraceFrame[];
  hops: TraceHop[];
  log: TraceLog[];
  summary: { ok: boolean; airtimeMs: number; frames: number; retries: number; bytesOnAir: number; facts: Fact[] };
}

export const fmtBytes = (n: number) => `${n.toLocaleString("en-US")} B`;
export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
