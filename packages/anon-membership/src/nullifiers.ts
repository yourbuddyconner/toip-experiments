import { fieldToHex, type Field } from "./field.js";

export interface NullifierBookState {
  v: 1;
  prefix: string;
  /** "<group> <scope hex>" → nullifier hexes in order of first sight. */
  books: Record<string, string[]>;
}

function letters(n: number): string {
  let s = "";
  for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

/** Turns nullifiers into stable labels, "Source A", "Source B", …, per (group, scope), in order of first sight. */
export class NullifierBook {
  private readonly prefix: string;
  private readonly books = new Map<string, Map<string, number>>();

  constructor(state?: NullifierBookState, opts: { prefix?: string } = {}) {
    this.prefix = state?.prefix ?? opts.prefix ?? "Source";
    for (const [key, list] of Object.entries(state?.books ?? {})) this.books.set(key, new Map(list.map((n, i) => [n, i])));
  }

  private book(group: string, scope: Field): Map<string, number> {
    const key = `${group} ${fieldToHex(scope)}`;
    let b = this.books.get(key);
    if (!b) this.books.set(key, (b = new Map()));
    return b;
  }

  label(group: string, scope: Field, nullifier: Field): { label: string; first: boolean } {
    const b = this.book(group, scope);
    const n = fieldToHex(nullifier);
    let i = b.get(n);
    const first = i === undefined;
    if (i === undefined) b.set(n, (i = b.size));
    return { label: `${this.prefix} ${letters(i)}`, first };
  }

  has(group: string, scope: Field, nullifier: Field): boolean {
    return this.book(group, scope).has(fieldToHex(nullifier));
  }

  /** Distinct nullifiers seen for (group, scope). */
  count(group: string, scope: Field): number {
    return this.book(group, scope).size;
  }

  state(): NullifierBookState {
    const books: Record<string, string[]> = {};
    for (const [k, b] of this.books) if (b.size) books[k] = [...b.keys()];
    return { v: 1, prefix: this.prefix, books };
  }
}
