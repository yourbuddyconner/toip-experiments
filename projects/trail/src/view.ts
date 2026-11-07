/**
 * What the explorer shows: a bundle verified with the library, turned into rows, checks and explanations.
 * Browser-safe; the explorer runs it in the page, and the tests and the CLI demo run the same code.
 */
import {
  aidDid,
  bindingDigest,
  fromStream,
  retiredAt,
  verifyBundle,
  verifyEvidence,
  type Bundle,
  type BundleResult,
  type DuplicityEvidence,
  type KelResult,
  type Problem,
  type SignedMessage,
  type TrailEntry,
  type TrailResult,
  type WitnessClient,
} from "@zk-toip/eventlog";
import { explainProblem, short, STATUS_TEXT } from "./explain";

export type CheckResult = "pass" | "fail" | "warn" | "info";
export interface Check {
  label: string;
  result: CheckResult;
  detail: string;
}

export interface ProblemView extends Problem {
  explanation: string;
}

export interface Named {
  id: string;
  name: string;
}

export interface EntryView {
  s: number;
  d: string;
  t: string;
  kind: string;
  dt: string;
  status: TrailEntry["status"] | "rejected";
  chip: string;
  epoch: number;
  receipts: (Named & { dt: string })[];
  bt: number;
  witnessCount: number;
  earliestReceipt?: string;
  anchoredBy?: number;
  cutBy?: number;
  endorsements: (Named & { dt: string })[];
  raw: string;
  body?: { json: Record<string, unknown>; ok: boolean };
  duplicity: boolean;
  flags: string[];
  checks: Check[];
  explanation: string;
}

export interface KeyStateView {
  estSn: number;
  estSaid: string;
  keys: Named[];
  kt: number;
  nt: number;
  next: string[];
  bt: number;
  witnesses: Named[];
  retiredAt?: number;
  current: boolean;
}

export interface KelEventView {
  s: number;
  t: string;
  d: string;
  status: string;
  receipts: (Named & { dt?: string })[];
  notes: string[];
  supersededBy?: string;
  raw: string;
}

export interface EvidenceView {
  kind: "controller" | "witness";
  logId: string;
  s: number;
  witness?: Named;
  detectedBy: string;
  detectedAt: string;
  a: { t: string; d: string; raw: string; sig: string };
  b: { t: string; d: string; raw: string; sig: string };
  diff: { field: string; a: string; b: string }[];
  verified: boolean;
  explanation: string;
}

export interface TrailView {
  id: string;
  purpose: string;
  ok: boolean;
  closed: boolean;
  head?: { s: number; d: string };
  entries: EntryView[];
  problems: ProblemView[];
  evidence: EvidenceView[];
}

export interface IdentifierView {
  aid: string;
  label: string;
  didKeri: string;
  ok: boolean;
  witnessChecked: boolean;
  bindings: { did: string; ok: boolean; sealedAt?: number }[];
  kel: KelEventView[];
  states: KeyStateView[];
  kelOk: boolean;
  trails: TrailView[];
  problems: ProblemView[];
  evidence: EvidenceView[];
}

export interface ViewOptions {
  names?: Record<string, string>;
  label?: string;
  /** Compare heads with these witnesses (makes the result "witness-checked"). */
  witnesses?: WitnessClient[];
  /** Evidence held by watchers and witnesses, to show beside the bundle's own. */
  evidence?: DuplicityEvidence[];
}

const hex = (n: number) => n.toString(16);
const named = (names: Record<string, string>, id: string): Named => ({ id, name: names[id] ?? short(id, 10) });
const problemView = (p: Problem): ProblemView => ({ ...p, explanation: explainProblem(p.code) });
const sigText = (m: SignedMessage) => {
  const parts: string[] = [];
  if (m.keyRefSig) parts.push(`-F key state ${m.keyRefSig.estSn}, ${m.keyRefSig.sigs.length} signature(s)`);
  if (m.couples?.length) parts.push(`signed by ${m.couples.map((c) => short(c.signer, 10)).join(", ")}`);
  if (m.controllerSigs?.length) parts.push(`${m.controllerSigs.length} controller signature(s)`);
  if (m.witnessSigs?.length) parts.push(`${m.witnessSigs.length} witness signature(s)`);
  return parts.join("; ");
};

