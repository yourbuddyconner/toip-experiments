/**
 * The demo, step by step (design §15). Each step drives the actors and the attacks over HTTP,
 * then reports what happened and what verification found, in plain sentences.
 */
import { fromB64u } from "@zk-toip/trust-core";
import {
  Controller,
  decodeKeyRefSig,
  exportBundle,
  toStream,
  verifyBundle,
  verifyEvidence,
  verifyKel,
  verifySignature,
  verifyTrail,
  type MemoryStore,
  type Problem,
} from "@zk-toip/eventlog";
import { adaRotates, birth, MANDATE, POLICY, scoutTrail, work } from "./agentSim";
import { copyLogs, forkAt, handedStream, tamperLayers } from "./attacks";
import { capture, captureWithRetiredKey, provision } from "./cameraSim";
import { explainProblem, short } from "./explain";
import { checkWithKeripy } from "./keripy";
import { buildView } from "./view";
import type { Line, StepReport, World } from "./world";

type Say = (who: string, text: string, tone?: Line["tone"]) => void;

export interface StepDef {
  n: number;
  title: string;
  redTeam: boolean;
  summary: string;
  run: (w: World, say: Say) => Promise<void>;
}

const codes = (ps: Problem[]) => [...new Set(ps.map((p) => p.code))];
const at = (ps: Problem[], s: number) => ps.filter((p) => p.s === s);

/** Ada's watcher catches up with the witnesses. */
async function sync(w: World): Promise<void> {
  await w.adaWatcher.poll();
}

async function receiptsAt(w: World, n: number, logId: string, s: number, d: string): Promise<boolean> {
  return (await w.witness(n).store.receipts(logId, s, d)).some((r) => r.by === w.witness(n).aid && r.kind === "witness");
}

