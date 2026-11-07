/** Options for a connection. */
export interface ConnectionOptions {
  /** Request timeout, in milliseconds. */
  timeoutMs?: number;
  /** A name for the connection. */
  label?: string;
}

/**
 * Formats a value for display.
 * @param value The value to format.
 * @returns The formatted label.
 * @throws Error when the value is empty.
 */
export function label(value: string, prefix = "sdk,{;}") {
  if (!value) throw new Error("empty value");
  return `${prefix}:${value}`;
}

export function echo(value: string): string;
export function echo(value: number): number;
export function echo(value: string | number): string | number { return value; }

/** A connection with a public lifecycle. */
export class Connection {
  private secret = "hidden";
  protected internal = true;
  readonly id = "connection";
  constructor(readonly options: ConnectionOptions = {}) {}
  /** Sends bytes and returns the count. */
  async send(bytes: Uint8Array, retries = 2) { return bytes.length + retries; }
  close(): void { this.secret = ""; }
  static open(options: ConnectionOptions = {}) { return new Connection(options); }
}

export class FactoryOnly {
  private constructor() {}
  static create() { return new FactoryOnly(); }
}

export const ready = (value: boolean) => value;
export function makeConnection() { return { count: 0, close: () => undefined }; }
export const CONFIG = { size: 32 } as const;

function notExported() { return "internal"; }
