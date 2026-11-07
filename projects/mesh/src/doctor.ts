/**
 * `mesh doctor`: the hardware bring-up helper (HARDWARE.md). It checks, in order:
 *
 *   1. that a LoRaWAN gateway's packet forwarder (the RAK miner's) is talking to this machine over UDP:
 *      PUSH_DATA (uplink) and PULL_DATA (the downlink path), and optionally that it accepts a transmission;
 *   2. what is on each USB serial port (RUI3, RNode, Meshtastic, Seeed, or silence);
 *   3. optionally, that a RAK3172 accepts the P2P settings of plan us915-b.
 *
 * Then it says what to fix, or what to run next. It uses the library's GWMP server and radio probes.
 */
import { networkInterfaces } from "node:os";
import { plans, type ReceivedFrame } from "@toip-tools/mesh-transport";
import { GwmpServer, listSerialPorts, nodeSerialPort, probeSerial, type GwmpLink, type RadioDetection } from "@toip-tools/mesh-transport/node";
import { RakP2PLink } from "@toip-tools/mesh-transport/rak";
import type { SerialPortLike } from "@toip-tools/mesh-transport/serial";

export interface DoctorOptions {
  udpPort?: number;
  /** Where to listen. Default every interface, since the miner is on the LAN. */
  udpHost?: string;
  /** How long to listen for the packet forwarder. PULL_DATA comes every 10 s by default. */
  seconds?: number;
  /** Ask the gateway to transmit one short test frame (it goes on the air). */
  txTest?: boolean;
  /** Switch each RAK3172 found to LoRa P2P mode with plan us915-b, to check it accepts the settings. */
  rakP2p?: boolean;
  /** Skip the serial ports. */
  noSerial?: boolean;
  log?: (line: string) => void;
  onListening?: (port: number) => void;
  listPorts?: () => Promise<{ path: string; vendorId?: string; productId?: string; hint?: string }[]>;
  openPort?: (path: string) => SerialPortLike;
  probe?: { listenMs?: number; probeMs?: number };
  rakOptions?: { commandTimeoutMs?: number; restartWaitMs?: number };
}

export interface GatewayCheck {
  eui: string;
  /** PULL_DATA seen: we can send it frames. */
  downlink: boolean;
  /** LoRa packets it forwarded to us while we listened. */
  heard: { bytes: number; rssi?: number; snr?: number; frequencyHz?: number }[];
  tx?: "ok" | string;
}

export interface DoctorReport {
  udpPort: number;
  gateways: GatewayCheck[];
  ports: { path: string; hint?: string; found: RadioDetection; p2p?: "ok" | string }[];
  problems: string[];
  next: string[];
  ok: boolean;
}

const lanAddresses = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((a): a is NonNullable<typeof a> => !!a && a.family === "IPv4" && !a.internal)
    .map((a) => a.address);

