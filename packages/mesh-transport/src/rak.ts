/**
 * A RAK3172 (or RAK4631-R) running stock RUI3 AT firmware, in LoRa P2P mode, over USB serial
 * (design §14.6). Commands end in CR LF and wait for OK or an error. Received frames arrive as
 * `+EVT:RXP2P:<rssi>:<snr>:<hex>`. On a split plan (us915-b) the module retunes once per burst.
 * Runs wherever a SerialPortLike does (Node or Web Serial).
 */
import { loraAirtimeMs, type ChannelPlan, type LoRaSetting } from "./airtime";
import { LinkEvents, type Link, type LinkInfo, type LinkState, type ReceivedFrame } from "./link";
import type { SerialPortLike } from "./serial";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
const fromHex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const sameSetting = (a: LoRaSetting, b: LoRaSetting) =>
  a.frequencyHz === b.frequencyHz && a.spreadingFactor === b.spreadingFactor && a.bandwidthHz === b.bandwidthHz && a.codingRate === b.codingRate && a.txPowerDbm === b.txPowerDbm;

/** `AT+P2P=freq:SF:bandwidth code:coding rate code:preamble:power`. Bandwidth codes: 0 = 125, 1 = 250, 2 = 500 kHz. */
export function p2pCommand(s: LoRaSetting): string {
  const bw = s.bandwidthHz === 125000 ? 0 : s.bandwidthHz === 250000 ? 1 : s.bandwidthHz === 500000 ? 2 : -1;
  if (bw < 0) throw new Error(`RUI3 P2P has no ${s.bandwidthHz} Hz bandwidth code here`);
  return `AT+P2P=${s.frequencyHz}:${s.spreadingFactor}:${bw}:${s.codingRate - 5}:${s.preambleSymbols}:${s.txPowerDbm}`;
}

const ERROR = /^(AT_[A-Z_]*ERROR|AT_COMMAND_NOT_FOUND)/;
const BANNER = /RAKwireless|Current Work Mode/i;

export class RakP2PLink implements Link {
  readonly info: LinkInfo;
  /** The firmware version, from AT+VER=?, once open. */
  version?: string;
  private readonly events = new LinkEvents();
  private readonly port: SerialPortLike;
  private readonly plan: ChannelPlan;
  private readonly split: boolean;
  private buf = "";
  private pending?: { cmd: string; lines: string[]; done: (lines: string[] | Error) => void };
  private txDone?: () => void;
  private mutex: Promise<unknown> = Promise.resolve();
  private tunedForTx = false;
  private retune?: ReturnType<typeof setTimeout>;
  private offData?: () => void;
  private readonly o: { cad: boolean; commandTimeoutMs: number; restartWaitMs: number; burstGapMs: number };

  constructor(opts: { port: SerialPortLike; plan: ChannelPlan; cad?: boolean; commandTimeoutMs?: number; restartWaitMs?: number; burstGapMs?: number }) {
    this.port = opts.port;
    this.plan = opts.plan;
    this.split = !sameSetting(opts.plan.tx, opts.plan.rx);
    this.o = { cad: opts.cad ?? true, commandTimeoutMs: opts.commandTimeoutMs ?? 2000, restartWaitMs: opts.restartWaitMs ?? 3000, burstGapMs: opts.burstGapMs ?? 60 };
    this.info = {
      label: `rak:${opts.port.label}`,
      kind: "lora",
      // AT+PSEND takes 2 to 500 hex digits: 250 bytes (the manual also says 256; 250 until tested).
      mtu: Math.min(250, opts.plan.mtu),
      broadcast: true,
      halfDuplex: true,
      reliable: false,
      // Retuning costs several command round trips: a guess, to measure on hardware.
      turnaroundMs: 300,
      airtimeMs: (n) => loraAirtimeMs(n, opts.plan.tx),
      budget: opts.plan.budget,
    };
  }

  get state(): LinkState {
    return this.events.state;
  }

  onFrame(fn: (f: ReceivedFrame) => void): () => void {
    return this.events.onFrame(fn);
  }

  onState(fn: (s: LinkState) => void): () => void {
    return this.events.onState(fn);
  }

  async open(): Promise<void> {
    this.events.setState("opening");
    this.offData ??= this.port.onData((b) => this.onData(b));
    try {
      await this.port.open();
      await this.exclusive(() => this.init());
      this.events.setState("open");
    } catch (e) {
      this.events.setState("failed");
      throw e;
    }
  }

