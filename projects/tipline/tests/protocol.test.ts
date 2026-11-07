import { describe, expect, it } from "vitest";
import { Bus, CoarseClock, DemoClock, Endpoint, identityFromSeed, seedFrom } from "@toip-tools/trust-core";
import { decodeTipCode, encodeTipCode, newTipCode, tipKeys } from "../src/protocol/codes";
import { CHUNK, SUBMIT, bodyHash, presentSignal, tipScope, tipSignal } from "../src/protocol/messages";
import { CHUNK_BYTES, SOURCE_WIRE_BYTES, randomBytes, dropboxSize, joinChunks, paddedChunkCount, padChunk, sealPadded, splitAttachment, sourceSize } from "../src/protocol/padding";
import { signDescriptor, storyOpen, verifyDescriptor } from "../src/protocol/descriptor";
import { findMetadata, stripMetadata, imageKind, otherFileWarnings } from "../src/sanitize/metadata";
import { pngWithMetadata, syntheticJpeg, withExif } from "./fixtures/images";

describe("tip codes", () => {
  it("are 28 characters in groups of 4 and give the same DID and tip id every time", () => {
    const code = newTipCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
    const a = tipKeys(code);
    const b = tipKeys(code.toLowerCase().replace(/-/g, " "));
    expect(a.identity.did).toBe(b.identity.did);
    expect(a.tipId).toBe(b.tipId);
    expect(a.tipId).toMatch(/^urn:tipline:[0-9a-f]{32}$/);
    expect(a.identity.did.startsWith("did:key:z6Mk")).toBe(true);
    expect(tipKeys(newTipCode()).identity.did).not.toBe(a.identity.did);
  });

  it("catch typos", () => {
    const bytes = new Uint8Array(16).map((_, i) => i * 7);
    const code = encodeTipCode(bytes);
    expect(decodeTipCode(code)).toEqual(bytes);
    let caught = 0;
    const plain = code.replace(/-/g, "");
    for (let i = 0; i < plain.length - 1; i++) {
      const ch = plain[i] === "7" ? "8" : "7";
      const typo = plain.slice(0, i) + ch + plain.slice(i + 1);
      if (decodeTipCode(typo) === null) caught++;
    }
    // One check byte: almost every single-character typo is caught; a few may slip through at 1 in 256.
    expect(caught).toBeGreaterThanOrEqual(plain.length - 3);
    expect(decodeTipCode(plain.slice(0, -1))).toBeNull();
    expect(() => tipKeys("NOPE")).toThrow(/typo/);
  });

  it("read O as 0 and I or L as 1", () => {
    const code = encodeTipCode(new Uint8Array(16));
    expect(decodeTipCode(code.replace(/0/g, "O"))).toEqual(new Uint8Array(16));
  });
});

describe("message binding", () => {
  const base = {
    dropbox: "did:key:z6MkDropbox",
    story: "acme-valve-failures",
    tipId: "urn:tipline:00",
    replyTo: "did:key:z6MkTip",
    body: { subject: "Valves", text: "The log was changed." },
    attachments: [{ id: "a1", sha256: "ab".repeat(32), bytes: 100 }],
  };
  it("changes when any bound field changes", () => {
    const s = tipSignal(base);
    expect(tipSignal({ ...base })).toBe(s);
    for (const changed of [
      { ...base, replyTo: "did:key:z6MkOther" },
      { ...base, tipId: "urn:tipline:01" },
      { ...base, story: "other" },
      { ...base, dropbox: "did:key:z6MkOther" },
      { ...base, body: { ...base.body, text: "The log was not changed." } },
      { ...base, attachments: [{ ...base.attachments[0], sha256: "cd".repeat(32) }] },
      { ...base, attachments: [{ ...base.attachments[0], bytes: 101 }] },
      { ...base, attachments: [] },
    ]) {
      expect(tipSignal(changed)).not.toBe(s);
    }
    expect(presentSignal({ ...base, challenge: "x" })).not.toBe(s);
  });
  it("has one scope per drop box and story", () => {
    expect(tipScope("did:key:a", "s1")).toBe(tipScope("did:key:a", "s1"));
    expect(tipScope("did:key:a", "s1")).not.toBe(tipScope("did:key:a", "s2"));
    expect(tipScope("did:key:a", "s1")).not.toBe(tipScope("did:key:b", "s1"));
  });
  it("hashes the body canonically", () => {
    expect(bodyHash({ subject: "a", text: "b" })).toBe(bodyHash({ text: "b", subject: "a" } as never));
  });
});