/** The fields where two versions of a message differ. */
export function diffBodies(a: Record<string, unknown>, b: Record<string, unknown>): { field: string; a: string; b: string }[] {
  const out: { field: string; a: string; b: string }[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = JSON.stringify(a[k] ?? null);
    const y = JSON.stringify(b[k] ?? null);
    if (x !== y) out.push({ field: k, a: x, b: y });
  }
  return out;
}

async function evidenceView(e: DuplicityEvidence, kel: KelResult | undefined, names: Record<string, string>): Promise<EvidenceView> {
  const verified = kel ? await verifyEvidence(e, kel) : false;
  const what = e.kind === "controller" ? `${names[kel?.aid ?? ""] ?? "The controller"} signed two different versions of entry ${e.s}.` : `${names[e.witness ?? ""] ?? "A witness"} receipted two different versions of entry ${e.s}.`;
  const a = e.kind === "witness" && e.a.t === "trc" ? { ...e.a } : e.a;
  const b = e.kind === "witness" && e.b.t === "trc" ? { ...e.b } : e.b;
  return {
    kind: e.kind,
    logId: e.logId,
    s: e.s,
    ...(e.witness ? { witness: named(names, e.witness) } : {}),
    detectedBy: e.detectedBy,
    detectedAt: e.detectedAt,
    a: { t: a.t, d: a.d, raw: a.raw, sig: sigText(a) },
    b: { t: b.t, d: b.d, raw: b.raw, sig: sigText(b) },
    diff: e.kind === "witness" ? [{ field: "d (the version receipted)", a: a.d, b: b.d }] : diffBodies(a.body, b.body),
    verified,
    explanation: `${what} ${verified ? "The signatures check out against the KEL: this proves itself, with no need to trust whoever reported it." : "The signatures could not be checked against this KEL."}`,
  };
}

const evKey = (e: DuplicityEvidence) => `${e.kind}|${e.logId}|${e.s}|${e.witness ?? ""}|${[e.a.d, e.b.d].sort().join(",")}`;

/** Ada's policy, applied to headers only: every tool call cites the mandate it runs under. */
export function policyFlags(t: TrailResult): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (t.purpose !== "agent/actions") return out;
  const mandate = t.entries.find((e) => e.kind === "agent/mandate-accepted" && e.status !== "cut");
  for (const e of t.entries) {
    if (e.kind !== "agent/tool-call") continue;
    const cites = mandate && e.x.some((x) => "i" in x && x.i === t.trailId && x.s === hex(mandate.s) && x.d === mandate.d);
    if (!cites) out.set(e.d, [`Ada's policy: this tool call doesn't cite the mandate (entry ${mandate?.s ?? 1}).`]);
  }
  return out;
}

function kelNotes(m: SignedMessage, names: Record<string, string>, bindings: Set<string>): string[] {
  const notes: string[] = [];
  const b = m.body as Record<string, unknown>;
  if (m.t === "rot") {
    for (const w of (b.br as string[]) ?? []) notes.push(`removes ${names[w] ?? short(w)}`);
    for (const w of (b.ba as string[]) ?? []) notes.push(`adds ${names[w] ?? short(w)}`);
  }
  for (const a of (b.a as Record<string, unknown>[]) ?? []) {
    if (typeof a.i === "string" && typeof a.s === "string" && typeof a.d === "string") notes.push(`seals trail ${short(a.i)} at entry ${parseInt(a.s, 16)}`);
    else if (typeof a.d === "string" && Object.keys(a).length === 1) notes.push(bindings.has(a.d) ? "seals the DID binding" : `seals document ${short(a.d)}`);
    else notes.push(`data: ${Object.entries(a).map(([k, v]) => `${k}=${String(v)}`).join(", ")}`);
  }
  return notes;
}

