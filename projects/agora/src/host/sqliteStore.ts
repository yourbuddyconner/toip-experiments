/**
 * The host's log store in node:sqlite: eventlog's MemoryStore, written to tables after each change.
 * One row per message and per body, so an operator (or the tamper demo) can read and edit them.
 */
import { MemoryStore, type StoreData, type StoredMessage } from "@zk-toip/eventlog";
import { DatabaseSync } from "node:sqlite";

export class SqliteLogStore extends MemoryStore {
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  private constructor(
    private readonly db: DatabaseSync,
    data: StoreData | undefined,
  ) {
    super(data);
  }

  static open(path: string): SqliteLogStore {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (fn INTEGER PRIMARY KEY, log_id TEXT, s INTEGER, d TEXT, t TEXT, raw TEXT, attachments TEXT, seen_at TEXT, local INTEGER, superseded TEXT, cut_by INTEGER);
      CREATE TABLE IF NOT EXISTS bodies (said TEXT PRIMARY KEY, raw TEXT);
      CREATE TABLE IF NOT EXISTS receipts (k TEXT PRIMARY KEY, json TEXT);
      CREATE TABLE IF NOT EXISTS evidence (n INTEGER PRIMARY KEY, json TEXT);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
    const rows = db.prepare("SELECT * FROM messages ORDER BY fn").all() as Record<string, unknown>[];
    let data: StoreData | undefined;
    if (rows.length) {
      const messages: StoredMessage[] = rows.map((r) => ({
        fn: Number(r.fn),
        logId: String(r.log_id),
        s: Number(r.s),
        d: String(r.d),
        t: String(r.t) as StoredMessage["t"],
        raw: String(r.raw),
        attachments: String(r.attachments),
        seenAt: String(r.seen_at),
        local: !!r.local,
        ...(r.superseded ? { superseded: String(r.superseded) } : {}),
        ...(r.cut_by !== null && r.cut_by !== undefined ? { cutBy: Number(r.cut_by) } : {}),
      }));
      const fnRow = db.prepare("SELECT v FROM meta WHERE k = 'fn'").get() as { v?: string } | undefined;
      data = {
        messages,
        bodies: (db.prepare("SELECT said, raw FROM bodies").all() as { said: string; raw: string }[]).map((b) => [b.said, b.raw]),
        receipts: (db.prepare("SELECT k, json FROM receipts").all() as { k: string; json: string }[]).map((r) => [r.k, JSON.parse(r.json)]),
        evidence: (db.prepare("SELECT json FROM evidence ORDER BY n").all() as { json: string }[]).map((e) => JSON.parse(e.json)),
        fn: Number(fnRow?.v ?? messages[messages.length - 1].fn),
      };
    }
    return new SqliteLogStore(db, data);
  }

  protected override changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 20);
  }

  /** Writes everything now, in one transaction. */
  flush(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const d = this.dump();
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM messages; DELETE FROM bodies; DELETE FROM receipts; DELETE FROM evidence;");
      const m = this.db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const x of d.messages) m.run(x.fn, x.logId, x.s, x.d, x.t, x.raw, x.attachments, x.seenAt, x.local ? 1 : 0, x.superseded ?? null, x.cutBy ?? null);
      const b = this.db.prepare("INSERT INTO bodies VALUES (?, ?)");
      for (const [said, raw] of d.bodies) b.run(said, raw);
      const r = this.db.prepare("INSERT INTO receipts VALUES (?, ?)");
      for (const [k, v] of d.receipts) r.run(k, JSON.stringify(v));
      const e = this.db.prepare("INSERT INTO evidence (json) VALUES (?)");
      for (const x of d.evidence) e.run(JSON.stringify(x));
      this.db.prepare("INSERT OR REPLACE INTO meta VALUES ('fn', ?)").run(String(d.fn));
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.db.close();
    this.closed = true;
  }
}
