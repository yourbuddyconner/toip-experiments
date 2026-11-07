/**
 * A sensor's identity on disk (key class S): a key file (mode 0600), its key log, and its reading chain.
 * Enrollment asks the owner for the recovery key's digest and the witnesses, then incepts and publishes.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seedSigner } from "@toip-tools/cose";
import { Controller, ed25519Signer, httpWitnessClient, type WitnessClient } from "@toip-tools/eventlog";
import { JsonFileStore } from "@toip-tools/eventlog/node";
import { identityFromSeed, type Clock } from "@toip-tools/trust-core";
import { b64, deviceDid, devTag, fromB64, fromHex, freshChain, hex, kidOf, ReadingChain, utf8, type ChainState } from "../core";

export interface Enrollment {
  nonce: string;
  next: string;
  witnesses: { aid: string; url: string }[];
  bt: number;
}

export interface SensorIdentity {
  name: string;
  aid: string;
  did: string;
  controller: Controller;
  chain: ReadingChain;
  witnessClients: WitnessClient[];
  save(): void;
}

interface ChainFile {
  state: { dev: string; seq: number; lastHash: string; firstUnsealed: number };
  sent: [number, string][];
  seals: [number, number, string][];
}

function writeAtomic(path: string, text: string, mode?: number) {
  writeFileSync(`${path}.tmp`, text, mode ? { mode } : undefined);
  renameSync(`${path}.tmp`, path);
}

export async function openSensor(o: {
  dir: string;
  name: string;
  clock: Clock;
  enroll: () => Promise<Enrollment>;
  /** Called once the key log is published, so the owner can issue credentials. */
  registered: (aid: string) => Promise<void>;
  log?: (s: string) => void;
}): Promise<SensorIdentity> {
  mkdirSync(o.dir, { recursive: true });
  const keyPath = join(o.dir, "key.json");
  if (!existsSync(keyPath)) {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    writeAtomic(keyPath, JSON.stringify({ seed: hex(seed), note: "This sensor's capture key. Anyone with this file can sign as the sensor." }), 0o600);
  }
  chmodSync(keyPath, 0o600);
  const seed = fromHex(JSON.parse(readFileSync(keyPath, "utf8")).seed);
  const signer = ed25519Signer(seed);
  const statePath = join(o.dir, "identity.json");
  const store = new JsonFileStore(join(o.dir, "kel.json"));
  let controller: Controller;
  let ident: { aid: string; witnesses: { aid: string; url: string }[] };
  if (existsSync(statePath)) {
    ident = JSON.parse(readFileSync(statePath, "utf8"));
    controller = await Controller.load(ident.aid, { hot: [signer], store, clock: o.clock });
  } else {
    const e = await o.enroll();
    controller = await Controller.incept({
      hot: [signer],
      next: [e.next],
      witnesses: e.witnesses.map((w) => w.aid),
      bt: e.bt,
      data: { messagingDid: identityFromSeed(seed).did, keyClass: "S", device: "sensor" },
      store,
      clock: o.clock,
    });
    ident = { aid: controller.aid, witnesses: e.witnesses };
    writeAtomic(statePath, JSON.stringify({ ...ident, nonce: e.nonce, name: o.name }, null, 2));
  }
  const clients = ident.witnesses.map((w) => httpWitnessClient(w.url, w.aid));
  const report = await controller.publish(clients);
  if (report.missing.length) o.log?.(`${o.name}: ${report.missing.length} witness(es) didn't answer: ${report.missing[0].error}`);
  await o.registered(controller.aid);
  const did = deviceDid(controller.aid);

  const chainPath = join(o.dir, "chain.json");
  const cose = seedSigner(seed, utf8(kidOf(did, controller.state().estSn)));
  let chain: ReadingChain;
  if (existsSync(chainPath)) {
    const c = JSON.parse(readFileSync(chainPath, "utf8")) as ChainFile;
    const state: ChainState = { dev: fromHex(c.state.dev), seq: c.state.seq, lastHash: fromHex(c.state.lastHash), firstUnsealed: c.state.firstUnsealed };
    chain = new ReadingChain(state, cose);
    for (const [s, f] of c.sent) chain.sent.set(s, fromB64(f));
    for (const [last, first, f] of c.seals ?? []) chain.seals.set(last, { firstSeq: first, frame: fromB64(f) });
  } else chain = new ReadingChain(freshChain(devTag(did)), cose);
  const save = () => {
    const s = chain.state;
    const file: ChainFile = {
      state: { dev: hex(s.dev), seq: s.seq, lastHash: hex(s.lastHash), firstUnsealed: s.firstUnsealed },
      sent: [...chain.sent.entries()].slice(-500).map(([k, v]) => [k, b64(v)]),
      seals: [...chain.seals.entries()].slice(-60).map(([k, v]) => [k, v.firstSeq, b64(v.frame)]),
    };
    writeAtomic(chainPath, JSON.stringify(file));
  };
  return {
    name: o.name,
    aid: controller.aid,
    did,
    controller,
    chain,
    witnessClients: clients,
    // saved before each frame goes on the air, so a restart never reuses a sequence number (that would look like equivocation)
    save,
  };
}
