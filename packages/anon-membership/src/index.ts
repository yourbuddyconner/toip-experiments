// @toip-tools/anon-membership: prove "I am a member of one of these groups, my attributes meet these
// predicates, and this is my nullifier for this scope, bound to this signal" without saying which member.
// Runs in Node and in browsers; nothing here imports Node built-ins.

// Fields and hashing
export { FIELD_MODULUS, fieldFromBytes, fieldFromBytes32, fieldFromHex, fieldToBytes, fieldToHex, toField, type Field } from "./field.js";
export {
  MAX_LIMIT,
  NEVER_EXPIRES,
  TAG,
  commitmentOf,
  hash,
  initHashing,
  leafHash,
  nodeHash,
  nullifierOf,
  plainLeaf,
  poseidon2,
  type Leaf,
} from "./hash.js";
export {
  dayFromIso,
  dayOf,
  decodeMembershipCode,
  deriveSecret,
  encodeMembershipCode,
  groupFieldOf,
  groupIdOf,
  isoFromDay,
  memberSecret,
  messageOf,
  scopeOf,
  type ScopePart,
} from "./encode.js";

// The tree
export { DEPTH, GroupTree, verifyPath, zeroHashes, type Depth, type MerklePath } from "./tree.js";

// Root documents and the log
export {
  DAY_SECONDS,
  checkRootLog,
  epochIndex,
  epochOf,
  findEquivocation,
  rootDocHash,
  snapshotMatches,
  treeFromRoot,
  type GroupRoot,
  type RootLogCheck,
} from "./roots.js";

// The issuer
export {
  ENROLL,
  GroupIssuer,
  decodeLeaf,
  encodeLeaf,
  enroll,
  type EnrollRequest,
  type EnrollResponse,
  type Enrollment,
  type GroupIssuerState,
  type LeafFields,
  type LeafJson,
} from "./issuer.js";

// Statements, proving and verifying
export {
  checkStatement,
  decodeStatement,
  encodeStatement,
  sameStatement,
  simpleStatement,
  whyUnsatisfied,
  type Predicate,
  type Statement,
  type StatementJson,
  type Witness,
} from "./statement.js";
export { CIRCUIT_ID, loadArtifacts, vkHashOf, type CircuitArtifacts } from "./artifacts.js";
export { bundledCrs, type Crs, type CrsSource } from "./crs.js";
export {
  MembershipError,
  MembershipProver,
  MembershipVerifier,
  PROOF_SYSTEM,
  parseMembershipProof,
  type BackendOptions,
  type MembershipProof,
  type ProveProgress,
  type VerifyResult,
} from "./prove.js";
export { membershipInputs, type MembershipInputsOptions } from "./member.js";

// Acceptance and nullifiers
export { acceptMembership, type AcceptPolicy, type AcceptReason, type Acceptance } from "./accept.js";
export { NullifierBook, type NullifierBookState } from "./nullifiers.js";
