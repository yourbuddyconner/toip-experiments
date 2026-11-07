import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/keripy-kels.json";
import { nextKeyDigest } from "../src/cesr";
import { verifyKel } from "../src/kel";
import { saidify } from "../src/said";
import { fromStream } from "../src/stream";
import { keyQb64, msgOf, sign, signer } from "./helpers";

const codes = (r: { problems: { code: string }[] }) => r.problems.map((p) => p.code);

/** An inception with any fields, SAID filled in, signed by `s`. */
async function icp(fields: Record<string, unknown>, saidFields: ("d" | "i")[] = ["d", "i"]) {
  const s = signer("u/key");
  const base: Record<string, unknown> = {
    v: "",
    t: "icp",
    d: "",
    i: "",
    s: "0",
    kt: "1",
    k: [keyQb64(s)],
    nt: "1",
    n: [nextKeyDigest("next")],
    bt: "0",
    b: [],
    c: [],
    a: [],
    ...fields,
  };
  const { raw, body } = saidify("KERI", base, saidFields);
  const m = msgOf("icp", raw, body);
  m.controllerSigs = await sign(raw, [{ s, index: 0 }]);
  return verifyKel([m], { allowUnwitnessed: true });
}

describe("rejected as unsupported, not invalid", () => {
  it("fractionally weighted thresholds", async () => {
    expect(codes(await icp({ kt: ["1/2", "1/2"] }))).toEqual(["unsupported"]);
  });

  it("traits other than DND", async () => {
    expect(codes(await icp({ c: ["EO"] }))).toEqual(["unsupported"]);
    expect((await icp({ c: ["DND"] })).ok).toBe(true);
  });

  it("more than 64 keys", async () => {
    const keys = Array.from({ length: 65 }, (_, i) => keyQb64(signer(`k${i}`)));
    expect(codes(await icp({ k: keys }))).toContain("unsupported");
  });

  it("other key codes (secp256k1)", async () => {
    expect(codes(await icp({ k: ["1AAB" + "A".repeat(44)] }))).toContain("unsupported");
  });

  it("basic-prefix and non-transferable inceptions", async () => {
    const s = signer("u/key");
    expect(codes(await icp({ i: keyQb64(s) }, ["d"]))).toEqual(["unsupported"]);
    expect(codes(await icp({ n: [], nt: "0" }))).toEqual(["unsupported"]);
  });

  it("delegated events and other message types", async () => {
    const raw = fixtures.kels[1].stream.split("-AAD")[0].replace('"t":"icp"', '"t":"dip"');
    const r = fromStream(raw);
    expect(codes(r)).toEqual(["unsupported"]);
  });

  it("KERI 2.0 version strings and other serializations", async () => {
    const stream = fixtures.kels[1].stream;
    expect(codes(fromStream(stream.replace("KERI10JSON", "KERI10CBOR")))).toEqual(["unsupported"]);
    expect(codes(fromStream('{"v":"KERICAACAAJSONAAAB.","t":"icp"}'))).toEqual(["unsupported"]);
  });
});
