import { canonicalJson } from "@toip-tools/trust-core";
import { opKey, type Op } from "./ops";

export interface Item {
  id: string;
  author: string;
  text?: string;
  /** Private, and this device can't read it. */
  locked: boolean;
  private: boolean;
  /** For a private item: who its key was actually sealed to. */
  readers?: string[];
  checked: boolean;
  addedAt: string;
}

const time = (op: Op) => Date.parse(op.at);
const order = (a: Op, b: Op) =>
  time(a) !== time(b) ? time(a) - time(b) : a.issuer !== b.issuer ? (a.issuer < b.issuer ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * One device's copy of a list, built from the ops it accepted (design v2 §4.6).
 * Items are rebuilt in (at, author, id) order, so every device with the same ops shows the same
 * list: the first add creates an item, the last check/uncheck and the last edit win, and a delete is final.
 */
export class ListModel {
  private readonly byKey = new Map<string, Op>();
  private readonly readable = new Map<string, string>();
  private cache?: Map<string, Item>;

  /** Adds an accepted op. `readable` is private text this device decrypted from it. */
  insert(op: Op, readable?: string): "new" | "duplicate" | "conflict" {
    const key = opKey(op);
    const known = this.byKey.get(key);
    if (known) return canonicalJson(known) === canonicalJson(op) ? "duplicate" : "conflict";
    this.byKey.set(key, op);
    if (readable !== undefined) this.readable.set(key, readable);
    this.cache = undefined;
    return "new";
  }

  /** Whether `op` is an identical copy of one already held under the same author and id. */
  insertWouldDuplicate(op: Op): boolean {
    const known = this.byKey.get(opKey(op));
    return !!known && canonicalJson(known) === canonicalJson(op);
  }

  /** Removes every op matching `drop`, e.g. a removed member's ops that their removal didn't keep. */
  drop(drop: (op: Op) => boolean): number {
    let n = 0;
    for (const [key, op] of this.byKey) {
      if (drop(op)) {
        this.byKey.delete(key);
        this.readable.delete(key);
        n++;
      }
    }
    if (n) this.cache = undefined;
    return n;
  }

  get(key: string): Op | undefined {
    return this.byKey.get(key);
  }

  ops(): Op[] {
    return [...this.byKey.values()];
  }

  has(itemId: string): boolean {
    return this.state().has(itemId);
  }

  item(itemId: string): Item | undefined {
    return this.state().get(itemId);
  }

  items(): Item[] {
    return [...this.state().values()].sort((a, b) =>
      Date.parse(a.addedAt) !== Date.parse(b.addedAt) ? Date.parse(a.addedAt) - Date.parse(b.addedAt) : a.author < b.author ? -1 : 1,
    );
  }

  private state(): Map<string, Item> {
    if (this.cache) return this.cache;
    const items = new Map<string, Item>();
    // A delete wins over everything, whatever its time.
    const deleted = new Set([...this.byKey.values()].filter((o) => o.kind === "delete").map((o) => o.itemId));
    for (const op of [...this.byKey.values()].sort(order)) {
      if (deleted.has(op.itemId)) continue;
      const item = items.get(op.itemId);
      const text = op.text ?? this.readable.get(opKey(op));
      if (op.kind === "add") {
        if (item) continue;
        const priv = op.sealed !== undefined;
        items.set(op.itemId, {
          id: op.itemId,
          author: op.issuer,
          text,
          locked: priv && text === undefined,
          private: priv,
          ...(priv ? { readers: op.sealed!.keys.map((k) => k.to) } : {}),
          checked: false,
          addedAt: op.at,
        });
      } else if (!item) {
        continue;
      } else if (op.kind === "check" || op.kind === "uncheck") {
        item.checked = op.kind === "check";
      } else if (op.kind === "edit") {
        item.text = text;
        item.locked = item.private && text === undefined;
      }
    }
    this.cache = items;
    return items;
  }
}
