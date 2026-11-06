/**
 * Who may run the platform: operators, each a DID. An operator signs in by signing a one-time challenge
 * with their identity key, the same key their Settle account already holds, and gets a session cookie.
 * Nobody types a password, and the platform never holds an operator's key.
 *
 * A new platform has no operators. It prints a setup code once at start; the first account to sign in
 * with that code becomes the operator, and can then add others.
 */
import { verifyDocument, type Clock } from "@zk-toip/trust-core";

export const SESSION_COOKIE = "settle_operator";
const CHALLENGE_TTL_MS = 2 * 60_000;
export const SESSION_TTL_MS = 12 * 3600_000;
const MAX_CHALLENGES = 1000;

export interface OperatorProof {
  type: "settle/operator-login";
  issuer: string;
  nonce: string;
  /** The platform's network id, so a proof for one platform is never good at another. */
  audience: string;
  proof?: unknown;
}

export class OperatorError extends Error {}

const token = (bytes = 32) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");

export class Operators {
  private readonly challenges = new Map<string, number>();
  private readonly sessions = new Map<string, { did: string; expires: number }>();
  /** Set while the platform has no operator: whoever signs in with it becomes the first. */
  setupCode: string | null;

  constructor(
    private readonly list: string[],
    private readonly audience: string,
    private readonly clock: Clock,
    private readonly save: () => void,
  ) {
    this.setupCode = list.length ? null : token(12);
  }

  get dids(): readonly string[] {
    return this.list;
  }

  challenge(): { nonce: string; audience: string; expiresAt: string } {
    const now = Date.now();
    for (const [n, exp] of this.challenges) if (exp < now) this.challenges.delete(n);
    if (this.challenges.size >= MAX_CHALLENGES) throw new OperatorError("too many sign-ins in progress; try again in a minute");
    const nonce = token();
    this.challenges.set(nonce, now + CHALLENGE_TTL_MS);
    return { nonce, audience: this.audience, expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString() };
  }

  /** Checks a signed challenge and opens a session. With the setup code, the signer becomes the first operator. */
  async login(p: OperatorProof, setupCode?: string): Promise<{ session: string; did: string; expires: number }> {
    if (p?.type !== "settle/operator-login" || typeof p.issuer !== "string" || typeof p.nonce !== "string") throw new OperatorError("expected a signed settle/operator-login");
    const exp = this.challenges.get(p.nonce);
    // One use per challenge, whatever happens next.
    this.challenges.delete(p.nonce);
    if (!exp || exp < Date.now()) throw new OperatorError("that sign-in challenge expired; try again");
    if (p.audience !== this.audience) throw new OperatorError("that sign-in was for another platform");
    if (!(await verifyDocument(p, this.clock)).valid) throw new OperatorError("the sign-in signature doesn't check out");
    if (setupCode !== undefined) {
      if (!this.setupCode || setupCode !== this.setupCode) throw new OperatorError(this.setupCode ? "wrong setup code" : "this platform already has an operator: ask them to add you");
      this.list.push(p.issuer);
      this.setupCode = null;
      this.save();
    } else if (!this.list.includes(p.issuer)) {
      throw new OperatorError("that account isn't an operator of this platform");
    }
    const session = token();
    const expires = Date.now() + SESSION_TTL_MS;
    this.sessions.set(session, { did: p.issuer, expires });
    return { session, did: p.issuer, expires };
  }

  /** The operator a session cookie belongs to, if it's live and they're still an operator. */
  whoIs(cookieHeader: string | undefined): string | null {
    const session = parseCookies(cookieHeader)[SESSION_COOKIE];
    const s = session ? this.sessions.get(session) : undefined;
    if (!s) return null;
    if (s.expires < Date.now() || !this.list.includes(s.did)) {
      this.sessions.delete(session!);
      return null;
    }
    return s.did;
  }

  logout(cookieHeader: string | undefined): void {
    const session = parseCookies(cookieHeader)[SESSION_COOKIE];
    if (session) this.sessions.delete(session);
  }

  add(did: string): void {
    if (!/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(did)) throw new OperatorError("that isn't a DID");
    if (!this.list.includes(did)) {
      this.list.push(did);
      this.save();
    }
  }

  remove(did: string, by: string): void {
    if (did === by) throw new OperatorError("you can't remove yourself; ask another operator");
    const i = this.list.indexOf(did);
    if (i < 0) throw new OperatorError("not an operator");
    this.list.splice(i, 1);
    this.save();
    for (const [k, s] of this.sessions) if (s.did === did) this.sessions.delete(k);
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(session: string, maxAgeMs: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? "; Secure" : ""}`;
}
