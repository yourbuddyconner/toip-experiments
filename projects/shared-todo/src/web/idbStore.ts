import type { Store } from "../todo/store";

/** The device's store in the browser: one IndexedDB database per profile, one key-value object store. */
export class IndexedDBStore implements Store {
  private constructor(private readonly db: IDBDatabase) {}

  static open(name: string): Promise<IndexedDBStore> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(new IndexedDBStore(req.result));
      req.onerror = () => reject(req.error);
    });
  }

  private tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = fn(this.db.transaction("kv", mode).objectStore("kv"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.tx("readonly", (s) => s.get(key)) as Promise<T | undefined>;
  }

  async put(key: string, value: unknown): Promise<void> {
    await this.tx("readwrite", (s) => s.put(value, key));
  }

  async delete(key: string): Promise<void> {
    await this.tx("readwrite", (s) => s.delete(key));
  }

  async keys(prefix: string): Promise<string[]> {
    const all = (await this.tx("readonly", (s) => s.getAllKeys())) as IDBValidKey[];
    return all.map(String).filter((k) => k.startsWith(prefix));
  }
}
