import { ourSpec } from "@toip-tools/trust-core";

/** Our Trust Task types (design v2 §4.3), all one-way, under https://toip.tools/spec/todo/... */
export const JOIN = ourSpec("todo/join");
export const WELCOME = ourSpec("todo/welcome");
export const JOIN_REFUSED = ourSpec("todo/join-refused");
export const ACK = ourSpec("todo/ack");
export const OP = ourSpec("todo/op");
export const ROSTER = ourSpec("todo/roster");
export const SYNC_REQUEST = ourSpec("todo/sync-request");
export const SYNC = ourSpec("todo/sync");
export const LEAVE = ourSpec("todo/leave");

export const SPEC_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries({ JOIN, WELCOME, JOIN_REFUSED, ACK, OP, ROSTER, SYNC_REQUEST, SYNC, LEAVE }).map(([, s]) => [s.typeUri, s.typeUri.split("/spec/todo/")[1].replace("/0.1", "")]),
);
