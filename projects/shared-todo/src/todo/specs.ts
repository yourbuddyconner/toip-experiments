import { ourSpec } from "@zk-toip/trust-core";

/** Our Trust Task types, all under https://zk-toip.example/spec/todo/... (design 8). */
export const JOIN = ourSpec("todo/join");
export const ACK = ourSpec("todo/ack");
export const OP = ourSpec("todo/op");
export const SYNC = ourSpec("todo/sync");
export const STATUS = ourSpec("todo/status");
export const DEPOSIT = ourSpec("todo/relay/deposit");
export const COLLECT = ourSpec("todo/relay/collect");
