/**
 * Scout, a scripted AI agent (no model): its birth, its fixed work script, and the principal's rotations.
 * Every witness call goes over HTTP.
 */
import { canonicalJson, signDocument } from "@toip-tools/trust-core";
import { Controller, digest, endorse, keyQb64, toStream, type SignedMessage } from "@toip-tools/eventlog";
import type { World } from "./world";

export const MANDATE = {
  type: "agent/mandate",
  id: "mandate-ada-0042",
  scope: ["supplies/quote", "supplies/order"],
  limit: "500.00 USDC",
  approvalOver: "250.00 USDC",
};

/** Ada's policy, which her watcher applies to Scout's trail headers: every tool call cites the mandate it runs under. */
export const POLICY = "Every tool call must cite the mandate it runs under (entry 1).";

/** Step 1: Scout's AID, with three witnesses (two must receipt), Ada's rotation key in `n`, and its DID binding. */
export async function birth(world: World): Promise<Controller> {
  const ws = world.state.scoutWitnesses.map((n) => world.witness(n).aid);
  const scout = await Controller.incept({
    hot: [world.scoutKey(0)],
    cold: world.scoutCold,
    extraNext: world.adaCold.commit(world.state.adaKeySet, 1),
    nt: 1,
    witnesses: ws,
    bt: 2,
    bind: world.scoutId,
    store: world.scoutStore,
    clock: world.clock,
  });
  const trail = await scout.openTrail("agent/actions");
  const report = await scout.publish(world.scoutClients());
  if (report.missing.length) throw new Error(`witnesses missing: ${report.missing.map((m) => m.error).join("; ")}`);
  world.scout = scout;
  world.state.scout = { aid: scout.aid, trailId: trail.id, keySet: 0 };
  world.adaWatcher.watch(trail.id, scout.aid);
  return scout;
}

export function scoutTrail(world: World) {
  if (!world.scout || !world.state.scout) throw new Error("Scout isn't born yet");
  return world.scout.trail(world.state.scout.trailId);
}

/** Step 2: the fixed script. Returns the entries in order. */
export async function work(world: World): Promise<{ entries: SignedMessage[]; checkpoint: SignedMessage; endorsedBy: string }> {
  const t = scoutTrail(world);
  const clients = world.scoutClients();
  const out: SignedMessage[] = [];
  const add = async (kind: string, body: Record<string, unknown>, cite = true) => {
    const refs = cite && out.length ? [t.ref(1)] : [];
    const { entry } = await t.append({ kind, body, refs });
    out.push(entry);
    return entry;
  };
  await add("agent/mandate-accepted", { mandateId: MANDATE.id, mandateDigest: digest(canonicalJson(MANDATE)), limit: MANDATE.limit });
  await add("agent/tool-call", { tool: "catalog.search", argsDigest: digest('{"q":"cedar decking, 40 boards"}'), decision: "allowed: supplies/quote" });
  await add("agent/tool-call", { tool: "quote.request", argsDigest: digest('{"supplier":"Quarry Supply","items":40}'), decision: "allowed: supplies/quote" });
  await add("agent/message-sent", { to: world.supplier.did, type: "supplies/quote-accept", documentDigest: digest("quote Q-118, 340.00 USDC") });
  await add("agent/approval-requested", { what: "pay Quarry Supply 340.00 USDC for quote Q-118", from: world.ada.did, reason: "over 250.00 USDC" });
  const approval = signDocument({ type: "agent/approval", issuer: world.ada.did, quote: "Q-118", amount: "340.00 USDC" }, world.ada, world.clock);
  const granted = await add("agent/approval-granted", { approval });
  await world.scout!.publish(clients);
  // Ada endorses the approval entry: her own signature on it, held by the witnesses and by Scout
  const e = endorse(granted, world.ada, world.clock.iso());
  for (const c of clients) await c.addReceipts(toStream([e]));
  await world.scoutStore.addReceipt(e.logId, e.s, e.d, { by: e.couples![0].signer, kind: "endorsement", raw: e.raw, attachments: toStream([e]).slice(e.raw.length), dt: String(e.body.dt) });
  const { entry: intent } = await t.appendWitnessed(
    { kind: "agent/payment-intent", body: { termsHash: digest("settle terms Q-118"), amount: "340.00", currency: "USDC", payee: world.supplier.did, rail: "settle/solana-devnet" }, refs: [t.ref(1)] },
    clients,
  );
  out.push(intent);
  const checkpoint = await world.scout!.checkpointNow();
  await world.scout!.publish(clients);
  return { entries: out, checkpoint, endorsedBy: e.couples![0].signer };
}

/**
 * Ada rotates Scout's AID with her rotation key alone (a partial rotation). The new current keys are hers and Scout's next key,
 * so Scout keeps working. Returns the rotation.
 */
export async function adaRotates(
  world: World,
  opts: { removeWitnesses?: number[]; addWitnesses?: number[]; cutAfter?: number; supersede?: number },
): Promise<SignedMessage> {
  const st = world.state;
  const aid = st.scout!.aid;
  const ada = await Controller.load(aid, { hot: [], store: world.scoutStore, clock: world.clock });
  const nextScoutSet = st.scout!.keySet + 1;
  const rot = await ada.rotate({
    exposed: [world.adaKey(st.adaKeySet)],
    extraKeys: [keyQb64(world.scoutKey(nextScoutSet))],
    next: [...world.scoutCold.commit(nextScoutSet + 1, 1), ...world.adaCold.commit(st.adaKeySet + 1, 1)],
    nt: 1,
    kt: 1,
    bt: 2,
    removeWitnesses: (opts.removeWitnesses ?? []).map((n) => world.witness(n).aid),
    addWitnesses: (opts.addWitnesses ?? []).map((n) => world.witness(n).aid),
    ...(opts.cutAfter !== undefined ? { cutAfter: { [st.scout!.trailId]: opts.cutAfter } } : {}),
    ...(opts.supersede !== undefined ? { supersede: opts.supersede } : {}),
  });
  st.scoutWitnesses = st.scoutWitnesses.filter((n) => !(opts.removeWitnesses ?? []).includes(n)).concat(opts.addWitnesses ?? []);
  st.adaKeySet += 1;
  st.scout!.keySet = nextScoutSet;
  await ada.publish(world.scoutClients());
  // Scout picks up its new key
  world.scout = await Controller.load(aid, { hot: [world.scoutKey(nextScoutSet)], store: world.scoutStore, clock: world.clock });
  return rot;
}