function entryChecks(e: TrailEntry, t: TrailResult, kel: KelResult, problems: Problem[], dup: boolean, flags: string[], names: Record<string, string>): Check[] {
  const st = kel.states.find((x) => x.estSn === e.keyState.estSn);
  const checks: Check[] = [];
  checks.push({ label: "Header hash", result: "pass", detail: "The SAID is the hash of the header's bytes." });
  checks.push({ label: "Signature", result: "pass", detail: `Signed with the keys of key state ${e.keyState.estSn} (the ${e.keyState.estSn === 0 ? "inception" : "rotation"} at KEL ${e.keyState.estSn}), meeting its threshold of ${st?.kt ?? "?"}.` });
  checks.push({ label: "Chain", result: "pass", detail: e.s === 0 ? "The trail's inception." : `Names entry ${e.s - 1} as its prior.` });
  if (e.status === "cut") {
    const seal = kel.messages[e.cutBy!]?.body.a as { i?: string; s?: string }[] | undefined;
    const h = seal?.find((x) => x.i === t.trailId)?.s;
    checks.push({ label: "Key epoch", result: "fail", detail: `Key state ${e.keyState.estSn} was retired by the rotation at KEL ${e.cutBy}, which sealed this trail at entry ${h ? parseInt(h, 16) : "?"}. This entry comes after that seal: cut by recovery.` });
  } else {
    const r = retiredAt(kel, e.keyState.estSn);
    checks.push({ label: "Key epoch", result: "pass", detail: r === null ? `Key state ${e.keyState.estSn} is current.` : `Key state ${e.keyState.estSn} was retired at KEL ${r}, after this entry was sealed.` });
  }
  const need = st?.bt ?? 0;
  const n = e.receipts.length;
  const who = e.receipts.map((r) => `${names[r.witness] ?? short(r.witness)} at ${r.dt.slice(11, 23)}`).join(", ");
  checks.push(
    n >= need
      ? { label: "Witnesses", result: "pass", detail: `${n} of ${st?.witnesses.length ?? n} witnesses receipted it (${need} needed)${who ? `: ${who}` : ""}.` }
      : { label: "Witnesses", result: "warn", detail: `Only ${n} of the ${need} receipts needed${who ? `: ${who}` : ""}.` },
  );
  checks.push({
    label: "Time",
    result: "info",
    detail: e.earliestReceipt ? `The controller says ${e.dt}. The first witness saw it at ${e.earliestReceipt}, so it existed by then.` : `The controller says ${e.dt}. No witness time yet.`,
  });
  checks.push(
    e.anchoredBy !== undefined
      ? { label: "Anchored", result: "pass", detail: `Sealed into the KEL at event ${e.anchoredBy} (directly, or through a later entry).` }
      : { label: "Anchored", result: "info", detail: "Not yet sealed by a checkpoint or rotation." },
  );
  if (e.t === "ten" && e.a) {
    checks.push(
      e.body ? (e.body.ok ? { label: "Body", result: "pass", detail: "The disclosed body hashes to the header's digest." } : { label: "Body", result: "fail", detail: explainProblem("bodyMismatch") }) : { label: "Body", result: "info", detail: "The body was not disclosed. Witnesses never see bodies." },
    );
  }
  for (const en of e.endorsements) checks.push({ label: "Endorsed", result: "pass", detail: `${names[en.signer] ?? short(en.signer)} signed this entry at ${en.dt}.` });
  checks.push(dup ? { label: "Duplicity", result: "fail", detail: `Another signed version of entry ${e.s} exists. See the evidence.` } : { label: "Duplicity", result: "pass", detail: "No other version of this entry has been seen." });
  for (const f of flags) checks.push({ label: "Policy", result: "warn", detail: f });
  for (const p of problems) checks.push({ label: p.code, result: "fail", detail: `${p.message}. ${explainProblem(p.code)}` });
  return checks;
}

