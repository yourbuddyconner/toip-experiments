import { pack } from "@openvtc/vti-tsp-js";
import { identityFromSeed, resolveDidKey, seedFrom, type Identity } from "@zk-toip/trust-core";
import { regions, type AirtimePolicy, type LoRaSetting } from "../src/airtime";
import { seeded } from "../src/bytes";
import { MeshTransport, type MeshEvent, type MeshOptions } from "../src/mesh";
import { VirtualScheduler } from "../src/scheduler";
import { SimMedium, type SimRadioParams } from "../src/sim";

export const setting = (sf: LoRaSetting["spreadingFactor"] = 8, bw: LoRaSetting["bandwidthHz"] = 500000, frequencyHz = 904_600_000): LoRaSetting => ({
  frequencyHz, spreadingFactor: sf, bandwidthHz: bw, codingRate: 5, preambleSymbols: 8, syncWord: "public", invertIq: false, txPowerDbm: 20,
});

export const ident = (name: string) => identityFromSeed(seedFrom(`mesh-test/${name}`));

/** A sealed Direct TSP message of about `n` body bytes, as an Endpoint would post. */
export async function wireOf(from: Identity, to: string, n: number, fill = 7): Promise<Uint8Array> {
  const body = new Uint8Array(n).fill(fill);
  const keys = { senderSigningKey: from.signingSecret, senderEncryptionKey: from.encryptionSecret, receiverEncryptionKey: resolveDidKey(to).encryptionKey };
  return (await pack(body, from.did, to, keys)).bytes;
}

export interface Node {
  id: Identity;
  mesh: MeshTransport;
  inbox: Uint8Array[];
  events: MeshEvent[];
}

export async function meshWorld(opts: {
  names: string[];
  seed?: number;
  radio?: Partial<SimRadioParams>;
  budget?: AirtimePolicy;
  links?: [string, string, { loss?: number; rssi?: number }?][];
  mesh?: Partial<MeshOptions> | ((name: string) => Partial<MeshOptions>);
}) {
  const sched = new VirtualScheduler();
  const medium = new SimMedium({ scheduler: sched, seed: opts.seed ?? 1 });
  const nodes: Record<string, Node> = {};
  for (const name of opts.names) {
    const link = medium.node(name, { setting: setting(), mtu: 250, budget: opts.budget ?? regions.us915, turnaroundMs: 10, ...opts.radio });
    const id = ident(name);
    const events: MeshEvent[] = [];
    const extra = typeof opts.mesh === "function" ? opts.mesh(name) : opts.mesh;
    const mesh = new MeshTransport({ identities: [id], links: [link], scheduler: sched, random: seeded((opts.seed ?? 1) * 1000 + opts.names.indexOf(name)), onEvent: (e) => events.push(e), ...extra });
    const inbox: Uint8Array[] = [];
    mesh.attach(id.did, async (w) => {
      inbox.push(w);
    });
    nodes[name] = { id, mesh, inbox, events };
  }
  for (const [a, b, q] of opts.links ?? []) medium.connect(a, b, q);
  for (const n of Object.values(nodes)) await n.mesh.start();
  for (const a of Object.values(nodes)) for (const b of Object.values(nodes)) if (a !== b) a.mesh.addContact(b.id.did);
  return { sched, medium, nodes };
}

export const contains = (hay: Uint8Array, needle: Uint8Array) => Buffer.from(hay).indexOf(Buffer.from(needle)) >= 0;
