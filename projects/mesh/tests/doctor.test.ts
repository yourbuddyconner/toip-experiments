import { createSocket, type Socket } from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import type { SerialPortLike } from "@zk-toip/mesh-transport/serial";
import { formatReport, runDoctor } from "../src/doctor";

const EUI = Buffer.from("AA555A0000000001", "hex");
const sockets: Socket[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
});

/** A fake packet forwarder: a UDP socket on localhost that talks GWMP to the doctor's port. */
async function forwarder(opts: { pull?: boolean; rxpk?: boolean; txAck?: string }) {
  const s = createSocket("udp4");
  sockets.push(s);
  await new Promise<void>((r) => s.bind(0, "127.0.0.1", () => r()));
  const got: number[] = [];
  return {
    got,
    start(port: number) {
      s.on("message", (m) => {
        got.push(m[3]);
        // PULL_RESP: a frame to transmit. Answer with TX_ACK.
        if (m[3] === 0x03 && opts.txAck !== undefined) {
          const json = Buffer.from(JSON.stringify({ txpk_ack: { error: opts.txAck } }));
          s.send(Buffer.concat([Buffer.from([2, m[1], m[2], 0x05]), EUI, json]), port, "127.0.0.1");
        }
      });
      const push = (body: object) => s.send(Buffer.concat([Buffer.from([2, 0x12, 0x34, 0x00]), EUI, Buffer.from(JSON.stringify(body))]), port, "127.0.0.1");
      push({ stat: { time: "2026-11-06 12:00:00 GMT", rxnb: 0, rxok: 0, rxfw: 0, ackr: 100, dwnb: 0, txnb: 0 } });
      if (opts.rxpk)
        push({ rxpk: [{ tmst: 1, freq: 904.6, chan: 8, rfch: 0, stat: 1, modu: "LORA", datr: "SF8BW500", codr: "4/5", rssi: -71, lsnr: 9.5, size: 3, data: Buffer.from([0xa2, 1, 2]).toString("base64") }] });
      if (opts.pull) setTimeout(() => s.send(Buffer.concat([Buffer.from([2, 0x56, 0x78, 0x02]), EUI]), port, "127.0.0.1"), 50);
    },
  };
}

