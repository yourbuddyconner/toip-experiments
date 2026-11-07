/** Plain-language explanations of verification results. Browser-safe. */
import type { EntryStatus, ProblemCode } from "@zk-toip/eventlog";

export const PROBLEM_TEXT: Record<ProblemCode, string> = {
  badVersion: "The version string is malformed, or the length it states doesn't match the bytes.",
  badFields: "The message has fields that are missing, extra, out of order, or of the wrong form.",
  unsupported: "The message uses a KERI feature this library doesn't support. It is set aside, not judged invalid.",
  saidMismatch: "The message's SAID is not the hash of its bytes. The bytes were changed after the message was made.",
  badSequence: "The sequence numbers are not contiguous. An entry is missing, repeated or out of order.",
  badChain: "The entry doesn't name the previous entry's SAID as its prior. The chain is broken here.",
  abandoned: "The identifier was abandoned (a rotation with no next keys). Nothing may follow.",
  signatureInvalid: "A signature doesn't verify against the key state it names. Someone without the key changed or made this message.",
  thresholdNotMet: "There are fewer valid signatures than the key state's threshold.",
  nextKeyMismatch: "The rotation isn't signed by keys committed as next keys in the prior establishment event.",
  notWitnessed: "Fewer witnesses receipted it than the threshold requires. It is pending.",
  duplicity: "Two different signed versions exist at one place in the log. That is evidence someone showed different people different histories.",
  unknownKeyState: "The signature names a key state that is not in the identifier's KEL.",
  staleKeyState: "It is signed under an older key state than an entry before it, or than its checkpoint allows.",
  unsealedRotation: "A rotation retired this key state without sealing the trail. An honest controller never does this.",
  sealMismatch: "The KEL sealed a different entry at this position. This is not the trail the controller committed to.",
  timeReversed: "The entry claims a time earlier than the entry before it.",
  afterClose: "An entry follows the trail's close.",
  bodyMismatch: "The disclosed body doesn't hash to the digest in the header. The body was changed.",
  bindingInvalid: "The DID binding is missing, its signature fails, or it isn't sealed in the KEL.",
  truncated: "Entries are missing from the end. The KEL or a witness holds a later entry than the one shown.",
};

export const STATUS_TEXT: Record<EntryStatus | "rejected", string> = {
  valid: "Signed under a current key state, chained to the entry before it, and receipted by enough witnesses.",
  pending: "Signed and chained, but not yet receipted by enough witnesses.",
  cut: "Signed under a key state after a rotation had sealed this trail at an earlier entry. Kept and shown, but not valid.",
  invalid: "It fails a check. See the problems.",
  rejected: "It couldn't be read as a valid trail message, so it isn't part of the trail.",
};

export function explainProblem(code: ProblemCode): string {
  return PROBLEM_TEXT[code] ?? code;
}

export const short = (s: string, n = 8) => (s.length > n + 4 ? `${s.slice(0, n)}…` : s);
