import { describe, expect, it } from "vitest";
import { plans } from "../src/airtime";
import type { ReceivedFrame } from "../src/link";
import { RakP2PLink } from "../src/rak";
import type { SerialPortLike } from "../src/serial";

/** Answers AT commands the way stock RUI3 firmware does, from a script. Output arrives in uneven chunks. */
class FakeRak implements SerialPortLike {
  readonly label = "/dev/tty.fake-rak";
  readonly log: string[] = [];
  readonly sent: string[] = [];
  nwm = 1;
  busyOnce = new Set<string>();
  paramError = new Set<string>();
  private restarting = false;
  private text = "";
  private fns = new Set<(b: Uint8Array) => void>();
  opened = false;

  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  onData(fn: (b: Uint8Array) => void) {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  emit(...lines: string[]) {
    const bytes = new TextEncoder().encode(lines.map((l) => `${l}\r\n`).join(""));
    // Split into chunks of 7 bytes, as a USB serial bridge might.
    for (let i = 0; i < bytes.length; i += 7) {
      const chunk = bytes.slice(i, i + 7);
      setTimeout(() => this.fns.forEach((f) => f(chunk)), 1);
    }
  }
  async write(bytes: Uint8Array) {
    this.text += new TextDecoder().decode(bytes);
    let i;
    while ((i = this.text.indexOf("\r\n")) >= 0) {
      const cmd = this.text.slice(0, i);
      this.text = this.text.slice(i + 2);
      this.handle(cmd);
    }
  }
  restart() {
    this.restarting = true;
    setTimeout(() => {
      this.restarting = false;
      this.emit("RAKwireless RAK3172 Example", "------------------------------------------------------", "Current Work Mode: LoRa P2P.");
    }, 30);
  }
  rx(rssi: number, snr: number, bytes: Uint8Array) {
    this.emit(`+EVT:RXP2P:${rssi}:${snr}:${Buffer.from(bytes).toString("hex").toUpperCase()}`);
  }
  private handle(cmd: string) {
    this.log.push(cmd);
    if (this.restarting) return;
    const head = cmd.split("=")[0];
    if (this.busyOnce.has(head)) {
      this.busyOnce.delete(head);
      return this.emit("AT_BUSY_ERROR");
    }
    if (this.paramError.has(head)) return this.emit("AT_PARAM_ERROR");
    if (cmd === "AT") return this.emit("OK");
    if (cmd === "AT+VER=?") return this.emit("AT+VER=RUI_4.0.6_RAK3172-E", "OK");
    if (cmd === "AT+NWM=?") return this.emit(`AT+NWM=${this.nwm}`, "OK");
    if (cmd === "AT+NWM=0") {
      this.nwm = 0;
      this.emit("OK");
      return this.restart();
    }
    if (/^AT\+(SYNCWORD|IQINVER|CAD|P2P|PRECV)=/.test(cmd)) return this.emit("OK");
    if (cmd.startsWith("AT+PSEND=")) {
      this.sent.push(cmd.slice(9));
      this.emit("OK");
      setTimeout(() => this.emit("+EVT:TXP2P DONE"), 15);
      return;
    }
    this.emit("AT_COMMAND_NOT_FOUND");
  }
}

const mk = (fake: FakeRak, plan = plans["us915-b-node"]) => new RakP2PLink({ port: fake, plan, restartWaitMs: 60, commandTimeoutMs: 500, burstGapMs: 30 });
const LISTEN = "AT+P2P=923300000:8:2:0:8:20";
const TX = "AT+P2P=904600000:8:2:0:8:20";

describe("RakP2PLink (RUI3 AT firmware)", () => {
  it("opens with the design's command sequence, switching the module to P2P mode and waiting out its restart", async () => {
    const fake = new FakeRak();
    const link = mk(fake);
    await link.open();
    expect(link.state).toBe("open");
    expect(link.version).toBe("RUI_4.0.6_RAK3172-E");
    expect(fake.log).toEqual(["AT", "AT+VER=?", "AT+NWM=?", "AT+NWM=0", "AT", "AT+SYNCWORD=3444", "AT+IQINVER=0", "AT+CAD=1", LISTEN, "AT+PRECV=65533"]);
    expect(link.info).toMatchObject({ label: "rak:/dev/tty.fake-rak", kind: "lora", mtu: 250, turnaroundMs: 300, broadcast: true, halfDuplex: true });
    expect("channelBusy" in link).toBe(false);
  });

  it("skips the mode switch when the module is already in P2P mode", async () => {
    const fake = new FakeRak();
    fake.nwm = 0;
    await mk(fake).open();
    expect(fake.log).not.toContain("AT+NWM=0");
  });

  it("retunes once per burst on the split US plan, and sends each frame as hex", async () => {
    const fake = new FakeRak();
    fake.nwm = 0;
    const link = mk(fake);
    await link.open();
    fake.log.length = 0;
    const frames = [Uint8Array.of(0xa0, 1), Uint8Array.of(0xa0, 2), Uint8Array.of(0xa0, 3)];
    for (const f of frames) await link.send(f);
    await new Promise((r) => setTimeout(r, 120));
    expect(fake.log).toEqual(["AT+PRECV=0", TX, "AT+PSEND=A001", "AT+PSEND=A002", "AT+PSEND=A003", LISTEN, "AT+PRECV=65533"]);
  });

  it("doesn't retune on a one-frequency plan", async () => {
    const fake = new FakeRak();
    fake.nwm = 0;
    const link = mk(fake, plans["us915-a"]);
    await link.open();
    fake.log.length = 0;
    await link.send(Uint8Array.of(0xa0, 9));
    await new Promise((r) => setTimeout(r, 80));
    expect(fake.log).toEqual(["AT+PSEND=A009"]);
  });

  it("turns +EVT:RXP2P lines into frames, even split across reads", async () => {
    const fake = new FakeRak();
    fake.nwm = 0;
    const link = mk(fake);
    const got: ReceivedFrame[] = [];
    link.onFrame((f) => got.push(f));
    await link.open();
    fake.rx(-45, 9, Uint8Array.from({ length: 40 }, (_, i) => i));
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ rssi: -45, snr: 9, bytes: Uint8Array.from({ length: 40 }, (_, i) => i) });
  });

  it("retries a command that answers AT_BUSY_ERROR", async () => {
    const fake = new FakeRak();
    fake.nwm = 0;
    const link = mk(fake, plans["us915-a"]);
    await link.open();
    fake.busyOnce.add("AT+PSEND");
    await link.send(Uint8Array.of(0xa0, 7));
    expect(fake.sent).toEqual(["A007"]);
    expect(fake.log.filter((c) => c.startsWith("AT+PSEND"))).toHaveLength(2);
  });

  it("fails to open on AT_PARAM_ERROR, and says why", async () => {
    const fake = new FakeRak();
    fake.nwm = 0;
    fake.paramError.add("AT+P2P");
    const link = mk(fake);
    await expect(link.open()).rejects.toThrow(/AT\+P2P.*AT_PARAM_ERROR/);
    expect(link.state).toBe("failed");
  });

  it("listens again after the module restarts on its own", async () => {
    const fake = new FakeRak();
    fake.nwm = 0;
    const link = mk(fake);
    await link.open();
    fake.log.length = 0;
    fake.restart();
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.log).toEqual([LISTEN, "AT+PRECV=65533"]);
    expect(link.state).toBe("open");
  });
});