/** A serial port that answers like stock RUI3 firmware already in P2P mode. */
function rui3(label = "/dev/tty.usbserial-0001"): SerialPortLike & { log: string[] } {
  const fns = new Set<(b: Uint8Array) => void>();
  const log: string[] = [];
  let text = "";
  const say = (...lines: string[]) => setTimeout(() => fns.forEach((f) => f(new TextEncoder().encode(lines.map((l) => `${l}\r\n`).join("")))), 2);
  return {
    label,
    log,
    async open() {},
    async close() {},
    async write(b) {
      if (b[0] === 0xc0) return; // a KISS probe: AT firmware ignores it
      text += new TextDecoder().decode(b);
      let i;
      while ((i = text.indexOf("\r\n")) >= 0) {
        const cmd = text.slice(0, i);
        text = text.slice(i + 2);
        log.push(cmd);
        if (cmd === "AT") say("OK");
        else if (cmd === "AT+VER=?") say("AT+VER=RUI_4.0.6_RAK3172-E", "OK");
        else if (cmd === "AT+NWM=?") say("AT+NWM=0", "OK");
        else if (cmd.startsWith("AT+")) say("OK");
      }
    },
    onData(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
  };
}

function chatter(label: string, bytes: Uint8Array): SerialPortLike {
  const fns = new Set<(b: Uint8Array) => void>();
  return {
    label,
    async open() {
      setTimeout(() => fns.forEach((f) => f(bytes)), 5);
    },
    async close() {},
    async write() {},
    onData(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
  };
}

const fast = { listenMs: 30, probeMs: 60 };

describe("mesh doctor", () => {
  it("sees the miner's packet forwarder both ways, the packets it forwards, and its answer to a test transmission", async () => {
    const fwd = await forwarder({ pull: true, rxpk: true, txAck: "NONE" });
    const lines: string[] = [];
    const r = await runDoctor({ udpPort: 0, udpHost: "127.0.0.1", seconds: 3, txTest: true, noSerial: true, onListening: (p) => fwd.start(p), log: (l) => lines.push(l) });
    expect(r.gateways).toEqual([{ eui: "AA555A0000000001", downlink: true, heard: [{ bytes: 3, rssi: -71, snr: 9.5, frequencyHz: 904_600_000 }], tx: "ok" }]);
    expect(fwd.got).toContain(0x01); // PUSH_ACK
    expect(fwd.got).toContain(0x04); // PULL_ACK
    expect(fwd.got).toContain(0x03); // PULL_RESP: the test frame
    expect(r.problems).toEqual([]);
    expect(r.next[0]).toMatch(/^mesh door --link gwmp:\d+/);
    expect(lines.join("\n")).toMatch(/RSSI -71 dBm, SNR 9.5 dB/);
  });

  it("explains a gateway that refuses 923.3 MHz", async () => {
    const fwd = await forwarder({ pull: true, txAck: "TX_FREQ" });
    const r = await runDoctor({ udpPort: 0, udpHost: "127.0.0.1", seconds: 3, txTest: true, noSerial: true, onListening: (p) => fwd.start(p) });
    expect(r.gateways[0].tx).toMatch(/TX_FREQ/);
    expect(r.problems.join("\n")).toMatch(/tx_freq_min\/tx_freq_max/);
    expect(r.ok).toBe(false);
  });

  it("says what to check when a forwarder sends uplink but no PULL_DATA, and when nothing arrives", async () => {
    const fwd = await forwarder({ pull: false });
    const r = await runDoctor({ udpPort: 0, udpHost: "127.0.0.1", seconds: 1, noSerial: true, onListening: (p) => fwd.start(p) });
    expect(r.gateways[0].downlink).toBe(false);
    expect(r.problems.join("\n")).toMatch(/no PULL_DATA.*serv_port_down/);
    const silent = await runDoctor({ udpPort: 0, udpHost: "127.0.0.1", seconds: 1, noSerial: true });
    expect(silent.gateways).toEqual([]);
    expect(silent.problems[0]).toMatch(/no packet forwarder sent anything/);
    expect(silent.problems[0]).toMatch(/SERVER_HOST/);
    expect(silent.problems[0]).toMatch(/MODEL must match/);
    expect(formatReport(silent)).toMatch(/To fix:/);
  });

  it("says when the UDP port is taken", async () => {
    const s = createSocket("udp4");
    sockets.push(s);
    await new Promise<void>((r) => s.bind(0, "127.0.0.1", () => r()));
    const r = await runDoctor({ udpPort: s.address().port, udpHost: "127.0.0.1", seconds: 1, noSerial: true });
    expect(r.problems[0]).toMatch(/in use by another program/);
  });

  it("finds a RAK3172 on stock RUI3 firmware, checks it takes the us915-b P2P settings, and names a Meshtastic board", async () => {
    const rak = rui3();
    const ports: Record<string, SerialPortLike> = {
      "/dev/tty.usbserial-0001": rak,
      "/dev/tty.usbmodem-mt": chatter("/dev/tty.usbmodem-mt", Uint8Array.of(0x94, 0xc3, 0, 4, 1, 2, 3, 4)),
    };
    const r = await runDoctor({
      udpPort: 0,
      udpHost: "127.0.0.1",
      seconds: 1,
      rakP2p: true,
      probe: fast,
      listPorts: async () => [{ path: "/dev/tty.usbserial-0001", hint: "CP210x USB serial bridge" }, { path: "/dev/tty.usbmodem-mt" }],
      openPort: (p) => ports[p],
    });
    expect(r.ports.map((p) => [p.path, p.found.kind, p.p2p])).toEqual([
      ["/dev/tty.usbserial-0001", "rak-rui3", "ok"],
      ["/dev/tty.usbmodem-mt", "meshtastic", undefined],
    ]);
    expect(rak.log).toContain("AT+P2P=923300000:8:2:0:8:20");
    expect(rak.log).toContain("AT+SYNCWORD=3444");
    expect(r.problems.join("\n")).toMatch(/Meshtastic/);
    expect(r.next).toContain("mesh guest --link rak:/dev/tty.usbserial-0001        (Rosa's radio is the RAK3172)");
  });

  it("says to plug the board in when there are no serial ports, and what to try when nothing answers AT", async () => {
    const none = await runDoctor({ udpPort: 0, udpHost: "127.0.0.1", seconds: 1, listPorts: async () => [] });
    expect(none.problems.join("\n")).toMatch(/plug in the RAK3172/);
    const quiet = await runDoctor({ udpPort: 0, udpHost: "127.0.0.1", seconds: 1, probe: fast, listPorts: async () => [{ path: "/dev/q" }], openPort: () => chatter("/dev/q", new Uint8Array(0)) });
    expect(quiet.problems.join("\n")).toMatch(/no RAK3172 answered AT/);
  });
});
