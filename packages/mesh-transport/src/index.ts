// "@toip-tools/mesh-transport": runs in browsers and Node. Node-only adapters are under ./gwmp, ./node and ./detect.
export { realScheduler, VirtualScheduler, type Scheduler } from "./scheduler.js";
export type { Link, LinkInfo, LinkState, ReceivedFrame } from "./link.js";
export { LinkEvents } from "./link.js";
export {
  AirtimeBudget,
  loraAirtimeMs,
  maxBytesUnder,
  planMtu,
  plans,
  regions,
  US915_DOWN,
  US915_UP,
  type AirtimePolicy,
  type ChannelPlan,
  type LoRaSetting,
  type TrafficClass,
} from "./airtime.js";
export {
  MeshTransport,
  memoryContacts,
  memoryOutbox,
  type BeaconInfo,
  type Contact,
  type ContactStore,
  type MeshEvent,
  type MeshOptions,
  type MeshOutboxItem,
  type MeshOutboxStore,
  type MeshStats,
  type ViaArrival,
} from "./mesh.js";
export { ChallengeBeacon } from "./beacon.js";
export { MeshGateway, memoryGatewayStore, type GatewayStore, type RelayLike } from "./gateway.js";
export { exportBundle, openBundle, postBundle, type BundleItem } from "./bundle.js";
export { joinTsp, splitTsp, tspSignatureValid, type TspParts } from "./tsp.js";
export { decodePacket, encodePacket, packetId, custodyMessage, type Packet, type PacketKind } from "./packet.js";
export { decodeFrame, encodeFrame, fragment, estimate, FRAME_HEADER, MAX_FRAGMENTS, type Frame } from "./frame.js";
export { addressTag, ackMac, keyHint, pairKeys, receiptMac, receiptTag, sealSender, openSender, sealRoute, openRoute, vidForm, readVidForm } from "./keys.js";
