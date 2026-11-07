import { createSocket, type Socket } from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { loraAirtimeMs, regions, type ChannelPlan } from "../src/airtime";
import { GWMP, GwmpServer, type GwmpLink } from "../src/gwmp";
import { LinkEvents, type Link, type LinkInfo, type ReceivedFrame } from "../src/link";
import { MeshTransport } from "../src/mesh";
import { ident, setting, wireOf } from "./helpers";

const EUI = "AA555A0000000001";
const euiBytes = (eui: string) => Buffer.from(eui, "hex");

/** A fake packet forwarder: a UDP client that speaks GWMP the way lora_pkt_fwd does. */
class FakeForwarder {
  readonly sock: Socket = createSocket("udp4");
  readonly got: Buffer[] = [];
  private waiters: ((b: Buffer) => void)[] = [];
  txAck: (txpk: any) => string | null = () => "NONE";
  onTx?: (txpk: any) => void;

  constructor(
    readonly serverPort: number,
    readonly eui = EUI,
  ) {
    this.sock.on("message", (m) => {
      if (m[3] === GWMP.PULL_RESP) {
        const txpk = JSON.parse(m.subarray(4).toString()).txpk;
        this.onTx?.(txpk);
        const err = this.txAck(txpk);
        if (err !== null) this.send(GWMP.TX_ACK, Buffer.from(JSON.stringify({ txpk_ack: { error: err } })), [m[1], m[2]]);
      }
      const w = this.waiters.shift();
      if (w) w(m);
      else this.got.push(m);
    });
  }
  next(): Promise<Buffer> {
    return new Promise((r) => (this.got.length ? r(this.got.shift()!) : this.waiters.push(r)));
  }
  send(id: number, body = Buffer.alloc(0), token = [0x12, 0x34]): void {
    this.sock.send(Buffer.concat([Buffer.from([2, token[0], token[1], id]), euiBytes(this.eui), body]), this.serverPort, "127.0.0.1");
  }
  pull(): void {
    this.send(GWMP.PULL_DATA);
  }
  push(frames: Uint8Array[], extra: object[] = []): void {
    const rxpk = frames.map((f) => ({ tmst: 1, freq: 904.6, chan: 8, rfch: 0, stat: 1, modu: "LORA", datr: "SF7BW500", codr: "4/5", rssi: -57, lsnr: 9.5, size: f.length, data: Buffer.from(f).toString("base64") }));
    this.send(GWMP.PUSH_DATA, Buffer.from(JSON.stringify({ rxpk: [...rxpk, ...extra], stat: { time: "2026-11-06 12:00:00 GMT" } })));
  }
  close(): void {
    this.sock.close();
  }
}

const servers: GwmpServer[] = [];
const fakes: FakeForwarder[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) f.close();
  for (const s of servers.splice(0)) await s.stop();
});

const fast: ChannelPlan = { name: "test", tx: setting(7, 500000, 923_300_000), rx: setting(7, 500000, 904_600_000), mtu: 250, budget: regions.none };

async function serverAndForwarder(opts: ConstructorParameters<typeof GwmpServer>[0] = {}) {
  const server = new GwmpServer({ port: 0, host: "127.0.0.1", plan: fast, ...opts });
  await server.start();
  servers.push(server);
  const fake = new FakeForwarder(server.port);
  fakes.push(fake);
  return { server, fake };
}