export async function runDoctor(o: DoctorOptions = {}): Promise<DoctorReport> {
  const log = o.log ?? (() => {});
  const seconds = o.seconds ?? 15;
  const problems: string[] = [];
  const next: string[] = [];
  const gateways = new Map<string, GatewayCheck>();
  const links = new Map<string, GwmpLink>();

  // ------------------------------------------------------------ 1. the packet forwarder
  const server = new GwmpServer({ port: o.udpPort ?? 1700, host: o.udpHost, plan: plans["us915-b-gateway"], txAckTimeoutMs: 1500, log: (s) => /ignored|bad PUSH/.test(s) && log(`  ${s}`) });
  let udpPort = o.udpPort ?? 1700;
  let listening = false;
  try {
    await server.start();
    udpPort = server.port;
    listening = true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    problems.push(
      code === "EADDRINUSE"
        ? `UDP port ${udpPort} is in use by another program, perhaps a running \`mesh gateway\` or \`mesh door\`. Stop it, or use --port.`
        : `can't listen on UDP ${udpPort}: ${(e as Error).message}`,
    );
  }
  if (listening) {
    log(`Listening for a packet forwarder on UDP ${udpPort} for ${seconds} s…`);
    o.onListening?.(udpPort);
    server.onGateway((link) => {
      const g: GatewayCheck = { eui: link.eui, downlink: link.state === "open", heard: [] };
      gateways.set(link.eui, g);
      links.set(link.eui, link);
      log(`  heard from gateway ${link.eui}`);
      link.onState((s) => {
        if (s === "open" && !g.downlink) {
          g.downlink = true;
          log(`  ${link.eui}: PULL_DATA, so the downlink path is open`);
        }
      });
      link.onFrame((f: ReceivedFrame) => {
        g.heard.push({ bytes: f.bytes.length, rssi: f.rssi, snr: f.snr, frequencyHz: f.frequencyHz });
        log(`  ${link.eui}: forwarded a ${f.bytes.length}-byte LoRa packet at ${f.frequencyHz ? (f.frequencyHz / 1e6).toFixed(1) + " MHz" : "?"}, RSSI ${f.rssi} dBm, SNR ${f.snr} dB`);
      });
    });
    const end = Date.now() + seconds * 1000;
    // Stop early once every gateway heard from has shown its downlink path too.
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 100));
      if (gateways.size && [...gateways.values()].every((g) => g.downlink)) break;
    }
    if (o.txTest) {
      for (const [eui, link] of links) {
        const g = gateways.get(eui)!;
        if (!g.downlink) continue;
        try {
          // 12 bytes that no mesh node takes for a frame of ours (they start with 0x5A, not 0xA_).
          await link.send(new TextEncoder().encode("ZK-TOIP TEST"));
          g.tx = "ok";
          log(`  ${eui}: transmitted a test frame on ${plans["us915-b-gateway"].tx.frequencyHz / 1e6} MHz (TX_ACK: NONE)`);
        } catch (e) {
          g.tx = (e as Error).message;
          log(`  ${eui}: test transmission failed: ${g.tx}`);
        }
      }
    }
    await server.stop();
  }
  if (listening && gateways.size === 0) {
    const ips = lanAddresses();
    problems.push(
      [
        `no packet forwarder sent anything to UDP ${udpPort} in ${seconds} s. On the miner:`,
        `  - is the forwarder running? \`docker ps\` should list udp-packet-forwarder; \`docker logs udp-packet-forwarder\` shows its errors;`,
        `  - SERVER_HOST must be this machine's address${ips.length ? ` (${ips.join(", ")})` : ""}, and SERVER_PORT ${udpPort};`,
        `  - MODEL must match the concentrator (RAK7248 for a RAK2287 HAT, RAK2245 for a RAK2245 HAT), and BAND us_902_928;`,
        `  - this machine's firewall must let UDP ${udpPort} in.`,
      ].join("\n"),
    );
  }
  for (const g of gateways.values()) {
    if (!g.downlink)
      problems.push(`gateway ${g.eui} sends PUSH_DATA but no PULL_DATA: we can hear through it but not transmit. Check serv_port_down (SERVER_PORT) in its configuration.`);
    if (g.tx && g.tx !== "ok") {
      if (/TX_FREQ/.test(g.tx)) problems.push(`gateway ${g.eui} refused to transmit on 923.3 MHz (TX_FREQ): its tx_freq_min/tx_freq_max must include it. The stock US915 configuration (923.0–928.0 MHz) does.`);
      else if (/TX_POWER/.test(g.tx)) problems.push(`gateway ${g.eui} refused the power (TX_POWER): its power table doesn't have 20 dBm.`);
      else if (/no TX_ACK/.test(g.tx)) problems.push(`gateway ${g.eui} didn't answer the transmission with TX_ACK. Old forwarders don't send TX_ACK; RAK's container does. Check its log.`);
      else problems.push(`gateway ${g.eui}: ${g.tx}`);
    }
  }

  // ------------------------------------------------------------ 2. serial ports
  const ports: DoctorReport["ports"] = [];
  if (!o.noSerial) {
    const list = await (o.listPorts ?? (() => listSerialPorts()))().catch(() => []);
    const open = o.openPort ?? ((path: string) => nodeSerialPort(path));
    log(list.length ? `Probing ${list.length} serial port${list.length === 1 ? "" : "s"}…` : "No serial ports found.");
    for (const p of list) {
      let found: RadioDetection;
      try {
        found = await probeSerial(open(p.path), o.probe);
      } catch (e) {
        found = { kind: "unknown", port: p.path, heard: `could not open: ${(e as Error).message}` };
      }
      const entry: DoctorReport["ports"][number] = { path: p.path, ...(p.hint ? { hint: p.hint } : {}), found };
      ports.push(entry);
      log(`  ${p.path}${p.hint ? ` (${p.hint})` : ""}: ${describe(found)}`);
      if (found.kind === "rak-rui3" && o.rakP2p) {
        const link = new RakP2PLink({ port: open(p.path), plan: plans["us915-b-node"], ...o.rakOptions });
        try {
          await link.open();
          entry.p2p = "ok";
          log(`  ${p.path}: LoRa P2P mode, transmit 904.6 MHz, listen 923.3 MHz, SF8, 500 kHz, public sync word: accepted`);
        } catch (e) {
          entry.p2p = (e as Error).message;
          problems.push(`${p.path}: the RAK3172 didn't accept the P2P settings (${entry.p2p}). Boards with and without a TCXO need different RUI3 builds; check the firmware matches the board.`);
        } finally {
          await link.close().catch(() => {});
        }
      }
      if (found.kind === "meshtastic") problems.push(`${p.path} runs Meshtastic firmware. This project doesn't use Meshtastic: flash RAK's stock RUI3 firmware, or use another board.`);
      if (found.kind === "rnode") problems.push(`${p.path} is an RNode. RNode support isn't built yet; use a RAK3172 with RUI3 firmware.`);
      if (found.kind === "seeed-at") problems.push(`${p.path} is a Seeed LoRa-E5 style AT modem. Only RAK's RUI3 AT firmware is supported.`);
    }
    if (!list.length) problems.push("no USB serial ports: plug in the RAK3172 by USB (a data cable, not a charge-only one). On macOS it shows up as /dev/tty.usbserial-* or /dev/tty.usbmodem*.");
    else if (!ports.some((p) => p.found.kind === "rak-rui3"))
      problems.push("no RAK3172 answered AT on any port. Check: 115200 baud; the board is powered; press its reset button and run doctor again. A board in LoRaWAN mode still answers AT.");
  }

  // ------------------------------------------------------------ 3. what next
  const rak = ports.find((p) => p.found.kind === "rak-rui3");
  const gw = [...gateways.values()].find((g) => g.downlink);
  if (gw) next.push(`mesh door --link gwmp${udpPort === 1700 ? "" : `:${udpPort}`}        (the door's radio is the miner)`);
  if (rak) next.push(`mesh guest --link rak:${rak.path}        (Rosa's radio is the RAK3172)`);
  if (gw && rak) next.push("Run them in two terminals: the guest waits for the door's beacon, then presents the pass.");
  return { udpPort, gateways: [...gateways.values()], ports, problems, next, ok: problems.length === 0 };
}

