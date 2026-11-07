// Browser-safe core. JsonFileStore and serveHttp are in "@toip-tools/eventlog/node".
export * from "./types.js";
export {
  Code,
  encode,
  decode,
  isQb64,
  digest,
  digestSeal,
  nextKeyDigest,
  nonTransferableAid,
  didKeyOf,
  aidOfDidKey,
  aidDid,
  aidOfDid,
  encodeIndexedSig,
  decodeIndexedSig,
  encodeKeyRefSig,
  decodeKeyRefSig,
} from "./cesr.js";
export { saidify, makeBody, checkBody, versionString, parseMessage, type Protocol } from "./said.js";
export { toStream, fromStream, attachmentsOf } from "./stream.js";
export { toCompact, fromCompact, toCompactLog, fromCompactLog } from "./compact.js";
export {
  ed25519Signer,
  p256Signer,
  signerFromIdentity,
  webCryptoSigner,
  webAuthnSigner,
  coldKeysFromSeed,
  keyQb64,
  verifyKeySig,
  type Signer,
  type Curve,
  type ColdKeys,
  type WrappedSignature,
  type WebAuthnAssertion,
  type WebAuthnPolicy,
  type SigOptions,
} from "./keys.js";
export {
  verifyKel,
  KelProcessor,
  keyAt,
  retiredAt,
  isCurrentAt,
  stateOf,
  buildIcp,
  buildRot,
  buildIxn,
  buildRct,
  type KeyState,
  type KelResult,
  type KelEvent,
  type VerifyOptions,
  type EventStatus,
} from "./kel.js";
export { verifyTrail, TrailProcessor, buildTin, buildTen, buildTcl, buildTrc, type TrailResult, type TrailEntry, type EntryStatus, type TrailVerifyOptions } from "./trail.js";
export { Controller, Trail, type InceptOptions, type RotateOptions, type PublishReport } from "./controller.js";
export { WitnessError, type WitnessClient, type SubmitResult, type Refusal } from "./client.js";
export { Witness, localWitnessClient } from "./witness.js";
export { Watcher, verifyEvidence } from "./watcher.js";
export { makeReceipt, endorse } from "./receipts.js";
export { witnessHttpHandler, httpWitnessClient } from "./http.js";
export { TRAIL_TASKS, serveWitnessTasks, taskWitnessClient, disclose, onDisclose, reportDuplicity, onDuplicity } from "./tasks.js";
export { makeBinding, bindingSeal, bindingDigest, verifyBinding, type DidBinding } from "./binding.js";
export {
  verifySignature,
  anchoredIn,
  exportBundle,
  verifyBundle,
  checkTrailRef,
  fetchTrail,
  type Bundle,
  type BundleResult,
  type SignatureCheck,
  type TrailRefCheck,
  type Anchor,
} from "./verify.js";
export { MemoryStore, evidenceToJson, evidenceFromJson, type LogStore, type StoredMessage, type StoredReceipt, type StoreData } from "./store.js";
