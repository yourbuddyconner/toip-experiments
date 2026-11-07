/** What a controller or watcher needs from a witness, wherever it runs. */
import type { Problem, Qb64, SignedMessage } from "./types";

export type Refusal = "invalid" | "duplicity" | "unknownController" | "clockSkew";

export type SubmitResult =
  | { ok: true; receipts: string }
  /** `receipts` holds receipts for messages before the refused one. (Additive.) */
  | { ok: false; refusal: Refusal; problems: Problem[]; firstSeen?: string; receipts?: string };

export interface WitnessClient {
  readonly aid: Qb64;
  submit(stream: string): Promise<SubmitResult>;
  addReceipts(stream: string): Promise<void>;
  /** Stream with attachments and receipts. */
  query(q: { logId: Qb64; from?: number; to?: number }): Promise<string>;
  /** The witness's receipt of the latest message it holds. */
  head(logId: Qb64): Promise<SignedMessage | undefined>;
}

export class WitnessError extends Error {
  constructor(
    message: string,
    readonly details: { entry?: SignedMessage; receipts: number; needed: number; missing: { witness: Qb64; error: string }[] },
  ) {
    super(message);
    this.name = "WitnessError";
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}