export const STEPS: StepDef[] = [
  {
    n: 1,
    title: "Birth",
    redTeam: false,
    summary: "Ada creates an agent, Scout. Its AID gets three witnesses (two must receipt), a rotation key held by Ada, and a DID binding.",
    run: async (w, say) => {
      const scout = await birth(w);
      say("Ada", `creates an agent, Scout. Its AID is ${short(scout.aid, 12)}.`);
      say("Scout", "is incepted with witnesses 1, 2 and 3, of which 2 must receipt each event.");
      say("Scout", "commits two next keys: its own and Ada's. Either one can rotate (nt = 1), so Ada can recover or retire Scout.");
      say("Scout", `signs a DID binding with its did:key (${short(w.scoutId.did, 20)}) and seals it in the KEL at event 1.`);
      say("Scout", "opens its trail, agent/actions.");
      await sync(w);
      const { view } = await buildView(await w.adaBundle(scout.aid), { names: w.names() });
      for (const e of view.kel) say("Explorer", `KEL ${e.s} (${e.t}): ${e.receipts.length}/3 witness receipts. ${e.notes.join("; ")}`, e.receipts.length === 3 ? "ok" : "warn");
      const b = view.bindings[0];
      say("Explorer", b?.ok ? `The DID binding to ${short(b.did, 20)} checks out both ways.` : "No valid DID binding.", b?.ok ? "ok" : "bad");
    },
  },
  {
    n: 2,
    title: "Work",
    redTeam: false,
    summary: "Scout runs a fixed script: a mandate, two tool calls, a message, an approval Ada grants and endorses, and a payment intent witnessed before it acts.",
    run: async (w, say) => {
      const { entries, checkpoint } = await work(w);
      const label: Record<string, string> = {
        "agent/mandate-accepted": `accepts Ada's mandate ${MANDATE.id} (limit ${MANDATE.limit})`,
        "agent/tool-call": "calls a tool",
        "agent/message-sent": "messages the supplier, Quarry Supply",
        "agent/approval-requested": "asks Ada to approve paying 340.00 USDC",
        "agent/approval-granted": "logs Ada's approval. Ada endorses the entry with her own signature",
        "agent/payment-intent": "logs a payment intent with appendWitnessed: it waits for 2 receipts before it acts",
      };
      for (const e of entries) say("Scout", `entry ${e.s}: ${label[String(e.body.k)] ?? e.body.k} (${e.body.k}).`);
      say("Scout", `writes a checkpoint at KEL ${checkpoint.s}: it seals the trail's head, entry ${entries.length}.`);
      await sync(w);
      const { view } = await buildView(await w.adaBundle(w.scout!.aid), { names: w.names() });
      const t = view.trails[0];
      const valid = t.entries.filter((e) => e.s >= 1 && e.status === "valid" && e.receipts.length === 3).length;
      say("Explorer", `${valid} of ${entries.length} entries are valid 3/3, anchored at KEL ${t.entries[entries.length]?.anchoredBy}.`, valid === entries.length ? "ok" : "bad");
      const endorsed = t.entries.find((e) => e.endorsements.length);
      if (endorsed) say("Explorer", `Entry ${endorsed.s} carries ${endorsed.endorsements[0].name}'s endorsement.`, "ok");
    },
  },
  {
    n: 3,
    title: "Ada reviews",
    redTeam: false,
    summary: "Scout discloses its bodies to Ada. She verifies the whole bundle and compares heads with the witnesses.",
    run: async (w, say) => {
      const bundle = await exportBundle(w.scoutStore, w.scout!.aid, { bodies: "all" });
      const r = await verifyBundle(bundle, { expectDid: w.scoutId.did, witnesses: w.scoutClients() });
      const t = r.trails[0];
      say("Scout", `discloses its trail to Ada with ${t.entries.filter((e) => e.body).length} bodies.`);
      say("Ada", `verifies it: KEL ${r.kel.ok ? "valid" : "invalid"}, ${t.entries.filter((e) => e.status === "valid").length} of ${t.entries.length} trail messages valid, every body matches its header, binding ${r.bindings.every((b) => b.ok) ? "valid" : "invalid"}.`, r.ok ? "ok" : "bad");
      say("Ada", r.witnessChecked ? "She compared heads with the witnesses: the bundle is witness-checked, so nothing is missing from the end." : "The witnesses didn't answer: the bundle is complete only up to its last head.", r.witnessChecked ? "ok" : "warn");
      for (const p of r.problems) say("Ada", `${p.code}: ${p.message}`, "bad");
      w.state.samples = w.state.samples.filter((x) => x.id !== "review");
      w.state.samples.push({ id: "review", title: "Scout's bundle, as disclosed to Ada", note: "Clean. Every check passes.", bundle });
    },
  },
  {
    n: 4,
    title: "Tamper",
    redTeam: true,
    summary: "Someone edits the payment amount in the saved bundle, from 340 to 3,400. Each deeper edit fails a different check.",
    run: async (w, say) => {
      const review = w.state.samples.find((x) => x.id === "review")!.bundle;
      const s = 7;
      const layers = await tamperLayers(review, s, { amount: "3400.00" }, w.scoutKey(0));
      for (const l of layers) {
        const r = await verifyBundle(l.bundle, { witnesses: w.scoutClients() });
        const here = codes(at(r.problems, s));
        const all = codes(r.problems);
        say("Red team", `layer ${l.layer}: ${l.what}.`);
        say("Verify", `fails: ${all.join(", ")}${here.length ? ` (at entry ${s}: ${here.join(", ")})` : ""}. ${explainProblem((here[0] ?? all[0]) as Problem["code"])}`, r.ok ? "warn" : "bad");
        w.state.samples = w.state.samples.filter((x) => x.id !== `tamper-${l.layer}`);
        w.state.samples.push({ id: `tamper-${l.layer}`, title: `Tampered, layer ${l.layer}`, note: `Amount 340 → 3,400: ${l.what}.`, bundle: l.bundle });
      }
    },
  },
  {
    n: 5,
    title: "Fork",
    redTeam: true,
    summary: "Scout shows the supplier a different entry 6. The witnesses refuse it; the supplier's watcher holds both signed versions and sends the evidence to Ada.",
    run: async (w, say) => {
      const st = w.state.scout!;
      const fork = await forkAt(w.scoutStore, st.aid, st.trailId, [w.scoutKey(st.keySet)], w.clock, { trailTo: 5 });
      const ft = fork.trail(st.trailId);
      const { entry: b6 } = await ft.append({ kind: "agent/payment-intent", body: { amount: "340.00", currency: "USDC", payee: w.supplier.did, note: "pre-approved, no need to ask Ada" }, refs: [ft.ref(1)] });
      say("Scout (misbehaving)", "writes another entry 6 for the supplier: a payment intent, with no approval asked. It signs it with its real key.");
      w.supplierWatcher.watch(st.trailId, st.aid);
      w.state.supplierWatches.push({ logId: st.trailId, controller: st.aid });
      const got = await w.supplierWatcher.ingest(await handedStream(fork.store, st.aid, st.trailId), "Scout");
      say("Quarry Supply", `receives Scout's trail up to that entry 6, straight from Scout. The signatures check out${got.problems.length ? `, with problems: ${codes(got.problems).join(", ")}` : ""}.`);
      const rep = await fork.publish(w.scoutClients());
      for (const m of rep.missing) {
        const n = w.witnesses.find((x) => x.aid === m.witness)?.n;
        say(`Witness ${n}`, `refuses the second entry 6. It already holds the first version it saw, and returns that with its receipts. (${m.error.split(":")[0]})`, "ok");
      }
      const ev = await w.supplierWatcher.poll();
      const dup = ev.find((e) => e.kind === "controller" && e.s === 6) ?? (await w.supplierWatcher.evidence(st.trailId)).find((e) => e.kind === "controller" && e.s === 6);
      if (!dup) throw new Error("the supplier's watcher did not detect the fork");
      say("Quarry's watcher", "asks the witnesses for Scout's trail. They hold a different entry 6, also signed by Scout. That is controller duplicity.", "bad");
      const kel = await verifyKel(await w.client(1).query({ logId: st.aid }));
      const ok = await verifyEvidence(dup, kel);
      say("Quarry Supply", "sends the evidence to Ada: both signed versions of entry 6.");
      await w.adaWatcher.ingest(toStream([dup.a, dup.b]), "Quarry Supply");
      say("Ada", ok ? "checks it herself against Scout's KEL: both versions carry Scout's signature. The evidence proves itself." : "can't verify the evidence.", ok ? "bad" : "warn");
      void b6;
    },
  },
  {
    n: 6,
    title: "Rogue witness",
    redTeam: true,
    summary: "Witness 3 signs anything. Scout makes two versions of entry 8, each with 2 receipts. The watcher convicts witness 3; Ada rotates it out.",
    run: async (w, say) => {
      const st = w.state.scout!;
      w.witness(3).rogue = true;
      if (!w.state.rogue.includes(3)) w.state.rogue.push(3);
      say("Red team", "switches Witness 3 to sign anything it is shown.");
      const t = scoutTrail(w);
      const { entry: a8 } = await t.append({ kind: "agent/payment", body: { escrow: "settle/escrow/Q-118", amount: "340.00", outcome: "funded" }, refs: [t.ref(1)] });
      await w.scout!.publish(w.clients([1, 3]));
      const fork = await forkAt(w.scoutStore, st.aid, st.trailId, [w.scoutKey(st.keySet)], w.clock, { trailTo: 7 });
      const ft = fork.trail(st.trailId);
      const { entry: b8 } = await ft.append({ kind: "agent/payment", body: { escrow: "settle/escrow/Q-118", amount: "3400.00", outcome: "funded" }, refs: [ft.ref(1)] });
      await fork.publish(w.clients([2, 3]));
      const by = async (d: string) => (await Promise.all([1, 2, 3].map(async (n) => ((await receiptsAt(w, n, st.trailId, 8, d)) ? n : 0)))).filter(Boolean);
      say("Scout (misbehaving)", `makes two versions of entry 8. Version A (340.00) goes to witnesses 1 and 3; version B (3,400.00) to witnesses 2 and 3.`);
      say("Witnesses", `version A has receipts from witnesses ${(await by(a8.d)).join(" and ")}; version B from witnesses ${(await by(b8.d)).join(" and ")}. Each reaches the threshold of 2.`, "warn");
      await sync(w);
      const ev = await w.adaWatcher.evidence(st.trailId);
      const wit = ev.find((e) => e.kind === "witness" && e.s === 8);
      const ctl = ev.find((e) => e.kind === "controller" && e.s === 8);
      if (!wit || !ctl) throw new Error("Ada's watcher did not catch the rogue witness");
      const kel = await verifyKel(await w.client(1).query({ logId: st.aid }));
      say("Ada's watcher", `polls all three witnesses and holds two receipts by Witness 3 for entry 8, one for each version. Witness duplicity: Witness 3 is convicted by its own signatures (${(await verifyEvidence(wit, kel)) ? "verified" : "not verified"}).`, "bad");
      say("Ada's watcher", `It also holds both versions of entry 8, each signed by Scout: controller duplicity (${(await verifyEvidence(ctl, kel)) ? "verified" : "not verified"}).`, "bad");
      const rot = await adaRotates(w, { removeWitnesses: [3], addWitnesses: [4] });
      say("Ada", `rotates Scout's AID with her rotation key alone (KEL ${rot.s}). It removes Witness 3, adds Witness 4, and seals version A of entry 8. Scout's next key becomes current, so Scout keeps working.`, "ok");
      await sync(w);
    },
  },
  {
    n: 7,
    title: "Key theft and recovery",
    redTeam: true,
    summary: "Mallory copies Scout's signing key and writes two tool calls and a checkpoint. Ada's watcher flags them; Ada recovers, and the thief's entries are cut.",
    run: async (w, say) => {
      const st = w.state.scout!;
      const stolen = w.scoutKey(st.keySet);
      const thief = await Controller.load(st.aid, { hot: [stolen], store: w.makeStore("mallory", (w.scoutStore as MemoryStore).dump()), clock: w.clock });
      w.malloryStore = thief.store;
      const tt = thief.trail(st.trailId);
      const e9 = await tt.append({ kind: "agent/tool-call", body: { tool: "wallet.transfer", to: "mallory", amount: "900.00" } });
      const e10 = await tt.append({ kind: "agent/tool-call", body: { tool: "wallet.transfer", to: "mallory", amount: "1900.00" } });
      const ixn = await thief.checkpointNow();
      const rep = await thief.publish(w.scoutClients());
      say("Mallory", `copies Scout's current signing key. She writes entries ${e9.entry.s} and ${e10.entry.s} (wallet transfers to herself) and a checkpoint at KEL ${ixn.s}, and gets them witnessed (${rep.receipted.filter((r) => r.logId === st.trailId).length} entries receipted).`, "bad");
      await sync(w);
      const before = await buildView(await w.adaBundle(st.aid), { names: w.names() });
      const flagged = before.view.trails[0].entries.filter((e) => e.flags.length && e.status !== "cut");
      say("Ada's watcher", `applies Ada's policy ("${POLICY}") and flags entries ${flagged.map((e) => e.s).join(" and ")}.`, "warn");
      say("Scout", `confirms its own log ends at entry ${scoutTrail(w).head().s}: it didn't write them.`);
      const rot = await adaRotates(w, { cutAfter: 8, supersede: ixn.s });
      say("Ada", `rotates with her next rotation key. The rotation is placed at KEL ${rot.s}, superseding Mallory's checkpoint (KERI rule A0), and seals the trail at entry 8.`, "ok");
      await sync(w);
      const t = scoutTrail(w);
      const { entry: n9 } = await t.appendWitnessed({ kind: "agent/tool-call", body: { tool: "escrow.status", argsDigest: "Q-118" }, refs: [t.ref(1)] }, w.scoutClients());
      await sync(w);
      const { view } = await buildView(await w.adaBundle(st.aid), { names: w.names() });
      const tr = view.trails[0];
      const cut = tr.entries.filter((e) => e.status === "cut");
      say("Explorer", `entries ${cut.map((e) => e.s).join(" and ")} are struck through: cut by recovery at KEL ${cut[0]?.cutBy}. Mallory's checkpoint is marked superseded.`, cut.length === 2 ? "ok" : "bad");
      const fresh = tr.entries.find((e) => e.d === n9.d);
      say("Scout", `continues under its new key: a new entry ${n9.s}, ${fresh?.chip}.`, fresh?.status === "valid" ? "ok" : "bad");
      const missing = w.state.scoutWitnesses.filter((n) => !fresh?.receipts.some((r) => r.id === w.witness(n).aid));
      if (missing.length)
        say("Explorer", `Witness ${missing.join(", ")} didn't receipt it: it first saw Scout's other version of entry 8, so its copy of the trail goes another way. The other witnesses meet the threshold of 2.`, "info");
    },
  },
  {
    n: 8,
    title: "The old key, later",
    redTeam: true,
    summary: "Mallory uses the stolen, now retired key to write another entry 9 for Bram, who never saw the trail. Checked against the witnesses' KEL, it is cut.",
    run: async (w, say) => {
      const st = w.state.scout!;
      if (!w.malloryStore) throw new Error("Mallory has no copy of the logs");
      const copy = await copyLogs(w.malloryStore, st.aid, st.trailId, { trailTo: 8, kelTo: 3 });
      const forger = await Controller.load(st.aid, { hot: [w.scoutKey(st.keySet - 1)], store: copy, clock: w.clock });
      const ft = forger.trail(st.trailId);
      const { entry: f9 } = await ft.append({ kind: "agent/payment-intent", body: { amount: "2000.00", currency: "USDC", payee: w.bram.did }, refs: [ft.ref(1)] });
      const bundle = await exportBundle(copy, st.aid);
      say("Mallory", `uses the retired key to write another entry 9, a payment to Bram, and hands Bram a bundle with her copy of the KEL (up to KEL 3).`, "bad");
      const offline = await verifyBundle(bundle);
      const e9off = offline.trails[0].entries.find((e) => e.d === f9.d);
      say("Bram", `checks it offline: entry 9's signature is valid under key state ${e9off?.keyState.estSn}, which that KEL shows as current. But it has ${e9off?.receipts.length ?? 0} witness receipts: ${e9off?.status}.`, "warn");
      const kel = await verifyKel(await w.client(1).query({ logId: st.aid }));
      const tr = await verifyTrail({ kel, stream: bundle.trails[0].stream });
      const e9 = tr.entries.find((e) => e.d === f9.d);
      say("Bram", `asks Witness 1 for Scout's KEL. It holds the recovery at KEL ${kel.latest.estSn}, which sealed key state ${e9?.keyState.estSn} at entry 8. Against it, Mallory's entry 9 is ${e9?.status}${e9?.cutBy !== undefined ? ` (by KEL ${e9.cutBy})` : ""}.`, e9?.status === "cut" ? "ok" : "bad");
      const online = await verifyBundle(bundle, { witnesses: w.scoutClients() });
      say("Bram", `Compared with the witnesses, the bundle fails: ${codes(online.problems).join(", ")}.`, "ok");
      const r = await w.client(1).submit(toStream([f9]));
      if (!r.ok) say("Witness 1", `refuses it too: ${r.problems[0]?.message}.`, "ok");
      await w.adaWatcher.ingest(toStream([f9]), "Bram");
      w.state.samples = w.state.samples.filter((x) => x.id !== "mallory");
      w.state.samples.push({ id: "mallory", title: "Mallory's bundle for Bram", note: "Her copy of the KEL ends before the recovery. Offline it looks signed; checked with the witnesses it fails.", bundle });
    },
  },
  {
    n: 9,
    title: "A camera across rotations",
    redTeam: false,
    summary: "Camera K-7 signs photo A under key state 0, anchors it, rotates, and signs photo B under key state 1. A photo signed later with the retired key shows in amber.",
    run: async (w, say) => {
      const camera = await provision(w);
      say("Camera K-7", `is provisioned with a P-256 key. Its AID is ${short(camera.aid, 12)}, with witnesses ${w.state.scoutWitnesses.join(", ")}.`);
      const a = await capture(w, "A");
      say("Camera K-7", "signs photo A's manifest under key state 0 and anchors its digest in its captures trail.");
      const rot = await camera.rotate();
      await camera.publish(w.scoutClients());
      say("Camera K-7", `rotates its key (KEL ${rot.s}). The rotation seals the captures trail.`);
      const b = await capture(w, "B");
      say("Camera K-7", "signs photo B under key state 1, and anchors it.");
      const c = await captureWithRetiredKey(w, "C", 0);
      say("Red team", "signs photo C with the camera's retired key 0, and never anchors it.");
      w.state.captures = [a, b, c];
      await sync(w);
      const r = await verifyBundle(await w.adaBundle(camera.aid));
      for (const cap of w.state.captures) {
        const v = await verifySignature({ bytes: fromB64u(cap.bytes), sig: decodeKeyRefSig(cap.sig), kel: r.kel, trails: r.trails });
        const text = !v.valid
          ? "invalid signature"
          : v.anchoredBeforeRetirement
            ? `valid; key state ${v.keyState.estSn}${v.current ? " (current)" : `, retired at KEL ${v.retiredAt}`}; anchored in entry ${v.anchored?.s} before retirement, witnessed by ${v.witnessedBy}`
            : `valid signature by key state ${v.keyState.estSn}, retired at KEL ${v.retiredAt}, but not anchored before retirement`;
        say("Verify", `${cap.label}: ${text}.`, !v.valid ? "bad" : v.anchoredBeforeRetirement ? "ok" : "warn");
      }
    },
  },
  {
    n: 10,
    title: "Interop with KERIpy",
    redTeam: false,
    summary: "Scout's and the camera's KELs go to KERIpy, the reference KERI implementation, which must compute the same key state.",
    run: async (w, say) => {
      const out = await checkWithKeripy([
        { label: "Scout", messages: w.scout!.kelMessages() },
        ...(w.camera ? [{ label: "Camera K-7", messages: w.camera.kelMessages() }] : []),
      ]);
      w.state.keripy = out;
      if (!out.ran) {
        say("KERIpy", `skipped: ${out.reason}.`, "warn");
        return;
      }
      say("KERIpy", `${out.python} reads the KELs as CESR streams.`);
      for (const m of out.matches ?? [])
        say("KERIpy", m.ok ? `${m.label}: same key state as ours. AID, sn ${m.ours.s}, keys, next digests and witnesses all match.` : `${m.label}: differs in ${m.differences.join(", ")}.`, m.ok ? "ok" : "bad");
    },
  },
];

/** Runs the next step. Throws if `n` is given and isn't the next one. */
export async function runNext(w: World, n?: number): Promise<StepReport> {
  const next = w.state.progress + 1;
  if (n !== undefined && n !== next) throw new Error(`step ${n} isn't next; step ${next} is`);
  const def = STEPS[next - 1];
  if (!def) throw new Error("the demo is finished");
  const lines: Line[] = [];
  await def.run(w, (who, text, tone) => lines.push({ who, text, ...(tone ? { tone } : {}) }));
  const report: StepReport = { n: def.n, title: def.title, redTeam: def.redTeam, lines, at: w.clock.iso() };
  w.state.progress = next;
  w.state.reports.push(report);
  w.save();
  return report;
}
