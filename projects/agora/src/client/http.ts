/** The host's and the registrars' HTTP APIs (design §7.7), for the client and the tests. */
import { fromB64u } from "@toip-tools/trust-core";
import type { GroupRoot } from "@toip-tools/anon-membership";
import type { DeleteDoc, ForumPolicy, Gate, GroupDescriptor, Moderation, NymPass, PinnedRoot, Poll, Post, ReportDoc, Vote } from "../protocol/documents";
import type { FeedView, PollView } from "../host/host";
import type { IssuerInfo } from "../issuers/issuers";

export class AgoraError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "AgoraError";
  }
}

type Fetch = typeof fetch;

async function call<T>(f: Fetch, url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await f(url, init);
  } catch (e) {
    throw new AgoraError("unreachable", `couldn't reach ${new URL(url).host}: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new AgoraError("badResponse", `${res.status} from ${url}`, res.status);
  }
  if (!res.ok) {
    const b = body as { code?: string; message?: string } | null;
    throw new AgoraError(b?.code ?? "httpError", b?.message ?? `${res.status} from ${url}`, res.status);
  }
  return body as T;
}

const post = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export interface ForumInfo {
  policy: ForumPolicy;
  policyHash: string;
  groups: GroupDescriptor[];
  acceptedRoots: GroupRoot[];
  head: { s: number; d: string };
}

export class HostApi {
  constructor(
    readonly url: string,
    private readonly f: Fetch = (...a) => fetch(...a),
  ) {}
  private u = (p: string) => `${this.url}${p}`;
  private fid = (id: string) => encodeURIComponent(id);

  info = () => call<{ did: string; aid: string; now: number; devClock: boolean }>(this.f, this.u("/info"));
  time = () => call<{ now: number }>(this.f, this.u("/time"));
  advance = (seconds: number) => call<{ now: number }>(this.f, this.u("/dev/advance"), post({ seconds }));
  forums = () => call<{ forums: { policy: ForumPolicy; head: { s: number; d: string } }[] }>(this.f, this.u("/forums"));
  forum = (id: string) => call<ForumInfo>(this.f, this.u(`/forums/${this.fid(id)}`));
  feed = (id: string) => call<FeedView>(this.f, this.u(`/forums/${this.fid(id)}/feed`));
  poll = (id: string, pid: string) => call<PollView>(this.f, this.u(`/forums/${this.fid(id)}/polls/${this.fid(pid)}`));
  pin = (id: string, gate: Gate) => call<{ pinned: PinnedRoot[] }>(this.f, this.u(`/forums/${this.fid(id)}/pin`), post({ gate }));
  createForum = (p: ForumPolicy) => call<{ forum: string; seq: number }>(this.f, this.u("/forums"), post(p));
  updatePolicy = (id: string, p: ForumPolicy) => call<{ seq: number }>(this.f, this.u(`/forums/${this.fid(id)}/policy`), post(p, "PUT"));
  pass = (id: string, p: NymPass) => call<{ accepted: true; seq: number; nym: string }>(this.f, this.u(`/forums/${this.fid(id)}/passes`), post(p));
  post = (id: string, p: Post) => call<{ seq: number }>(this.f, this.u(`/forums/${this.fid(id)}/posts`), post(p));
  delete = (id: string, d: DeleteDoc) => call<{ seq: number }>(this.f, this.u(`/forums/${this.fid(id)}/deletes`), post(d));
  report = (id: string, r: ReportDoc) => call<{ seq: number }>(this.f, this.u(`/forums/${this.fid(id)}/reports`), post(r));
  moderate = (id: string, m: Moderation) => call<{ seq: number }>(this.f, this.u(`/forums/${this.fid(id)}/moderation`), post(m));
  openPoll = (id: string, p: Poll) => call<{ seq: number }>(this.f, this.u(`/forums/${this.fid(id)}/polls`), post(p));
  vote = (id: string, pid: string, v: Vote) => call<{ seq: number; replaced: boolean }>(this.f, this.u(`/forums/${this.fid(id)}/polls/${this.fid(pid)}/votes`), post(v));
  eventsUrl = (id: string) => this.u(`/forums/${this.fid(id)}/events`);
}

export class RegistrarApi {
  constructor(
    readonly url: string,
    private readonly f: Fetch = (...a) => fetch(...a),
  ) {}
  private u = (p: string) => `${this.url}${p}`;
  private g = (id: string) => encodeURIComponent(id);

  groups = () => call<{ groups: GroupDescriptor[] }>(this.f, this.u("/groups"));
  issuers = () => call<{ issuers: IssuerInfo[] }>(this.f, this.u("/issuers"));
  group = (id: string) => call<GroupDescriptor>(this.f, this.u(`/groups/${this.g(id)}`));
  roots = (id: string) => call<{ roots: GroupRoot[] }>(this.f, this.u(`/groups/${this.g(id)}/roots`));
  async snapshot(id: string, epoch?: string): Promise<Uint8Array> {
    const r = await call<{ epoch: string; snapshot: string }>(this.f, this.u(`/groups/${this.g(id)}/snapshot${epoch ? `?epoch=${encodeURIComponent(epoch)}` : ""}`));
    return fromB64u(r.snapshot);
  }
}
