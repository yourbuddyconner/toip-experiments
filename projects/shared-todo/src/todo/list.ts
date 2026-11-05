import type { Op } from "./ops";

export interface Item {
  id: string;
  author: string;
  text?: string;
  /** A private item this device can't read. */
  locked: boolean;
  readers?: string[];
  checked: boolean;
  addedAt: string;
}

/** One device's copy of the list, built from the operations it accepted. */
export class ListState {
  private readonly byId = new Map<string, Item>();
  private readonly ops = new Map<string, Op>();

  /** Applies an accepted op. `readable` is private text this device decrypted. A repeated op id is ignored. */
  apply(op: Op, readable?: string): void {
    if (this.ops.has(op.id)) return;
    this.ops.set(op.id, op);
    const text = op.text ?? readable;
    const item = this.byId.get(op.itemId);
    switch (op.kind) {
      case "add":
        if (item) return;
        this.byId.set(op.itemId, {
          id: op.itemId,
          author: op.issuer,
          text,
          locked: text === undefined,
          ...(op.readers ? { readers: op.readers } : {}),
          checked: false,
          addedAt: op.at,
        });
        return;
      case "check":
      case "uncheck":
        if (item) item.checked = op.kind === "check";
        return;
      case "edit":
        if (item) {
          item.text = text;
          item.locked = text === undefined;
        }
        return;
      case "delete":
        this.byId.delete(op.itemId);
        return;
    }
  }

  has(itemId: string): boolean {
    return this.byId.has(itemId);
  }

  item(itemId: string): Item | undefined {
    return this.byId.get(itemId);
  }

  items(): Item[] {
    return [...this.byId.values()].sort((a, b) => (a.addedAt === b.addedAt ? a.author.localeCompare(b.author) : a.addedAt.localeCompare(b.addedAt)));
  }

  seen(opId: string): Op | undefined {
    return this.ops.get(opId);
  }

  /** Every accepted op, in the order it was accepted. */
  allOps(): Op[] {
    return [...this.ops.values()];
  }
}
