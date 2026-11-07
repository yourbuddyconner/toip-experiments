// Inline SVG diagrams for the concepts page. Each has a title and a description for screen readers;
// colors come from the stylesheet (.dg-*), and text inherits the page's typeface.
import { esc, raw, type Raw } from "../build/html";

const W = 720;

function svg(id: string, h: number, title: string, desc: string, body: string): Raw {
  return raw(
    `<svg viewBox="0 0 ${W} ${h}" role="img" aria-labelledby="${id}-t ${id}-d" class="dg"><title id="${id}-t">${esc(title)}</title><desc id="${id}-d">${esc(desc)}</desc>${defs(id)}${body}</svg>`,
  );
}

const defs = (id: string) =>
  `<defs><marker id="${id}-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" class="dg-head"/></marker></defs>`;

function box(x: number, y: number, w: number, h: number, cls = "dg-box", r = 6): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" class="${cls}"/>`;
}

function text(x: number, y: number, s: string, cls = "", anchor: "start" | "middle" | "end" = "start"): string {
  return `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${esc(s)}</text>`;
}

function line(id: string, x1: number, y1: number, x2: number, y2: number, cls = "dg-line", arrow = true): string {
  return `<path d="M${x1} ${y1} L${x2} ${y2}" class="${cls}"${arrow ? ` marker-end="url(#${id}-a)"` : ""}/>`;
}

function path(id: string, d: string, cls = "dg-line", arrow = true): string {
  return `<path d="${d}" class="${cls}"${arrow ? ` marker-end="url(#${id}-a)"` : ""}/>`;
}

export function didDiagram(): Raw {
  const id = "dg-did";
  return svg(
    id,
    250,
    "Two ways to make an identifier from keys",
    "Top: an Ed25519 public key, prefixed with its multicodec and encoded in base58, becomes did:key:z6Mk followed by the key. Bottom: a KERI inception event lists the current key and a digest of the next key; the digest of the whole event becomes the AID, which can be written as did:keri followed by the AID.",
    [
      text(0, 22, "did:key", "dg-h"),
      box(0, 36, 210, 54),
      text(14, 60, "Ed25519 public key", "dg-t"),
      text(14, 78, "32 bytes", "dg-s"),
      line(id, 214, 63, 286, 63),
      text(250, 54, "encode", "dg-s", "middle"),
      box(292, 36, 428, 54, "dg-dark"),
      text(308, 69, "did:key:z6MkfkozPjJQsb11Szt73tYJ…", "dg-tl dg-mono"),
      text(0, 142, "KERI", "dg-h"),
      box(0, 156, 210, 82),
      text(14, 180, "Inception event", "dg-t"),
      text(14, 199, "current key", "dg-s"),
      text(14, 216, "digest of next key", "dg-s"),
      text(14, 233, "witnesses", "dg-s"),
      line(id, 214, 197, 286, 197),
      text(250, 188, "digest", "dg-s", "middle"),
      box(292, 170, 428, 54, "dg-dark"),
      text(308, 203, "AID  EHg4MO2lkvGBo-dOX3ERUPrhqhW…", "dg-tl dg-mono"),
    ].join(""),
  );
}

export function credentialDiagram(): Raw {
  const id = "dg-vc";
  return svg(
    id,
    270,
    "Issuer, holder, verifier, and a status list",
    "The garden, the issuer, signs a credential and gives it to Bob, the holder. Bob presents it to Alice, the verifier. Alice checks the garden's signature against the garden's DID, and reads the garden's signed status list, published anywhere, to see whether Bob's bit is set.",
    [
      box(0, 30, 180, 64),
      text(16, 56, "Issuer", "dg-t"),
      text(16, 76, "the garden", "dg-s"),
      box(270, 30, 180, 64),
      text(286, 56, "Holder", "dg-t"),
      text(286, 76, "Bob", "dg-s"),
      box(540, 30, 180, 64),
      text(556, 56, "Verifier", "dg-t"),
      text(556, 76, "Alice", "dg-s"),
      line(id, 184, 62, 266, 62),
      text(225, 52, "issues", "dg-s", "middle"),
      line(id, 454, 62, 536, 62),
      text(495, 52, "presents", "dg-s", "middle"),
      path(id, "M90 98 C 90 138, 600 138, 600 98", "dg-line dg-dash", false),
      text(345, 152, "Alice trusts the garden's DID for this kind of claim", "dg-s", "middle"),
      box(0, 196, 300, 62, "dg-dark"),
      text(14, 218, "Status list, signed by the garden", "dg-tl"),
      ...Array.from({ length: 16 }, (_, i) => box(14 + i * 17, 230, 13, 16, i === 5 ? "dg-bit-on" : "dg-bit", 2)),
      path(id, "M660 98 C 670 210, 420 230, 304 228", "dg-line"),
      text(470, 248, "reads bit 5", "dg-s", "middle"),
    ].join(""),
  );
}