function chipOf(status: EntryView["status"], n: number, total: number): string {
  if (status === "valid") return `valid ${n}/${total}`;
  if (status === "pending") return `pending ${n}/${total}`;
  return status;
}

/** Verifies a bundle and builds the explorer's view of it. */
export async function buildView(bundle: Bundle, opts: ViewOptions = {}): Promise<{ view: IdentifierView; result: BundleResult }> {
  const names = { ...(opts.names ?? {}) };
  const result = await verifyBundle(bundle, { ...(opts.witnesses ? { witnesses: opts.witnesses } : {}) });
  const kel = result.kel;
  const bindingDigests = new Set(bundle.bindings.map((b) => bindingDigest(b)));
  const kelMsgs = fromStream(bundle.kel).messages.filter((m) => m.t === "icp" || m.t === "rot" || m.t === "ixn");
  const rawOf = new Map(kelMsgs.map((m) => [m.d, m]));
  const timeOf = new Map(kel.events.map((ev) => [ev.d, new Map(ev.receiptTimes.map((r) => [r.witness, r.dt]))]));
  const kelView: KelEventView[] = kel.events.map((ev) => {
    const m = rawOf.get(ev.d);
    const sup = kel.superseded.find((x) => x.d === ev.d);
    return {
      s: ev.s,
      t: ev.t,
      d: ev.d,
      status: ev.status,
      receipts: ev.receipts.map((w) => ({ ...named(names, w), ...(timeOf.get(ev.d)?.get(w) ? { dt: timeOf.get(ev.d)!.get(w) } : {}) })),
      notes: m ? kelNotes(m, names, bindingDigests) : [],
      ...(sup ? { supersededBy: sup.by } : {}),
      raw: m?.raw ?? "",
    };
  });
  const states: KeyStateView[] = kel.states.map((st) => {
    const r = retiredAt(kel, st.estSn);
    return {
      estSn: st.estSn,
      estSaid: st.estSaid,
      keys: st.keys.map((k) => named(names, k)),
      kt: st.kt,
      nt: st.nt,
      next: st.next,
      bt: st.bt,
      witnesses: st.witnesses.map((w) => named(names, w)),
      ...(r !== null ? { retiredAt: r } : {}),
      current: r === null,
    };
  });

  // evidence: the bundle's own, then what watchers and witnesses hold
  const all = new Map<string, DuplicityEvidence>();
  for (const e of [...kel.evidence, ...result.trails.flatMap((t) => t.evidence), ...(opts.evidence ?? [])]) {
    if (e.logId !== kel.aid && !result.trails.some((t) => t.trailId === e.logId)) continue;
    if (!all.has(evKey(e))) all.set(evKey(e), e);
  }
  const evidence = await Promise.all([...all.values()].map((e) => evidenceView(e, kel, names)));

  const trails: TrailView[] = [];
  for (let i = 0; i < result.trails.length; i++) {
    const t = result.trails[i];
    const bodies = new Map((bundle.trails[i]?.bodies ?? []).map((b) => [b.d, b]));
    const msgs = fromStream(bundle.trails[i]?.stream ?? "").messages.filter((m) => m.t !== "trc");
    const raw = new Map(msgs.map((m) => [m.d, m.raw]));
    const flagged = policyFlags(t);
    const tEvidence = evidence.filter((e) => e.logId === t.trailId);
    const entries: EntryView[] = t.entries.map((e) => {
      const st = kel.states.find((x) => x.estSn === e.keyState.estSn);
      const dup = e.status !== "cut" && tEvidence.some((x) => x.s === e.s && (x.a.d === e.d || x.b.d === e.d));
      const flags = e.status === "cut" ? [] : (flagged.get(e.d) ?? []);
      const problems = t.problems.filter((p) => p.s === e.s && p.code !== "duplicity" && !(p.code === "notWitnessed" && e.status === "cut"));
      const body = e.a ? bodies.get(e.a) : undefined;
      return {
        s: e.s,
        d: e.d,
        t: e.t,
        kind: e.t === "tin" ? `trail opened: ${t.purpose}` : e.t === "tcl" ? "trail closed" : e.kind || "(kind hidden)",
        dt: e.dt,
        status: e.status,
        chip: chipOf(e.status, e.receipts.length, st?.witnesses.length ?? e.receipts.length),
        epoch: e.keyState.estSn,
        receipts: e.receipts.map((r) => ({ ...named(names, r.witness), dt: r.dt })),
        bt: st?.bt ?? 0,
        witnessCount: st?.witnesses.length ?? 0,
        ...(e.earliestReceipt ? { earliestReceipt: e.earliestReceipt } : {}),
        ...(e.anchoredBy !== undefined ? { anchoredBy: e.anchoredBy } : {}),
        ...(e.cutBy !== undefined ? { cutBy: e.cutBy } : {}),
        endorsements: e.endorsements.map((x) => ({ ...named(names, x.signer), dt: x.dt })),
        raw: raw.get(e.d) ?? "",
        ...(body ? { body: { json: body as Record<string, unknown>, ok: e.body?.ok ?? false } } : {}),
        duplicity: dup,
        flags,
        checks: entryChecks(e, t, kel, problems, dup, flags, names),
        explanation: e.status === "cut" ? `${STATUS_TEXT.cut} Cut by the recovery at KEL ${e.cutBy}.` : STATUS_TEXT[e.status],
      };
    });
    // messages in the stream that didn't make it into the trail, and problems at places with no entry
    const shown = new Set(entries.map((e) => e.d));
    for (const m of msgs) {
      if (shown.has(m.d) || m.t === "rct") continue;
      const problems = t.problems.filter((p) => p.s === m.s);
      entries.push(rejected(m.s, m.d, m.t, String(m.body.k ?? ""), String(m.body.dt ?? ""), m.raw, problems));
      shown.add(m.d);
    }
    for (const p of t.problems) {
      if (p.s === undefined || entries.some((e) => e.s === p.s) || p.code === "truncated") continue;
      entries.push(rejected(p.s, "", "?", "", "", "", t.problems.filter((x) => x.s === p.s)));
    }
    entries.sort((a, b) => a.s - b.s || order(a) - order(b));
    trails.push({
      id: t.trailId,
      purpose: t.purpose,
      ok: t.ok,
      closed: t.closed,
      ...(t.head ? { head: t.head } : {}),
      entries,
      problems: t.problems.map(problemView),
      evidence: tEvidence,
    });
  }

  const view: IdentifierView = {
    aid: kel.aid,
    label: opts.label ?? names[kel.aid] ?? short(kel.aid, 10),
    didKeri: kel.aid ? aidDid(kel.aid) : "",
    ok: result.ok,
    witnessChecked: result.witnessChecked,
    bindings: result.bindings.map((b) => ({ did: b.did, ok: b.ok, ...(b.sealedAt !== undefined ? { sealedAt: b.sealedAt } : {}) })),
    kel: kelView,
    states,
    kelOk: kel.ok,
    trails,
    problems: result.problems.map(problemView),
    evidence,
  };
  return { view, result };
}

const order = (e: EntryView) => ({ valid: 0, pending: 1, invalid: 2, cut: 3, rejected: 4 })[e.status];

function rejected(s: number, d: string, t: string, kind: string, dt: string, raw: string, problems: Problem[]): EntryView {
  return {
    s,
    d,
    t,
    kind: kind || "(unreadable)",
    dt,
    status: "rejected",
    chip: problems[0]?.code ?? "rejected",
    epoch: -1,
    receipts: [],
    bt: 0,
    witnessCount: 0,
    endorsements: [],
    raw,
    duplicity: false,
    flags: [],
    checks: problems.length ? problems.map((p) => ({ label: p.code, result: "fail" as const, detail: `${p.message}. ${explainProblem(p.code)}` })) : [{ label: "Read", result: "fail", detail: STATUS_TEXT.rejected }],
    explanation: STATUS_TEXT.rejected,
  };
}
