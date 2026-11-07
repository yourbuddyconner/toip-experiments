/**
 * The mesh demo's command line.
 *
 *   npm run mesh --workspace @zk-toip/mesh -- <command> [options]
 *
 * Run with no command for help.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { startRelay } from "@zk-toip/relay";
import { act1, act2, act3, type ActOptions } from "./acts";
import { formatReport, runDoctor, type DoctorOptions, type DoctorReport } from "./doctor";
import { UsageError, openRealLink, parseLink, parsePlan, type LinkSpec, type OpenedLink, type PlanName } from "./links";
import { bundleExport, bundleImport, runAttest, runDoor, runGateway, runGatewaySim, runGuest, runReceive, type PassWindow } from "./live";
import { actHeader, printer, summary } from "./narrate";
import { PAYMENTS } from "./settle";
import { fmtBytes, fmtMs, type Trace } from "./trace";

export const USAGE = `Trust Tasks and TSP over LoRa, and by hand.

Usage: npm run mesh --workspace @zk-toip/mesh -- <command> [options]

Commands
  demo                     the three acts on the simulator, narrated
      --act 1|2|3            only this act
      --loss 0.2             frame loss on every radio link (0 to 0.9)
      --seed N               the simulator's seed (default 1)
  door    --link LINK      the Front Door: beacons a challenge, checks passes offline
  guest   --link LINK      Rosa: waits for the door's beacon and presents her pass
      --wait SECONDS         how long the guest waits for a beacon (default 60)
      --days Mon-Fri --hours 12:00-14:00 --tz Area/City
                             the pass's window (default: Daily 00:00-24:00, this machine's time zone)
  gateway --link LINK      the Lodge: bridges the radio to a TSP relay, with custody receipts
      --relay URL            the relay (default: start one on this machine, port RELAY_PORT or 4361)
  attest  --link LINK      Alice: sends a Settle attestation through a gateway, or keeps it in her outbox
      --payment sink|fan     which demo payment (default sink)
      --wait SECONDS         how long to listen for a gateway first (default 90)
  receive                  the landlord's agent: accepts Alice's attestations from the relay
      --relay URL            (default ws://localhost:4361/v1)
  doctor                   finds the radios and says what to fix
      --port 1700            the UDP port the packet forwarder sends to
      --seconds 15           how long to listen for it
      --tx-test              ask the gateway to transmit one short test frame
      --rak-p2p              switch a RAK3172 to LoRa P2P mode to check it accepts the settings
      --no-serial            skip the serial ports
  bundle export            writes Alice's outbox to a file for a courier
      --state DIR            Alice's state (default .data/alice)
      --seal-to NAME|DID     the courier (default neighbor); --unsealed to skip sealing
      --out FILE             (default alice-<time>.toipbundle)
  bundle import FILE       the courier posts a bundle's messages to the relay
      --relay URL            (default ws://localhost:4361/v1)
      --as NAME              the courier (default neighbor)

LINK is one of
  sim                      the simulator (door, guest and attest run the act; gateway runs in real time)
  gwmp[:PORT]              a LoRaWAN gateway's packet forwarder sending to this machine (the RAK miner)
  rak:PATH                 a RAK3172 on USB serial, stock RUI3 AT firmware, e.g. rak:/dev/tty.usbserial-0001

Common options: --plan us915-b|us915-a (default us915-b), --state DIR, --no-color.
Keys come from fixed demo seeds: this is a demo, not key management.`;

export interface Io {
  out(s: string): void;
  err(s: string): void;
  color?: boolean;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}

export interface CliDeps {
  openRealLink: typeof openRealLink;
  runDoctor: (o: DoctorOptions) => Promise<DoctorReport>;
  startRelay: typeof startRelay;
}

type Options = NonNullable<ParseArgsConfig["options"]>;

const COMMON: Options = { plan: { type: "string" }, state: { type: "string" }, "no-color": { type: "boolean" } };

function parse(args: string[], options: Options, positionals = 0) {
  let r;
  try {
    r = parseArgs({ args, options: { ...COMMON, ...options }, allowPositionals: positionals > 0, strict: true });
  } catch (e) {
    throw new UsageError((e as Error).message.split("\n")[0].replace(/\. To specify a positional.*$/, ""));
  }
  if (r.positionals.length > positionals) throw new UsageError(`unexpected argument ${JSON.stringify(r.positionals[positionals])}`);
  return { values: r.values as Record<string, string | boolean | undefined>, positionals: r.positionals };
}

function num(name: string, v: string | boolean | undefined, dflt: number, min: number, max: number): number {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (typeof v !== "string" || v.trim() === "" || !Number.isFinite(n) || n < min || n > max) throw new UsageError(`--${name} must be a number from ${min} to ${max}`);
  return n;
}

const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);

function window(v: Record<string, string | boolean | undefined>): PassWindow {
  const days = str(v.days) ?? "Daily";
  const hours = str(v.hours) ?? "00:00-24:00";
  const timeZone = str(v.tz) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!/^(Daily|\w{3}-\w{3}|\w{3}(,\w{3})*)$/.test(days)) throw new UsageError("--days is Daily, a range like Mon-Fri, or a list like Mon,Wed");
  if (!/^\d\d:\d\d-\d\d:\d\d$/.test(hours)) throw new UsageError("--hours is like 12:00-14:00");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new UsageError(`unknown time zone ${JSON.stringify(timeZone)}`);
  }
  return { days, hours, timeZone };
}

const relayDefault = (io: Io) => `ws://localhost:${io.env?.RELAY_PORT ?? 4361}/v1`;

const TITLES = {
  1: ["A door with no internet", "Rosa presents a guest pass to the Front Door over LoRa. The door checks it offline."],
  2: ["An attestation from the cabin", "Alice sends a Settle attestation over LoRa, through the Ridge, to the Lodge's gateway and the relay."],
  3: ["By hand", "The Lodge is down. The attestation leaves in a sealed file on a USB stick."],
} as const;

async function narrate(io: Io, act: 1 | 2 | 3, o: ActOptions): Promise<Trace> {
  const st = { color: io.color ?? false };
  const [title, about] = TITLES[act];
  io.out(actHeader(act, title, `${about}\nloss ${Math.round((o.loss ?? 0) * 100)}% · seed ${o.seed ?? 1} · simulated time`, st));
  const t = await (act === 1 ? act1 : act === 2 ? act2 : act3)({ ...o, ...printer(io.out, st) });
  io.out(summary(t, st));
  return t;
}

async function demo(args: string[], io: Io): Promise<number> {
  const { values: v } = parse(args, { act: { type: "string" }, loss: { type: "string" }, seed: { type: "string" } });
  const seed = num("seed", v.seed, 1, 0, 2 ** 31);
  const act = v.act === undefined ? undefined : (num("act", v.act, 1, 1, 3) as 1 | 2 | 3);
  const loss = v.loss === undefined ? undefined : num("loss", v.loss, 0, 0, 0.9);
  const runs: [1 | 2 | 3, ActOptions][] =
    act !== undefined
      ? [[act, { loss: loss ?? 0, seed }]]
      : loss !== undefined
        ? [[1, { loss, seed }], [2, { loss, seed }], [3, { loss, seed }]]
        : [
            [1, { loss: 0, seed, replay: false }],
            [1, { loss: 0.2, seed, replay: true }],
            [2, { loss: 0, seed }],
            [3, { loss: 0, seed }],
          ];
  const traces: Trace[] = [];
  for (const [n, o] of runs) {
    traces.push(await narrate(io, n, o));
    await new Promise((r) => setTimeout(r, io.color ? 250 : 0));
  }
  io.out("\nMeasured on the simulator (US915, SF8 at 500 kHz, 250-byte frames):");
  for (const t of traces) {
    const msg = t.log.find((l) => l.sizes)?.sizes;
    const sizes = msg ? `${msg.what}: ${fmtBytes(msg.jsonSealed)} as JSON TSP, ${fmtBytes(msg.compactSealed)} with CTT1${msg.packet ? `, ${fmtBytes(msg.packet.bytes)} ${msg.packet.kind.toUpperCase()} in ${msg.packet.frames} frames` : ""}` : "";
    io.out(`  Act ${t.act}, ${Math.round(t.loss * 100)}% loss: ${t.summary.ok ? "ok" : "FAILED"}, ${fmtMs(t.summary.airtimeMs)} airtime, ${t.summary.frames} frames, ${t.summary.retries} retries. ${sizes}`);
  }
  return traces.every((t) => t.summary.ok) ? 0 : 1;
}

const stateDir = (v: Record<string, string | boolean | undefined>, role: string) => {
  const d = str(v.state) ?? join(".data", role);
  mkdirSync(d, { recursive: true });
  return d;
};

async function withLink<T>(spec: Exclude<LinkSpec, { kind: "sim" }>, side: "gateway" | "node", plan: PlanName, io: Io, deps: CliDeps, fn: (l: OpenedLink) => Promise<T>): Promise<T> {
  const opened = await deps.openRealLink(spec, side, plan, { log: io.out });
  io.out(`radio: ${opened.describe}`);
  try {
    return await fn(opened);
  } finally {
    await opened.close();
  }
}

export async function runCli(argv: string[], io: Io, partial: Partial<CliDeps> = {}): Promise<number> {
  const deps: CliDeps = { openRealLink, runDoctor, startRelay, ...partial };
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(USAGE);
        return 0;
      case "demo":
        return await demo(rest, io);
      case "door":
      case "guest": {
        const { values: v } = parse(rest, { link: { type: "string" }, days: { type: "string" }, hours: { type: "string" }, tz: { type: "string" }, wait: { type: "string" }, once: { type: "boolean" } });
        const spec = parseLink(str(v.link));
        const plan = parsePlan(str(v.plan));
        const w = window(v);
        const waitMs = num("wait", v.wait, 60, 1, 3600) * 1000;
        if (spec.kind === "sim") {
          io.out(`--link sim: both ends of act 1 run here, on the simulator.`);
          return (await narrate(io, 1, { replay: false })).summary.ok ? 0 : 1;
        }
        if (command === "door") {
          const dir = stateDir(v, "door");
          await withLink(spec, "gateway", plan, io, deps, (l) => runDoor({ link: l.link, stateDir: dir, window: w, log: io.out, signal: io.signal, once: v.once === true }));
          return 0;
        }
        const answer = await withLink(spec, "node", plan, io, deps, (l) => runGuest({ link: l.link, window: w, waitMs, log: io.out }));
        return answer.open ? 0 : 1;
      }
      case "gateway": {
        const { values: v } = parse(rest, { link: { type: "string" }, relay: { type: "string" } });
        const spec = parseLink(str(v.link));
        const plan = parsePlan(str(v.plan));
        const dir = stateDir(v, "gateway");
        let relayUrl = str(v.relay);
        let local: Awaited<ReturnType<typeof startRelay>> | undefined;
        if (!relayUrl) {
          local = await deps.startRelay({ port: num("RELAY_PORT", io.env?.RELAY_PORT, 4361, 0, 65535), host: "127.0.0.1", dbPath: join(dir, "relay.db") });
          relayUrl = local.url;
          io.out(`started a TSP relay on this machine: ${relayUrl}`);
        }
        try {
          if (spec.kind === "sim") {
            io.out("--link sim: the Lodge on a simulated radio, in real time, with a simulated cabin that sends one attestation.");
            const r = await runGatewaySim({ relayUrl, stateDir: dir, log: io.out, signal: io.signal });
            return r.custody ? 0 : 1;
          }
          await withLink(spec, "gateway", plan, io, deps, (l) => runGateway({ link: l.link, relayUrl: relayUrl!, stateDir: dir, log: io.out, signal: io.signal }));
          return 0;
        } finally {
          await local?.close();
        }
      }
      case "attest": {
        const { values: v } = parse(rest, { link: { type: "string" }, payment: { type: "string" }, wait: { type: "string" } });
        const spec = parseLink(str(v.link));
        const plan = parsePlan(str(v.plan));
        const which = (str(v.payment) ?? "sink") as keyof typeof PAYMENTS;
        if (!(which in PAYMENTS)) throw new UsageError("--payment is sink or fan");
        const waitMs = num("wait", v.wait, 90, 0, 3600) * 1000;
        if (spec.kind === "sim") {
          io.out(`--link sim: act 2 runs here, on the simulator.`);
          return (await narrate(io, 2, {})).summary.ok ? 0 : 1;
        }
        const dir = stateDir(v, "alice");
        await withLink(spec, "node", plan, io, deps, (l) => runAttest({ link: l.link, stateDir: dir, waitMs, which, log: io.out }));
        return 0;
      }
      case "receive": {
        const { values: v } = parse(rest, { relay: { type: "string" }, once: { type: "boolean" } });
        await runReceive({ relayUrl: str(v.relay) ?? relayDefault(io), log: io.out, signal: io.signal, once: v.once === true });
        return 0;
      }
      case "doctor": {
        const { values: v } = parse(rest, { port: { type: "string" }, seconds: { type: "string" }, "tx-test": { type: "boolean" }, "rak-p2p": { type: "boolean" }, "no-serial": { type: "boolean" } });
        const report = await deps.runDoctor({
          udpPort: num("port", v.port, 1700, 0, 65535),
          seconds: num("seconds", v.seconds, 15, 1, 600),
          txTest: v["tx-test"] === true,
          rakP2p: v["rak-p2p"] === true,
          noSerial: v["no-serial"] === true,
          log: io.out,
        });
        io.out(formatReport(report));
        return report.ok ? 0 : 1;
      }
      case "bundle": {
        const [sub, ...more] = rest;
        if (sub === "export") {
          const { values: v } = parse(more, { "seal-to": { type: "string" }, unsealed: { type: "boolean" }, out: { type: "string" } });
          if (v.unsealed && v["seal-to"]) throw new UsageError("--unsealed and --seal-to don't go together");
          const dir = str(v.state) ?? join(".data", "alice");
          const out = str(v.out) ?? `alice-${new Date().toISOString().slice(0, 16).replace(/[:T-]/g, "")}.toipbundle`;
          await bundleExport({ stateDir: dir, sealTo: v.unsealed ? undefined : (str(v["seal-to"]) ?? "neighbor"), out, log: io.out });
          return 0;
        }
        if (sub === "import") {
          const { values: v, positionals } = parse(more, { relay: { type: "string" }, as: { type: "string" } }, 1);
          if (!positionals[0]) throw new UsageError("bundle import needs the bundle file");
          const r = await bundleImport({ file: positionals[0], relayUrl: str(v.relay) ?? relayDefault(io), as: str(v.as) ?? "neighbor", log: io.out });
          return r.refused ? 1 : 0;
        }
        throw new UsageError(sub ? `unknown bundle command ${JSON.stringify(sub)}: use export or import` : "bundle needs export or import");
      }
      default:
        throw new UsageError(`unknown command ${JSON.stringify(command)}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`mesh: ${e.message}\nRun with no arguments for help.`);
      return 2;
    }
    io.err(`mesh: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ctl = new AbortController();
  process.on("SIGINT", () => ctl.abort());
  process.on("SIGTERM", () => ctl.abort());
  const argv = process.argv.slice(2);
  const code = await runCli(argv, {
    out: (s) => console.log(s),
    err: (s) => console.error(s),
    color: process.stdout.isTTY && !argv.includes("--no-color") && !process.env.NO_COLOR,
    signal: ctl.signal,
    env: process.env,
  });
  process.exit(code);
}