export function tspDiagram(): Raw {
  const id = "dg-tsp";
  return svg(
    id,
    250,
    "A TSP message between two agents, through a relay",
    "Alice's agent signs and seals a message and sends it through a relay to Bob's agent. The message has four parts: the sender's identifier and the receiver's identifier, both readable, the sealed payload, and the signature. The relay can read only the two identifiers, the size and the time.",
    [
      box(0, 20, 150, 60),
      text(16, 46, "Alice's agent", "dg-t"),
      text(16, 66, "signs, seals", "dg-s"),
      box(285, 20, 150, 60, "dg-box dg-soft"),
      text(301, 46, "Relay", "dg-t"),
      text(301, 66, "stores, forwards", "dg-s"),
      box(570, 20, 150, 60),
      text(586, 46, "Bob's agent", "dg-t"),
      text(586, 66, "verifies, opens", "dg-s"),
      line(id, 154, 50, 281, 50),
      line(id, 439, 50, 566, 50),
      box(60, 120, 120, 44, "dg-dark", 3),
      text(120, 147, "from: VID", "dg-tl dg-mono", "middle"),
      box(184, 120, 120, 44, "dg-dark", 3),
      text(244, 147, "to: VID", "dg-tl dg-mono", "middle"),
      box(308, 120, 230, 44, "dg-sealed", 3),
      text(423, 147, "payload, sealed (HPKE)", "dg-tl", "middle"),
      box(542, 120, 118, 44, "dg-dark", 3),
      text(601, 147, "signature", "dg-tl", "middle"),
      path(id, "M60 174 H304", "dg-line dg-ok", false),
      text(182, 194, "readable by anyone carrying it", "dg-s", "middle"),
      path(id, "M308 174 H538", "dg-line dg-dash", false),
      text(423, 194, "only Bob's key opens it", "dg-s", "middle"),
      path(id, "M542 174 H660", "dg-line", false),
      text(601, 194, "proves Alice sent all of it", "dg-s", "middle"),
      text(360, 236, "The relay learns: who to whom, when, how many bytes.", "dg-s", "middle"),
    ].join(""),
  );
}

export function taskDiagram(): Raw {
  const id = "dg-task";
  const rows = [
    ["id", "urn:uuid:63e64c74-…"],
    ["type", "https://toip.tools/spec/…/0.1"],
    ["issuer", "did:key:z6Mkfk…"],
    ["recipient", "did:key:z6MkoY…"],
    ["issuedAt", "2026-11-07T02:24:07Z"],
    ["payload", "{ … }"],
    ["proof", "eddsa-jcs-2022"],
  ];
  return svg(
    id,
    260,
    "A Trust Task document and its response",
    "A request document has an id, a type URI, an issuer, a recipient, an issue time, a payload and a proof. The response has the same type with #response appended, a threadId pointing at the request's id, and its own proof by the responder.",
    [
      box(0, 10, 340, 236),
      text(16, 36, "Request", "dg-t"),
      ...rows.map(([k, v], i) => text(16, 64 + i * 26, k, "dg-s") + text(110, 64 + i * 26, v, "dg-mono dg-v")),
      line(id, 346, 128, 374, 128),
      box(380, 10, 340, 236),
      text(396, 36, "Response", "dg-t"),
      text(396, 64, "type", "dg-s"),
      text(476, 64, "…/0.1#response", "dg-mono dg-v"),
      text(396, 90, "threadId", "dg-s"),
      text(476, 90, "the request's id", "dg-v"),
      text(396, 116, "issuer", "dg-s"),
      text(476, 116, "the recipient", "dg-v"),
      text(396, 142, "payload", "dg-s"),
      text(476, 142, "the answer, or", "dg-v"),
      text(476, 160, "a signed error", "dg-v"),
      text(396, 186, "proof", "dg-s"),
      text(476, 186, "by the responder", "dg-v"),
    ].join(""),
  );
}