describe("chunks and padding", () => {
  const clock = new DemoClock("2026-11-06T10:00:00Z");
  const bus = new Bus(clock);
  const tip = new Endpoint({ identity: identityFromSeed(seedFrom("p/tip")), transport: bus, clock: new CoarseClock(clock) });
  const dropbox = identityFromSeed(seedFrom("p/dropbox")).did;

  it("pads chunk counts to powers of two", () => {
    expect([0, 1, 2, 3, 4, 5, 9, 128].map(paddedChunkCount)).toEqual([1, 1, 2, 4, 4, 8, 16, 128]);
    expect(() => paddedChunkCount(129)).toThrow();
  });

  it("cuts attachments into equal chunks and joins them back", () => {
    const file = randomBytes(CHUNK_BYTES * 2 + 1000);
    const chunks = splitAttachment("t", "a1", file);
    expect(chunks.map((c) => c.count)).toEqual([3, 3, 3]);
    const pieces = chunks.map((c) => Uint8Array.from(atob(c.data.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)));
    expect(pieces.every((p) => p.length === CHUNK_BYTES)).toBe(true);
    expect(joinChunks(pieces, file.length)).toEqual(file);
  });

  it("makes every message a source sends exactly the same size on the wire", async () => {
    const sizes = new Set<number>();
    const file = crypto.getRandomValues(new Uint8Array(5000));
    for (const c of [...splitAttachment("t", "a1", file), padChunk("t", 1, 2)]) sizes.add((await sealPadded(tip, dropbox, CHUNK, c, sourceSize)).length);
    sizes.add((await sealPadded(tip, dropbox, SUBMIT, { v: 1, tipId: "t", body: { subject: "s", text: "x".repeat(20_000) } }, sourceSize)).length);
    sizes.add((await sealPadded(tip, dropbox, SUBMIT, { v: 1, tipId: "t", body: { subject: "s", text: "short" } }, sourceSize)).length);
    expect(sizes.size).toBe(1);
    const [size] = sizes;
    expect(size).toBeLessThanOrEqual(SOURCE_WIRE_BYTES);
    expect(size).toBeGreaterThan(SOURCE_WIRE_BYTES - 3);
  });

  it("pads drop box messages to 16 KiB steps", async () => {
    const w = await sealPadded(tip, dropbox, CHUNK, { text: "hello" }, dropboxSize);
    expect(16 * 1024 - w.length).toBeGreaterThanOrEqual(0);
    expect(16 * 1024 - w.length).toBeLessThan(3);
    const w2 = await sealPadded(tip, dropbox, CHUNK, { text: "x".repeat(20_000) }, dropboxSize);
    expect(32 * 1024 - w2.length).toBeGreaterThanOrEqual(0);
    expect(32 * 1024 - w2.length).toBeLessThan(3);
  });

  it("refuses a message too big for its size", async () => {
    await expect(sealPadded(tip, dropbox, CHUNK, { data: "x".repeat(SOURCE_WIRE_BYTES) }, sourceSize)).rejects.toThrow(/doesn't fit/);
  });
});

describe("the drop box descriptor", () => {
  const clock = new DemoClock("2026-11-06T10:00:00Z");
  const sam = identityFromSeed(seedFrom("d/sam"));
  const acme = "did:key:z6MkAcme";
  const d = signDescriptor(
    {
      slug: "ledger-sam",
      outlet: "The Ledger",
      journalist: { name: "Sam Ortiz" },
      relay: "ws://localhost:4314/v1",
      circuits: [{ id: "anon-membership/v1/gate-d20", vkHash: "00" }],
      stories: [{ id: "acme-valves", title: "Valves", opens: "2026-11-06", groups: [{ group: `${acme}#employees`, issuer: acme, label: "Acme employees", log: "http://x/log.json", mirror: "/m/", minSize: 50, maxEpochAge: 3 }] }],
      limits: { maxAttachments: 8, maxAttachmentBytes: 1 << 24 },
    },
    sam,
    clock,
  );
  it("signs and verifies", async () => {
    expect(await verifyDescriptor(d, clock, sam.did)).toMatchObject({ ok: true });
  });
  it("refuses a changed story, another signer, and a group not its issuer's", async () => {
    expect(await verifyDescriptor({ ...d, stories: [{ ...d.stories[0], title: "Changed" }] }, clock)).toMatchObject({ ok: false });
    expect(await verifyDescriptor(d, clock, identityFromSeed(seedFrom("d/other")).did)).toMatchObject({ ok: false });
    const bad = { ...d, stories: [{ ...d.stories[0], groups: [{ ...d.stories[0].groups[0], issuer: "did:key:z6MkOther" }] }] };
    expect(await verifyDescriptor(bad, clock)).toMatchObject({ ok: false, why: /issuer/ });
  });
  it("knows when a story is open", () => {
    expect(storyOpen({ ...d.stories[0], closes: "2027-02-01" }, "2026-11-06")).toBe(true);
    expect(storyOpen(d.stories[0], "2026-11-05")).toBe(false);
    expect(storyOpen({ ...d.stories[0], closes: "2026-11-07" }, "2026-11-08")).toBe(false);
  });
});

describe("image metadata", () => {
  it("finds EXIF GPS, camera and serial number in a JPEG, and strips every APP1 segment", () => {
    const jpeg = withExif(syntheticJpeg(), { make: "Google", model: "Pixel 8", serial: "SN-4471", lat: 29.7604, lon: -95.3698 }, { xmp: true, comment: "shot at riverside" });
    expect(imageKind(jpeg)).toBe("jpeg");
    const found = findMetadata(jpeg);
    const byWhat = Object.fromEntries(found.map((f) => [f.what, f.value]));
    expect(byWhat["Camera make"]).toBe("Google");
    expect(byWhat["Camera model"]).toBe("Pixel 8");
    expect(byWhat["Camera serial number"]).toBe("SN-4471");
    expect(byWhat["GPS position"]).toBe("29.7604° N, 95.3698° W");
    expect(found.some((f) => f.what.startsWith("XMP"))).toBe(true);
    expect(found.some((f) => f.what === "Comment")).toBe(true);

    const clean = stripMetadata(jpeg);
    expect(findMetadata(clean)).toEqual([]);
    for (let i = 0; i + 1 < clean.length; i++) if (clean[i] === 0xff) expect([0xe1, 0xfe]).not.toContain(clean[i + 1]);
    expect(clean).toEqual(syntheticJpeg());
  });

  it("strips eXIf, tEXt, iTXt and zTXt chunks from a PNG", () => {
    const png = pngWithMetadata();
    const found = findMetadata(png).map((f) => f.what);
    expect(found).toEqual(expect.arrayContaining(["Text: Author", "Text: Comment", "Text: Software", "Camera model", "GPS position", "Date edited"]));
    const clean = stripMetadata(png);
    expect(findMetadata(clean)).toEqual([]);
    const text = new TextDecoder("latin1").decode(clean);
    for (const t of ["eXIf", "tEXt", "iTXt", "zTXt", "tIME", "Priya"]) expect(text).not.toContain(t);
    expect(text).toContain("IHDR");
    expect(text).toContain("IDAT");
  });

  it("warns about files it can't clean", () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\n<< /Author (P. Raman) /Producer (Word) >>");
    expect(findMetadata(pdf)).toEqual([]);
    const w = otherFileWarnings("memo.pdf", pdf);
    expect(w.map((f) => f.value)).toEqual(expect.arrayContaining(["P. Raman", "Word"]));
    expect(() => stripMetadata(pdf)).toThrow();
  });
});
