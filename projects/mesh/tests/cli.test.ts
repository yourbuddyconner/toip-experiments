import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { US915_UP, realScheduler, regions } from "@toip-tools/mesh-transport";
import { SimMedium } from "@toip-tools/mesh-transport/sim";
import { startRelay, type Relay } from "@toip-tools/relay";
import { runCli, type CliDeps, type Io } from "../src/cli";
import { parseLink, parsePlan } from "../src/links";

function io(extra: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), ...extra } as Io };
}

let relay: Relay;
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mesh-cli-"));
  relay = await startRelay({ port: 0, host: "127.0.0.1", dbPath: join(dir, "relay.db") });
});
afterAll(async () => {
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Real-time simulated radios standing in for the miner and the RAK3172, by the name in --link. */
function fakeRadios(connect: [string, string][]): Partial<CliDeps> {
  const medium = new SimMedium({ scheduler: realScheduler, seed: 9 });
  const made = new Set<string>();
  return {
    openRealLink: async (spec) => {
      const name = spec.kind === "rak" ? spec.path : `gwmp${spec.port}`;
      const link = medium.node(name, { setting: US915_UP, mtu: 250, budget: regions.us915, turnaroundMs: 20 });
      made.add(name);
      for (const [a, b] of connect) if (made.has(a) && made.has(b) && (a === name || b === name)) medium.connect(a, b);
      return { link, describe: `fake ${name}`, close: () => link.close() };
    },
  };
}

describe("CLI arguments", () => {
  it("prints help, and refuses unknown commands and options with exit code 2", async () => {
    const h = io();
    expect(await runCli([], h.io)).toBe(0);
    expect(h.out[0]).toMatch(/^Trust Tasks and TSP over LoRa/);
    for (const [argv, msg] of [
      [["frobnicate"], /unknown command "frobnicate"/],
      [["demo", "--bogus"], /Unknown option '--bogus'/],
      [["demo", "--loss", "1.5"], /--loss must be a number from 0 to 0.9/],
      [["demo", "--act", "4"], /--act must be a number from 1 to 3/],
      [["demo", "--seed", "x"], /--seed must be/],
      [["door"], /--link is required/],
      [["door", "--link", "lora"], /unknown --link "lora"/],
      [["guest", "--link", "rak:"], /needs the serial port/],
      [["guest", "--link", "gwmp:99999"], /bad UDP port/],
      [["guest", "--link", "sim", "--plan", "eu868"], /unknown --plan "eu868"/],
      [["guest", "--link", "sim", "--hours", "9-5"], /--hours is like 12:00-14:00/],
      [["guest", "--link", "sim", "--tz", "Mars/Olympus"], /unknown time zone/],
      [["guest", "--link", "sim", "--wait", "0"], /--wait must be/],
      [["attest", "--link", "sim", "--payment", "roof"], /--payment is sink or fan/],
      [["doctor", "--port", "abc"], /--port must be/],
      [["bundle"], /bundle needs export or import/],
      [["bundle", "frob"], /unknown bundle command "frob"/],
      [["bundle", "import"], /needs the bundle file/],
      [["bundle", "export", "--unsealed", "--seal-to", "neighbor"], /don't go together/],
      [["demo", "extra"], /Unexpected argument|unexpected argument/],
    ] as [string[], RegExp][]) {
      const t = io();
      expect(await runCli(argv, t.io), argv.join(" ")).toBe(2);
      expect(t.err.join("\n"), argv.join(" ")).toMatch(msg);
    }
  });

  it("parses links and plans", () => {
    expect(parseLink("sim")).toEqual({ kind: "sim" });
    expect(parseLink("gwmp")).toEqual({ kind: "gwmp", port: 1700 });
    expect(parseLink("gwmp:1701")).toEqual({ kind: "gwmp", port: 1701 });
    expect(parseLink("rak:/dev/tty.usbserial-0001")).toEqual({ kind: "rak", path: "/dev/tty.usbserial-0001" });
    expect(parsePlan(undefined)).toBe("us915-b");
    expect(parsePlan("us915-a")).toBe("us915-a");
  });

  it("refuses a LoRaWAN gateway as the guest's radio on us915-b, before opening anything", async () => {
    const t = io();
    expect(await runCli(["guest", "--link", "gwmp:1"], t.io)).toBe(2);
    expect(t.err[0]).toMatch(/can only be the door or gateway side/);
  });

  it("passes doctor's options through and exits 1 when something needs fixing", async () => {
    let seen: unknown;
    const t = io();
    const code = await runCli(["doctor", "--port", "1701", "--seconds", "2", "--tx-test", "--no-serial"], t.io, {
      runDoctor: async (o) => ((seen = o), { udpPort: 1701, gateways: [], ports: [], problems: ["nothing"], next: [], ok: false }),
    });
    expect(code).toBe(1);
    expect(seen).toMatchObject({ udpPort: 1701, seconds: 2, txTest: true, rakP2p: false, noSerial: true });
    expect(t.out.join("\n")).toMatch(/To fix:\n  • nothing/);
  });
});

describe("CLI commands", () => {
  it("demo --act 1 narrates the door act with airtime, frames and sizes", async () => {
    const t = io();
    expect(await runCli(["demo", "--act", "1", "--seed", "2"], t.io)).toBe(0);
    const text = t.out.join("\n");
    expect(text).toMatch(/Act 1 · A door with no internet/);
    expect(text).toMatch(/BEACON door\s+82 B\s+64 ms/);
    expect(text).toMatch(/sizes: JSON TSP 2,\d{3} B → CTT1 TSP \d{3} B → on the air INTRO \d{3} B, 3 frames/);
    expect(text).toMatch(/Act 1, 0% loss: ok, [\d.]+ m?s airtime/);
  });

  it("door and guest on --link sim run act 1 here", async () => {
    const t = io();
    expect(await runCli(["guest", "--link", "sim"], t.io)).toBe(0);
    expect(t.out.join("\n")).toMatch(/✓ door\/open response \{open: true\}/);
  });

  it("door and guest, each in its own command, on two radios: the guest gets in", async () => {
    const state = mkdtempSync(join(dir, "door-"));
    const radios = fakeRadios([["/dev/rosa", "gwmp1700"]]);
    const g = io();
    const d = io();
    const guest = runCli(["guest", "--link", "rak:/dev/rosa", "--wait", "20"], g.io, radios);
    await new Promise((r) => setTimeout(r, 150));
    const door = runCli(["door", "--link", "gwmp", "--once", "--state", state], d.io, radios);
    expect(await guest, [...g.out, ...g.err, "--- door:", ...d.out, ...d.err].join("\n")).toBe(0);
    expect(await door).toBe(0);
    expect(g.out.join("\n")).toMatch(/✓ the door opened/);
    expect(d.out.join("\n")).toMatch(/OPENED: a valid pass from household 4B, "dog walker"/);
    // The door kept its replay record on disk.
    expect(existsSync(join(state, "door-replay.json"))).toBe(true);
  });

  it("attest with no gateway in range keeps the message in the outbox file; bundle export and import carry it to the landlord's agent", async () => {
    const state = mkdtempSync(join(dir, "alice-"));
    const a = io();
    expect(await runCli(["attest", "--link", "rak:/dev/alice", "--wait", "0", "--state", state], a.io, fakeRadios([]))).toBe(0);
    expect(a.out.join("\n")).toMatch(/1 message\(s\) wait in/);
    expect(JSON.parse(readFileSync(join(state, "outbox.json"), "utf8"))[0].state).toBe("pending");

    const file = join(state, "stick.toipbundle");
    const e = io();
    expect(await runCli(["bundle", "export", "--state", state, "--out", file], e.io)).toBe(0);
    expect(e.out[0]).toMatch(/1 message\(s\), \d+ B, sealed to the neighbor/);
    expect(JSON.parse(readFileSync(join(state, "outbox.json"), "utf8"))[0].state).toBe("carried");
    const again = io();
    expect(await runCli(["bundle", "export", "--state", state, "--out", file], again.io)).toBe(1);
    expect(again.err[0]).toMatch(/nothing waits/);

    const ctl = new AbortController();
    const r = io({ signal: ctl.signal });
    const receiving = runCli(["receive", "--once", "--relay", relay.url], r.io);
    await new Promise((res) => setTimeout(res, 300));
    const wrong = io();
    expect(await runCli(["bundle", "import", file, "--relay", relay.url, "--as", "eve"], wrong.io)).toBe(1);
    expect(wrong.err[0]).toMatch(/sealed to someone else/);
    const i = io();
    expect(await runCli(["bundle", "import", file, "--relay", relay.url], i.io)).toBe(0);
    expect(i.out.join("\n")).toMatch(/posted 1 to/);
    const timer = setTimeout(() => ctl.abort(), 10_000);
    expect(await receiving).toBe(0);
    clearTimeout(timer);
    expect(r.out.join("\n")).toMatch(/accepted from Alice: "complete" for "Fix kitchen sink leak, Unit 4B"/);
  });

  it("gateway --link sim bridges a simulated cabin to a real relay, and the landlord's agent accepts the attestation", async () => {
    const ctl = new AbortController();
    const r = io({ signal: ctl.signal });
    const receiving = runCli(["receive", "--once", "--relay", relay.url], r.io);
    await new Promise((res) => setTimeout(res, 300));
    const g = io();
    expect(await runCli(["gateway", "--link", "sim", "--relay", relay.url, "--state", mkdtempSync(join(dir, "gw-"))], g.io)).toBe(0);
    const text = g.out.join("\n");
    expect(text).toMatch(/\[lodge\] .*posted \d+ B of TSP/);
    expect(text).toMatch(/with the Lodge's signed custody receipt/);
    const timer = setTimeout(() => ctl.abort(), 10_000);
    expect(await receiving).toBe(0);
    clearTimeout(timer);
    expect(r.out.join("\n")).toMatch(/accepted from Alice/);
  });
});
