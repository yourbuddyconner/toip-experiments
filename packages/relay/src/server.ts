/**
 * A mailbox relay for sealed TSP messages (design v2 §4.2).
 *
 * Devices authenticate as their did:key by signing a challenge bound to this relay's URL.
 * The relay stores every message until its recipient acknowledges it, delivering it live when
 * the recipient is connected. It sees who sends to whom, when and how much, never the contents.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { WebSocketServer, type WebSocket } from "ws";
import { fromB64u, resolveDidKey, toB64u, utf8 } from "@zk-toip/trust-core";

export const MAX_MESSAGE_BYTES = 256 * 1024;
export const MAX_QUEUED_PER_RECIPIENT = 5000;
export const QUEUE_TTL_MS = 30 * 24 * 3600_000;

export interface Relay {
  /** The URL clients connect to and sign in their authentication. */
  url: string;
  port: number;
  /** How many messages wait for `did`. */
  queued(did: string): number;
  close(): Promise<void>;
}

export interface RelayOptions {
  port: number;
  dbPath: string;
  /** The URL clients use, e.g. wss://relay.example.com/v1. Defaults to ws://localhost:<port>/v1. */
  publicUrl?: string;
  host?: string;
  log?: (line: string) => void;
  limits?: Partial<RelayLimits>;
}

export interface RelayLimits {
  /** Messages one sender may have waiting for one recipient (review I4). */
  perSenderPerRecipient: number;
  /** Messages waiting for one recipient, from everyone. */
  perRecipient: number;
  /** Bytes waiting for one recipient, from everyone. */
  bytesPerRecipient: number;
  /** How long a socket may stay unauthenticated. */
  authTimeoutMs: number;
  /** How many unacknowledged messages a connection is sent at a time. */
  window: number;
}

const DEFAULT_LIMITS: RelayLimits = {
  perSenderPerRecipient: 1000,
  perRecipient: MAX_QUEUED_PER_RECIPIENT,
  bytesPerRecipient: 64 * 1024 * 1024,
  authTimeoutMs: 15_000,
  window: 100,
};

interface Session {
  ws: WebSocket;
  nonce: string;
  did?: string;
  /** Highest message id sent on this connection, and how many are unacknowledged. */
  sentUpTo: number;
  inFlight: number;
}

type Frame = Record<string, unknown> & { t?: unknown };

