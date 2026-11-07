// Browser-safe core. JsonFileStore and serveHttp are in "@zk-toip/eventlog/node".
export * from "./types";
export {
  Code,
  encode,
  decode,
  isQb64,
  digest,
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
} from "./cesr";
export { saidify, makeBody, checkBody, versionString, parseMessage, type Protocol } from "./said";
export { toStream, fromStream, attachmentsOf } from "./stream";
export { toCompact, fromCompact, toCompactLog, fromCompactLog } from "./compact";
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
} from "./keys";
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
} from "./kel";
export { verifyTrail, TrailProcessor, buildTin, buildTen, buildTcl, buildTrc, type TrailResult, type TrailEntry, type EntryStatus, type TrailVerifyOptions } from "./trail";
export { Controller, Trail, type InceptOptions, type RotateOptions, type PublishReport } from "./controller";
export { WitnessError, type WitnessClient, type SubmitResult, type Refusal } from "./client";
export { Witness, localWitnessClient } from "./witness";
export { Watcher, verifyEvidence } from "./watcher";
export { makeReceipt, endorse } from "./receipts";
export { witnessHttpHandler, httpWitnessClient } from "./http";
export { TRAIL_TASKS, serveWitnessTasks, taskWitnessClient, disclose, onDisclose, reportDuplicity, onDuplicity } from "./tasks";
export { makeBinding, bindingSeal, bindingDigest, verifyBinding, type DidBinding } from "./binding";
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
} from "./verify";
export { MemoryStore, evidenceToJson, evidenceFromJson, type LogStore, type StoredMessage, type StoredReceipt, type StoreData } from "./store";
