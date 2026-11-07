/** A LogStore kept in one JSON file. Writes are atomic (temporary file, then rename) within `flushMs` of a change. Node only. */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryStore, type StoreData } from "../store.js";

export class JsonFileStore extends MemoryStore {
  private timer?: ReturnType<typeof setTimeout>;
  private readonly flushMs: number;

  constructor(
    readonly path: string,
    opts: { flushMs?: number } = {},
  ) {
    super(existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as StoreData) : undefined);
    this.flushMs = opts.flushMs ?? 100;
  }

  protected override changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flushSync(), this.flushMs);
  }

  /** Writes now. */
  flushSync(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.dump()));
    renameSync(tmp, this.path);
  }

  async flush(): Promise<void> {
    this.flushSync();
  }

  /** Writes any pending change and stops the timer. */
  close(): void {
    if (this.timer) this.flushSync();
  }
}
