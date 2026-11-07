/**
 * `--link` for the CLI: `sim`, `gwmp[:PORT]` (a LoRaWAN gateway's packet forwarder, such as the RAK
 * miner's, sending to this machine) or `rak:PATH` (a RAK3172 on USB serial, stock RUI3 AT firmware).
 */
import { plans, type ChannelPlan, type Link } from "@zk-toip/mesh-transport";
import { GwmpServer, nodeSerialPort } from "@zk-toip/mesh-transport/node";
import { RakP2PLink } from "@zk-toip/mesh-transport/rak";
import type { SerialPortLike } from "@zk-toip/mesh-transport/serial";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type LinkSpec = { kind: "sim" } | { kind: "gwmp"; port: number } | { kind: "rak"; path: string };

export function parseLink(s: string | undefined): LinkSpec {
  if (!s) throw new UsageError("--link is required: sim, gwmp[:PORT] or rak:/dev/tty...");
  if (s === "sim") return { kind: "sim" };
  const g = /^gwmp(?::(\d+))?$/.exec(s);
  if (g) {
    const port = g[1] ? Number(g[1]) : 1700;
    if (!(port >= 1 && port <= 65535)) throw new UsageError(`bad UDP port in --link ${s}`);
    return { kind: "gwmp", port };
  }
  if (s.startsWith("rak:")) {
    const path = s.slice(4);
    if (!path) throw new UsageError("--link rak: needs the serial port, e.g. rak:/dev/tty.usbserial-0001");
    return { kind: "rak", path };
  }
  throw new UsageError(`unknown --link ${JSON.stringify(s)}: use sim, gwmp[:PORT] or rak:/dev/tty...`);
}

export type PlanName = "us915-b" | "us915-a";

export function parsePlan(s: string | undefined): PlanName {
  if (s === undefined || s === "us915-b") return "us915-b";
  if (s === "us915-a") return "us915-a";
  throw new UsageError(`unknown --plan ${JSON.stringify(s)}: use us915-b (the gateway's stock setup) or us915-a (one frequency)`);
}

/** The gateway side transmits where nodes listen (923.3 MHz on us915-b), and the other way round. */
export function planFor(plan: PlanName, side: "gateway" | "node"): ChannelPlan {
  if (plan === "us915-a") return plans["us915-a"];
  return side === "gateway" ? plans["us915-b-gateway"] : plans["us915-b-node"];
}

export interface OpenedLink {
  link: Link;
  describe: string;
  close(): Promise<void>;
}

export interface LinkDeps {
  serialPort?: (path: string) => SerialPortLike;
  log?: (s: string) => void;
  /** How long to wait for a packet forwarder's first PULL_DATA. */
  gatewayWaitMs?: number;
}

/** Opens a real radio link. `side` says which half of the channel plan this end uses. */
export async function openRealLink(spec: Exclude<LinkSpec, { kind: "sim" }>, side: "gateway" | "node", plan: PlanName, deps: LinkDeps = {}): Promise<OpenedLink> {
  const log = deps.log ?? (() => {});
  const p = planFor(plan, side);
  if (spec.kind === "gwmp") {
    if (side === "node" && plan === "us915-b")
      throw new UsageError("a LoRaWAN gateway transmits on 923.3 MHz and listens on 904.6 MHz: on plan us915-b it can only be the door or gateway side. Use rak:PATH for this end.");
    const server = new GwmpServer({ port: spec.port, plan: p, log });
    await server.start();
    log(`waiting for a packet forwarder on UDP ${server.port} (it sends PULL_DATA every 10 s)…`);
    const link = await new Promise<Link>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no packet forwarder on UDP ${server.port} after ${Math.round((deps.gatewayWaitMs ?? 60_000) / 1000)} s: run \`mesh doctor\``)), deps.gatewayWaitMs ?? 60_000);
      const off = server.onGateway((l) => {
        const ready = () => {
          clearTimeout(timer);
          off();
          resolve(l);
        };
        if (l.state === "open") ready();
        else l.onState((s) => s === "open" && ready());
      });
    }).catch(async (e) => {
      await server.stop();
      throw e;
    });
    return { link, describe: `${link.info.label} (${p.name}: TX ${p.tx.frequencyHz / 1e6} MHz, RX ${p.rx.frequencyHz / 1e6} MHz)`, close: () => server.stop() };
  }
  const port = (deps.serialPort ?? ((path) => nodeSerialPort(path)))(spec.path);
  const link = new RakP2PLink({ port, plan: p });
  await link.open();
  return { link, describe: `${link.info.label} (RUI3 ${link.version ?? "?"}, ${p.name}: TX ${p.tx.frequencyHz / 1e6} MHz, RX ${p.rx.frequencyHz / 1e6} MHz)`, close: () => link.close() };
}
