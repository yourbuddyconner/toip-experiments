/** Stand-ins for the browser: localStorage, and passkeys with the PRF extension. */
import { createHmac, randomBytes } from "node:crypto";

export class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  keys() {
    return [...this.m.keys()];
  }
}

const ab = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const bytes = (s: BufferSource) => (s instanceof ArrayBuffer ? new Uint8Array(s) : new Uint8Array(s.buffer, s.byteOffset, s.byteLength));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export interface AuthenticatorOptions {
  /** No PRF at all: an older authenticator. */
  noPrf?: boolean;
  /** PRF only when signing in, not when the passkey is made (some authenticators do this). */
  prfOnlyOnGet?: boolean;
}

/** A passkey authenticator with PRF: each credential has a secret, and PRF(salt) = HMAC-SHA-256(secret, salt). */
export class FakeAuthenticator {
  readonly credentials = new Map<string, Buffer>();
  readonly calls: { op: "create" | "get"; options: CredentialCreationOptions | CredentialRequestOptions }[] = [];
  constructor(private o: AuthenticatorOptions = {}) {}

  private prf(id: string, salt: BufferSource | undefined) {
    if (this.o.noPrf || !salt) return undefined;
    return ab(createHmac("sha256", this.credentials.get(id)!).update(bytes(salt)).digest());
  }

  readonly api = {
    create: async (options: CredentialCreationOptions) => {
      this.calls.push({ op: "create", options });
      const id = randomBytes(16);
      this.credentials.set(hex(id), randomBytes(32));
      const salt = (options.publicKey?.extensions as { prf?: { eval?: { first?: BufferSource } } })?.prf?.eval?.first;
      const first = this.o.prfOnlyOnGet ? undefined : this.prf(hex(id), salt);
      const prf = this.o.noPrf ? undefined : { enabled: true, ...(first ? { results: { first } } : {}) };
      return { rawId: ab(id), getClientExtensionResults: () => (prf ? { prf } : {}) } as unknown as Credential;
    },
    get: async (options: CredentialRequestOptions) => {
      this.calls.push({ op: "get", options });
      const allowed = options.publicKey?.allowCredentials ?? [];
      const id = allowed.map((c) => hex(bytes(c.id))).find((x) => this.credentials.has(x));
      if (!id) throw Object.assign(new Error("no matching passkey"), { name: "NotAllowedError" });
      const salt = (options.publicKey?.extensions as { prf?: { eval?: { first?: BufferSource } } })?.prf?.eval?.first;
      const first = this.prf(id, salt);
      return { rawId: ab(Buffer.from(id, "hex")), getClientExtensionResults: () => (first ? { prf: { results: { first } } } : {}) } as unknown as Credential;
    },
  };
}