describe("GwmpServer and GwmpLink", () => {
  it("acknowledges PULL_DATA and PUSH_DATA, opens a link per gateway, and turns rxpk into frames", async () => {
    const { server, fake } = await serverAndForwarder();
    const links: GwmpLink[] = [];
    server.onGateway((l) => links.push(l));
    fake.pull();
    const ack = await fake.next();
    expect([...ack]).toEqual([2, 0x12, 0x34, GWMP.PULL_ACK]);
    expect(links).toHaveLength(1);
    const link = server.link(EUI)!;
    expect(link.state).toBe("open");
    expect(link.info).toMatchObject({ label: `gwmp:${EUI}`, kind: "lora", mtu: 250, broadcast: true, halfDuplex: true });
    const frames: ReceivedFrame[] = [];
    link.onFrame((f) => frames.push(f));
    // A CRC failure and an FSK packet are ignored.
    fake.push([Uint8Array.of(0xa0, 1, 2, 3)], [{ stat: -1, modu: "LORA", data: "AAAA" }, { stat: 1, modu: "FSK", data: "AAAA" }]);
    expect([...(await fake.next())]).toEqual([2, 0x12, 0x34, GWMP.PUSH_ACK]);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ bytes: Uint8Array.of(0xa0, 1, 2, 3), rssi: -57, snr: 9.5, frequencyHz: 904_600_000 });
  });

  it("sends a frame as PULL_RESP txpk, resolves on TX_ACK NONE after the airtime, rejects on an error or silence", async () => {
    const { server, fake } = await serverAndForwarder({ txAckTimeoutMs: 200 });
    fake.pull();
    await fake.next();
    const link = server.link(EUI)!;
    const frame = Uint8Array.from({ length: 100 }, (_, i) => i);
    const t0 = Date.now();
    await link.send(frame);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(Math.floor(loraAirtimeMs(100, fast.tx)) - 2);
    const resp = await fake.next();
    expect(resp[3]).toBe(GWMP.PULL_RESP);
    const txpk = JSON.parse(resp.subarray(4).toString()).txpk;
    expect(txpk).toMatchObject({ imme: true, freq: 923.3, rfch: 0, powe: 20, modu: "LORA", datr: "SF7BW500", codr: "4/5", ipol: false, size: 100 });
    expect(Buffer.from(txpk.data, "base64")).toEqual(Buffer.from(frame));

    fake.txAck = () => "TX_FREQ";
    await expect(link.send(frame)).rejects.toThrow(/TX_FREQ/);
    fake.txAck = () => null;
    await expect(link.send(frame)).rejects.toThrow(/no TX_ACK/);
  });

  it("refuses to send before the gateway has pulled, ignores gateways not on the allow list, and fails a silent gateway", async () => {
    const { server, fake } = await serverAndForwarder({ allow: [{ eui: EUI, address: "127.0.0.1" }], staleMs: 300 });
    const stranger = new FakeForwarder(server.port, "BB555A0000000002");
    fakes.push(stranger);
    stranger.pull();
    await new Promise((r) => setTimeout(r, 100));
    expect(server.link("BB555A0000000002")).toBeUndefined();
    expect(stranger.got).toHaveLength(0);
    fake.push([Uint8Array.of(0xa0)]);
    await fake.next();
    const link = server.link(EUI)!;
    expect(link.state).toBe("opening");
    await expect(link.send(Uint8Array.of(1))).rejects.toThrow(/no downlink path/);
    fake.pull();
    await fake.next();
    expect(link.state).toBe("open");
    const states: string[] = [];
    link.onState((s) => states.push(s));
    await new Promise((r) => setTimeout(r, 900));
    expect(states).toContain("failed");
  });

  it("carries a mesh exchange end to end: a node's frames up through the forwarder, ACKs back down as txpk", async () => {
    const { server, fake } = await serverAndForwarder();
    fake.pull();
    await fake.next();
    const gwLink = server.link(EUI)!;
    // The node's radio: what it sends, the forwarder "hears"; what the gateway transmits, it hears.
    const events = new LinkEvents();
    events.state = "open";
    const nodeInfo: LinkInfo = { label: "fake-node", kind: "lora", mtu: 250, broadcast: true, halfDuplex: true, reliable: false, turnaroundMs: 5, airtimeMs: (n) => loraAirtimeMs(n, fast.rx), budget: regions.none };
    const nodeLink: Link = {
      info: nodeInfo,
      get state() {
        return events.state;
      },
      open: async () => {},
      close: async () => events.setState("closed"),
      send: async (f) => {
        await new Promise((r) => setTimeout(r, nodeInfo.airtimeMs(f.length)));
        fake.push([f]);
      },
      onFrame: (fn) => events.onFrame(fn),
      onState: (fn) => events.onState(fn),
    };
    fake.onTx = (txpk) => setTimeout(() => events.frame({ bytes: new Uint8Array(Buffer.from(txpk.data, "base64")), atMs: Date.now() }), 0);
    const guest = ident("gw/guest");
    const door = ident("gw/door");
    const guestMesh = new MeshTransport({ identities: [guest], links: [nodeLink], flood: { maxTtl: 0, relayShare: 0.3, unknown: "direct" } });
    const doorMesh = new MeshTransport({ identities: [door], links: [gwLink] });
    const inbox: Uint8Array[] = [];
    doorMesh.attach(door.did, async (w) => void inbox.push(w));
    await guestMesh.start();
    await doorMesh.start();
    doorMesh.addContact(guest.did);
    const wire = await wireOf(guest, door.did, 500);
    expect(await guestMesh.post(guest.did, door.did, wire)).toBe("live");
    expect(inbox).toEqual([wire]);
    await guestMesh.stop();
    await doorMesh.stop();
  });
});
