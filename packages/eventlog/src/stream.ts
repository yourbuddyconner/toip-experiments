/** CESR 1.0 text streams: each message followed by its attachments. */
import { fromUtf8, utf8 } from "@zk-toip/trust-core";
import { AttachmentReader, counter, decode, encode, encodeKeyRefSig, encodeSigGroup } from "./cesr";
import { hexNumber, parseMessage, readVersion } from "./said";
import type { Couple, Problem, SignedMessage } from "./types";
import { problem } from "./types";

/** The CESR text of a message's attachments. */
export function attachmentsOf(m: SignedMessage): string {
  let out = "";
  if (m.controllerSigs?.length) out += encodeSigGroup("-A", m.controllerSigs);
  if (m.keyRefSig) out += encodeKeyRefSig(m.keyRefSig);
  if (m.witnessSigs?.length) out += encodeSigGroup("-B", m.witnessSigs);
  if (m.couples?.length) out += counter("-C", m.couples.length) + m.couples.map(coupleText).join("");
  return out;
}

function coupleText(c: Couple): string {
  const { code } = decode(c.signer);
  return c.signer + encode(code === "1AAI" || code === "1AAJ" ? "0I" : "0B", c.sig);
}

export function toStream(msgs: SignedMessage[]): string {
  return msgs.map((m) => m.raw + attachmentsOf(m)).join("");
}

/** Builds a SignedMessage from raw text and attachment text. Throws on bad input. */
export function messageFrom(raw: string, attachments: string): SignedMessage {
  const r = fromStream(raw + attachments);
  if (r.problems.length || r.messages.length !== 1) throw new Error(r.problems[0]?.message ?? "expected one message");
  return r.messages[0];
}

/** Applies attachment text to a message. */
export function readAttachments(m: SignedMessage, text: string): void {
  const r = new AttachmentReader(text);
  while (!r.done()) {
    const c = r.counter();
    switch (c.code) {
      case "-V":
        break; // attachment group wrapper: its contents follow
      case "-A":
        m.controllerSigs = [...(m.controllerSigs ?? []), ...r.sigs(c.count)];
        break;
      case "-B":
        m.witnessSigs = [...(m.witnessSigs ?? []), ...r.sigs(c.count)];
        break;
      case "-C":
        for (let i = 0; i < c.count; i++) {
          const signer = r.primitive();
          const sig = decode(r.primitive());
          if (sig.code !== "0B" && sig.code !== "0I") throw new Error("receipt couple needs a 0B or 0I signature");
          (m.couples ??= []).push({ signer, sig: sig.raw });
        }
        break;
      case "-F":
        if (c.count !== 1 || m.keyRefSig) throw new Error("unsupported: more than one -F group");
        m.keyRefSig = r.keyRefSig();
        break;
      case "-E":
        for (let i = 0; i < c.count; i++) {
          r.primitive();
          r.primitive();
        }
        break;
      default:
        throw new Error(`unsupported attachment group ${c.code}`);
    }
  }
}

const isSpace = (b: number) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;

/** Parses a stream. Never throws: anything it can't read becomes a problem. */
export function fromStream(text: string): { messages: SignedMessage[]; problems: Problem[] } {
  const bytes = utf8(text);
  const messages: SignedMessage[] = [];
  const problems: Problem[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    if (isSpace(bytes[pos])) {
      pos++;
      continue;
    }
    if (bytes[pos] !== 0x7b) {
      problems.push(problem("badFields", `unexpected text at byte ${pos}`));
      break;
    }
    const head = fromUtf8(bytes.slice(pos, pos + 32));
    const v = readVersion(head);
    if (!v.ok) {
      problems.push(v.problem);
      break;
    }
    if (pos + v.size > bytes.length) {
      problems.push(problem("badVersion", "stream ends inside a message"));
      break;
    }
    const raw = fromUtf8(bytes.slice(pos, pos + v.size));
    pos += v.size;
    let end = pos;
    while (end < bytes.length && bytes[end] !== 0x7b && !isSpace(bytes[end])) end++;
    const attachments = fromUtf8(bytes.slice(pos, end));
    pos = end;
    const parsed = parseMessage(raw);
    if (!parsed.ok) {
      problems.push(parsed.problem);
      continue;
    }
    const b = parsed.msg.body;
    const m: SignedMessage = {
      t: parsed.msg.t,
      raw,
      body: b,
      logId: String(b.i),
      s: hexNumber(b.s)!,
      d: String(b.d),
    };
    try {
      readAttachments(m, attachments);
    } catch (e) {
      problems.push(problem("badFields", `bad attachments: ${e instanceof Error ? e.message : String(e)}`, m.logId, m.s));
      continue;
    }
    messages.push(m);
  }
  return { messages, problems };
}
