import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestSeal } from "../src/cesr";
import { Controller } from "../src/controller";
import { fromCompactLog, toCompactLog } from "../src/compact";
import { httpWitnessClient } from "../src/http";
import { verifyKel } from "../src/kel";
import { startWitness } from "../src/node";
import { fromStream } from "../src/stream";
import { anchoredIn, exportBundle } from "../src/verify";
import { seedFrom, setup } from "./helpers";

describe("timed receipts on KEL events (capture)", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("a witness's receipt of an interaction event carries its time and verifies offline; the Node service works", async () => {
    dir = mkdtempSync(join(tmpdir(), "eventlog-"));
    const s = setup("cam");
    const svc = await startWitness({ seed: seedFrom("dev-witness"), dataPath: join(dir, "w.json"), clock: s.clock });
    try {
      const client = httpWitnessClient(svc.url, svc.aid);
      const c = await Controller.incept({ hot: s.hot, cold: s.cold, witnesses: [svc.aid], bt: 1, store: s.store, clock: s.clock });
      s.clock.advance(60_000);
      const root = new Uint8Array(32).fill(7);
      const ixn = await c.interact([digestSeal(root)]);
      s.clock.advance(5_000);
      expect((await c.publish([client])).missing).toEqual([]);
      const b = await exportBundle(s.store, c.aid);
      const kel = await verifyKel(b.kel);
      expect(kel.ok).toBe(true);
      const ev = kel.events.find((e) => e.s === ixn.s)!;
      expect(ev.receiptTimes).toEqual([{ witness: svc.aid, dt: s.clock.iso() }]);
      const found = anchoredIn(kel, root);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ kelSn: ixn.s, receipts: [svc.aid], earliestReceipt: s.clock.iso() });
      // the same from the witness's own copy
      const theirs = await verifyKel(await client.query({ logId: c.aid }));
      expect(theirs.events[1].earliestReceipt).toBe(s.clock.iso());
      // and through the compact log, timed receipts included
      const all = fromStream(b.kel).messages;
      const bytes = toCompactLog(kel.messages, all.filter((m) => m.t === "trc"));
      const back = fromCompactLog(bytes);
      const again = await verifyKel([...back.messages, ...back.receipts]);
      expect(again.events[1].earliestReceipt).toBe(s.clock.iso());
    } finally {
      await svc.close();
    }
  });
});