export function governanceDiagram(): Raw {
  const id = "dg-gov";
  return svg(
    id,
    230,
    "Governance decides which signers count",
    "A community's governance document, signed by the community, says which DIDs may issue which kinds of credential. A verifier that holds a credential asks: is this issuer allowed to say this? A trust registry, or a list the verifier pinned, answers yes or no.",
    [
      box(0, 20, 250, 110, "dg-dark"),
      text(16, 46, "Governance document", "dg-tl"),
      text(16, 72, "who may issue what", "dg-tld"),
      text(16, 92, "how members join and leave", "dg-tld"),
      text(16, 112, "signed by the community", "dg-tld"),
      box(470, 20, 250, 110),
      text(486, 46, "Verifier", "dg-t"),
      text(486, 72, "holds a credential from", "dg-s"),
      text(486, 92, "did:key:z6Mk… about Bob", "dg-s dg-mono"),
      box(235, 160, 250, 56, "dg-box dg-soft"),
      text(251, 184, "Trust registry or pinned list", "dg-t"),
      text(251, 204, "answers from the document", "dg-s"),
      path(id, "M126 134 C 126 180, 180 188, 231 188"),
      path(id, "M596 134 C 596 180, 540 188, 489 188"),
      text(560, 154, "is this issuer allowed?", "dg-s", "end"),
    ].join(""),
  );
}

export function keriDiagram(): Raw {
  const id = "dg-keri";
  const ev = (x: number, t: string, s: string, sub: string) => box(x, 30, 150, 74) + text(x + 14, 56, t, "dg-t dg-mono") + text(x + 14, 76, s, "dg-s") + text(x + 14, 94, sub, "dg-s");
  return svg(
    id,
    270,
    "A KERI key event log with witnesses",
    "Four events in a chain: inception, interaction, rotation, interaction. Inception sets key 1 and commits to a digest of key 2. Rotation reveals key 2 and commits to key 3. Three witnesses receipt each event, keeping only the first version they see; a watcher compares what different witnesses hold.",
    [
      ev(0, "icp", "key 1", "commits to key 2"),
      ev(190, "ixn", "signed by key 1", "anchors data"),
      ev(380, "rot", "reveals key 2", "commits to key 3"),
      ev(570, "ixn", "signed by key 2", "anchors data"),
      line(id, 154, 67, 186, 67),
      line(id, 344, 67, 376, 67),
      line(id, 534, 67, 566, 67),
      ...[0, 1, 2].map((i) => box(90 + i * 200, 170, 140, 40, "dg-box dg-soft") + text(160 + i * 200, 195, `witness ${i + 1}`, "dg-t", "middle")),
      ...[0, 1, 2].map((i) => path(id, `M${160 + i * 200} 166 L${160 + i * 200} 110`, "dg-line dg-dash")),
      text(176, 142, "receipt first versions", "dg-s"),
      text(360, 250, "A watcher compares witnesses; two versions of one event is duplicity, and it's evidence.", "dg-s", "middle"),
    ].join(""),
  );
}

export function zkDiagram(): Raw {
  const id = "dg-zk";
  const leaves = Array.from({ length: 8 }, (_, i) => i);
  return svg(
    id,
    280,
    "Proving membership without saying which member",
    "An issuer keeps a Merkle tree of members' commitments and signs its root. A member proves their commitment is one of the leaves under that signed root, and outputs a nullifier for this scope. The verifier sees the root, the nullifier and the message the proof is bound to, but not which leaf.",
    [
      box(250, 10, 220, 40, "dg-dark"),
      text(360, 35, "root, signed by the issuer", "dg-tl", "middle"),
      ...[0, 1].map((i) => box(130 + i * 280, 80, 180, 30, "dg-box dg-soft", 4)),
      line(id, 220, 80, 330, 54, "dg-line", false),
      line(id, 500, 80, 390, 54, "dg-line", false),
      ...leaves.map((i) => box(40 + i * 82, 150, 70, 34, i === 5 ? "dg-box dg-secret" : "dg-box", 4) + text(75 + i * 82, 172, i === 5 ? "you" : "C", "dg-s", "middle")),
      ...leaves.map((i) => line(id, 75 + i * 82, 150, i < 4 ? 220 : 500, 112, "dg-line dg-thin", false)),
      box(0, 214, 720, 56, "dg-box dg-soft"),
      text(16, 238, "The verifier learns: a member of this group, under this root, says this,", "dg-t"),
      text(16, 258, "and this nullifier is theirs for this scope. Not which leaf.", "dg-t"),
    ].join(""),
  );
}