  async close(): Promise<void> {
    clearTimeout(this.retune);
    this.offData?.();
    this.offData = undefined;
    await this.port.close().catch(() => {});
    this.events.setState("closed");
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.state !== "open") throw new Error(`${this.info.label} is not open`);
    if (frame.length > this.info.mtu) throw new Error(`${this.info.label}: frame over the MTU`);
    await this.exclusive(async () => {
      clearTimeout(this.retune);
      if (this.split && !this.tunedForTx) {
        await this.cmd("AT+PRECV=0");
        await this.cmd(p2pCommand(this.plan.tx));
        this.tunedForTx = true;
      }
      const done = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${this.info.label}: no +EVT:TXP2P DONE`)), this.info.airtimeMs(frame.length) + 2000);
        this.txDone = () => {
          clearTimeout(t);
          resolve();
        };
      });
      try {
        await this.cmd(`AT+PSEND=${toHex(frame)}`);
        await done;
      } finally {
        this.txDone = undefined;
      }
      // Back to the listen setting once the burst is over (no send for burstGapMs).
      if (this.split) this.retune = setTimeout(() => void this.exclusive(() => this.listenAgain()).catch(() => {}), this.o.burstGapMs);
    });
  }

  private async init(): Promise<void> {
    await this.cmd("AT");
    const ver = await this.cmd("AT+VER=?");
    this.version = ver.map((l) => l.replace(/^AT\+VER=/, "")).find((l) => l.length > 0);
    const nwm = await this.cmd("AT+NWM=?").catch(() => [] as string[]);
    if (!nwm.some((l) => /NWM=0\b/.test(l))) {
      // The module restarts into P2P mode: wait, then check it's back.
      await this.cmd("AT+NWM=0").catch(() => []);
      await sleep(this.o.restartWaitMs);
      let alive = false;
      for (let i = 0; i < 5 && !alive; i++) alive = await this.cmd("AT").then(() => true, () => sleep(300).then(() => false));
      if (!alive) throw new Error(`${this.info.label}: no answer after switching to P2P mode`);
    }
    await this.cmd(`AT+SYNCWORD=${this.plan.rx.syncWord === "public" ? "3444" : "1424"}`);
    await this.cmd(`AT+IQINVER=${this.plan.rx.invertIq ? 1 : 0}`);
    if (this.o.cad) await this.cmd("AT+CAD=1");
    await this.listenAgain();
  }

  private async listenAgain(): Promise<void> {
    await this.cmd(p2pCommand(this.plan.rx));
    await this.cmd("AT+PRECV=65533");
    this.tunedForTx = false;
  }

  /** Runs `fn` with the serial port to itself. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn, fn);
    this.mutex = run.catch(() => {});
    return run;
  }

  /** Sends one command and waits for OK (returning the lines before it) or an error. Retries AT_BUSY_ERROR. */
  private async cmd(command: string): Promise<string[]> {
    for (let attempt = 0; ; attempt++) {
      const r = await new Promise<string[] | Error>((done) => {
        const t = setTimeout(() => {
          this.pending = undefined;
          done(new Error(`${command}: no answer`));
        }, this.o.commandTimeoutMs);
        this.pending = {
          cmd: command,
          lines: [],
          done: (x) => {
            clearTimeout(t);
            this.pending = undefined;
            done(x);
          },
        };
        this.port.write(new TextEncoder().encode(`${command}\r\n`)).catch((e) => this.pending?.done(e instanceof Error ? e : new Error(String(e))));
      });
      if (!(r instanceof Error)) return r;
      if (/AT_BUSY_ERROR/.test(r.message) && attempt < 3) {
        await sleep(100);
        continue;
      }
      throw r;
    }
  }

  private onData(bytes: Uint8Array): void {
    this.buf += new TextDecoder().decode(bytes);
    if (this.buf.length > 4096) this.buf = this.buf.slice(-4096);
    let i;
    while ((i = this.buf.search(/\r?\n/)) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + (this.buf[i] === "\r" ? 2 : 1));
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    if (line.startsWith("+EVT:RXP2P:")) {
      const [, , rssi, snr, data] = line.split(":");
      if (data && /^[0-9a-fA-F]*$/.test(data) && data.length % 2 === 0) {
        this.events.frame({ bytes: fromHex(data), atMs: Date.now(), rssi: Number(rssi), snr: Number(snr), frequencyHz: this.plan.rx.frequencyHz });
      }
      return;
    }
    if (line.startsWith("+EVT:TXP2P")) return this.txDone?.();
    const p = this.pending;
    if (p) {
      if (line === p.cmd) return; // an echo
      if (line === "OK") return p.done(p.lines);
      if (ERROR.test(line)) return p.done(new Error(`${p.cmd}: ${line}`));
      p.lines.push(line);
      return;
    }
    // The module restarted by itself: it isn't listening any more.
    if (BANNER.test(line) && this.state === "open") void this.exclusive(() => this.listenAgain()).catch(() => this.events.setState("failed"));
  }
}