function describe(d: RadioDetection): string {
  switch (d.kind) {
    case "rak-rui3":
      return `RAK RUI3 AT firmware, ${d.version}`;
    case "seeed-at":
      return `Seeed AT firmware ${d.version}`;
    case "rnode":
      return `RNode firmware ${d.firmware}`;
    case "meshtastic":
      return "Meshtastic firmware";
    case "gwmp-gateway":
      return `gateway ${d.eui}`;
    case "unknown":
      return d.heard ? `unknown: heard ${JSON.stringify(d.heard.slice(0, 60))}` : "silent";
  }
}

export function formatReport(r: DoctorReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(r.gateways.length ? `Gateways on UDP ${r.udpPort}:` : `Gateways on UDP ${r.udpPort}: none`);
  for (const g of r.gateways)
    lines.push(`  ${g.eui}  downlink ${g.downlink ? "yes" : "NO"}  packets heard ${g.heard.length}${g.tx ? `  test transmission ${g.tx === "ok" ? "ok" : "FAILED"}` : ""}`);
  if (r.ports.length) {
    lines.push("Serial ports:");
    for (const p of r.ports) lines.push(`  ${p.path}  ${describe(p.found)}${p.p2p ? `  P2P ${p.p2p === "ok" ? "ok" : "FAILED"}` : ""}`);
  }
  if (r.problems.length) {
    lines.push("");
    lines.push("To fix:");
    for (const p of r.problems) lines.push(`  • ${p.replace(/\n/g, "\n    ")}`);
  }
  if (r.next.length) {
    lines.push("");
    lines.push("Next:");
    for (const n of r.next) lines.push(`  ${n}`);
  }
  lines.push("");
  lines.push(r.ok ? "Everything found works." : "Some things need fixing (above).");
  return lines.join("\n");
}