export async function startRelay(opts: RelayOptions): Promise<Relay> {
  const log = opts.log ?? (() => {});
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const db = new DatabaseSync(opts.dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient TEXT NOT NULL,
      sender TEXT NOT NULL,
      wire BLOB NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_recipient ON messages (recipient, id);
  `);
  const insert = db.prepare("INSERT INTO messages (recipient, sender, wire, at) VALUES (?, ?, ?, ?)");
  const nextFor = db.prepare("SELECT id, sender, wire, at FROM messages WHERE recipient = ? AND id > ? ORDER BY id LIMIT ?");
  const countFor = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient = ?");
  const countFrom = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient = ? AND sender = ?");
  const bytesFor = db.prepare("SELECT COALESCE(SUM(LENGTH(wire)), 0) AS n FROM messages WHERE recipient = ?");
  const remove = db.prepare("DELETE FROM messages WHERE id = ? AND recipient = ?");
  const expire = db.prepare("DELETE FROM messages WHERE at < ?");
  const sweep = () => expire.run(Date.now() - QUEUE_TTL_MS);
  sweep();
  const sweeper = setInterval(sweep, 3600_000);
  sweeper.unref();

  const wss = new WebSocketServer({ port: opts.port, host: opts.host, path: "/v1", maxPayload: MAX_MESSAGE_BYTES * 2 });
  // A bad frame or socket must never take the relay down (review C1).
  wss.on("error", (e) => log(`server error: ${e.message}`));
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", reject);
  });
  const port = (wss.address() as { port: number }).port;
  const url = opts.publicUrl ?? `ws://localhost:${port}/v1`;
  const online = new Map<string, Session>();

  const send = (s: Session, frame: object) => {
    if (s.ws.readyState === s.ws.OPEN) s.ws.send(JSON.stringify(frame));
  };
  const deliver = (s: Session, row: { id: unknown; sender: unknown; wire: unknown; at: unknown }) => {
    s.sentUpTo = Math.max(s.sentUpTo, Number(row.id));
    s.inFlight++;
    send(s, { t: "msg", id: Number(row.id), from: row.sender, wire: toB64u(row.wire as Uint8Array), at: new Date(Number(row.at)).toISOString() });
  };
  /** Sends queued messages a window at a time, so a long queue is never loaded or sent all at once. */
  const pump = (s: Session) => {
    if (!s.did) return;
    const room = limits.window - s.inFlight;
    if (room <= 0) return;
    for (const row of nextFor.all(s.did, s.sentUpTo, room)) deliver(s, row as { id: unknown; sender: unknown; wire: unknown; at: unknown });
  };

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    const s: Session = { ws, nonce: toB64u(randomBytes(32)), sentUpTo: 0, inFlight: 0 };
    ws.on("error", () => ws.terminate());
    const authTimer = setTimeout(() => {
      if (!s.did) ws.terminate();
    }, limits.authTimeoutMs);
    send(s, { t: "challenge", nonce: s.nonce });

    ws.on("message", (data) => {
      let f: Frame;
      try {
        f = JSON.parse(String(data));
      } catch {
        return send(s, { t: "error", code: "malformed", message: "not JSON" });
      }
      if (f.t === "auth") {
        if (s.did) return send(s, { t: "error", code: "auth", message: "already authenticated" });
        return onAuth(s, f);
      }
      if (!s.did) {
        send(s, { t: "error", code: "auth", message: "authenticate first" });
        return;
      }
      if (f.t === "send") return onSend(s, f);
      if (f.t === "ack") {
        remove.run(Number(f.id), s.did);
        s.inFlight = Math.max(0, s.inFlight - 1);
        pump(s);
        return;
      }
      send(s, { t: "error", code: "malformed", message: `unknown frame ${String(f.t)}` });
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (s.did && online.get(s.did) === s) online.delete(s.did);
    });
  });

  function onAuth(s: Session, f: Frame): void {
    const did = typeof f.did === "string" ? f.did : "";
    const sig = typeof f.sig === "string" ? f.sig : "";
    let ok = false;
    try {
      ok = ed25519.verify(fromB64u(sig), utf8(`toip-relay-auth/v1|${s.nonce}|${url}`), resolveDidKey(did).signingKey);
    } catch {
      ok = false;
    }
    if (!ok) {
      send(s, { t: "error", code: "auth", message: "signature does not verify for this DID, challenge and relay" });
      s.ws.close(4001, "auth");
      return;
    }
    s.did = did;
    const prior = online.get(did);
    if (prior && prior !== s) prior.ws.close(4002, "replaced by a newer connection");
    online.set(did, s);
    send(s, { t: "ready" });
    pump(s);
    log(`connected ${did.slice(0, 20)}…`);
  }

  function onSend(s: Session, f: Frame): void {
    const cid = typeof f.cid === "string" ? f.cid : undefined;
    const to = typeof f.to === "string" ? f.to : "";
    let wire: Uint8Array;
    try {
      resolveDidKey(to);
      wire = fromB64u(String(f.wire ?? ""));
    } catch {
      return send(s, { t: "error", cid, code: "malformed", message: "bad recipient or wire" });
    }
    if (wire.length === 0) return send(s, { t: "error", cid, code: "malformed", message: "empty wire" });
    if (wire.length > MAX_MESSAGE_BYTES) return send(s, { t: "error", cid, code: "tooLarge", message: `over ${MAX_MESSAGE_BYTES} bytes` });
    const n = (q: { get: (...a: string[]) => unknown }, ...a: string[]) => Number((q.get(...a) as { n: number }).n);
    if (n(countFrom, to, s.did!) >= limits.perSenderPerRecipient || n(countFor, to) >= limits.perRecipient || n(bytesFor, to) + wire.length > limits.bytesPerRecipient) {
      return send(s, { t: "error", cid, code: "queueFull", message: "the recipient has too many waiting messages" });
    }
    const at = Date.now();
    const { lastInsertRowid } = insert.run(to, s.did!, wire, at);
    const target = online.get(to);
    if (target) pump(target);
    send(s, { t: "sent", cid, delivery: target ? "live" : "queued" });
  }

  return {
    url,
    port,
    queued: (did) => Number((countFor.get(did) as { n: number }).n),
    close: async () => {
      clearInterval(sweeper);
      for (const s of online.values()) s.ws.terminate();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      db.close();
    },
  };
}
