/** The service's HTTP API, and the witnesses reached through it. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evidenceFromJson, evidenceToJson, fromStream, httpWitnessClient, type Bundle } from "@zk-toip/eventlog";

type StoredEvidence = ReturnType<typeof evidenceToJson>;
import { startService, type Service } from "../src/service";
import { buildView } from "../src/view";

let svc: Service;
const get = async <T>(path: string): Promise<T> => {
  const r = await fetch(`${svc.url}${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};
const post = (path: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => fetch(`${svc.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

interface State {
  progress: number;
  steps: { n: number; title: string; redTeam: boolean; done: boolean }[];
  witnesses: { n: number; aid: string; path: string; rogue: boolean; inUse: boolean }[];
  logs: { aid: string; label: string; trailId: string }[];
  names: Record<string, string>;
}

beforeAll(async () => {
  svc = await startService({ port: 0, web: "none" });
});
afterAll(async () => {
  await svc.close();
});

describe("the explorer API", () => {
  it("reports the demo's state: ten steps, four witnesses (three in use)", async () => {
    const s = await get<State>("/api/state");
    expect(s.progress).toBe(0);
    expect(s.steps.map((x) => x.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(s.steps.filter((x) => x.redTeam).map((x) => x.n)).toEqual([4, 5, 6, 7, 8]);
    expect(s.witnesses.map((w) => [w.n, w.inUse, w.rogue])).toEqual([
      [1, true, false],
      [2, true, false],
      [3, true, false],
      [4, false, false],
    ]);
    expect(s.logs).toEqual([]);
  });

  it("refuses POSTs that aren't JSON, come from another site, or run a step out of order", async () => {
    expect((await post("/api/step", { n: 1 }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post("/api/step", { n: 1 }, { "content-type": "application/json", origin: "https://evil.example" })).status).toBe(403);
    const r = await post("/api/step", { n: 2 });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/step 1 is/);
    expect((await fetch(`${svc.url}/api/nope`)).status).toBe(404);
  });

  it("runs steps, and serves a bundle the explorer verifies (with the witnesses, through /w/n)", async () => {
    for (const n of [1, 2, 3]) {
      const r = await post("/api/step", { n });
      expect(r.status).toBe(200);
      const { report } = (await r.json()) as { report: { n: number; lines: unknown[] } };
      expect(report.n).toBe(n);
      expect(report.lines.length).toBeGreaterThan(0);
    }
    const s = await get<State>("/api/state");
    expect(s.progress).toBe(3);
    expect(s.logs.map((l) => l.label)).toEqual(["Scout"]);
    const { bundle } = await get<{ bundle: Bundle }>(`/api/bundle?aid=${s.logs[0].aid}`);
    const witnesses = s.witnesses.map((w) => httpWitnessClient(`${svc.url}${w.path}`, w.aid));
    const { view } = await buildView(bundle, { names: s.names, witnesses });
    expect(view.ok).toBe(true);
    expect(view.witnessChecked).toBe(true);
    expect(view.trails[0].entries.filter((e) => e.status === "valid")).toHaveLength(8);
    expect(view.trails[0].entries.filter((e) => e.body?.ok)).toHaveLength(7);
    expect((await fetch(`${svc.url}/api/bundle?aid=Enope`)).status).toBe(404);
  });

  it("serves each witness's HTTP API at /w/n, the same witness as on its own port", async () => {
    const s = await get<State>("/api/state");
    const info = await get<{ aid: string; did: string }>("/w/1/info");
    expect(info.aid).toBe(s.witnesses[0].aid);
    const direct = svc.world().client(1);
    const viaPath = httpWitnessClient(`${svc.url}/w/1`, info.aid);
    const aid = s.logs[0].aid;
    expect(await viaPath.query({ logId: aid })).toBe(await direct.query({ logId: aid }));
    expect((await viaPath.head(s.logs[0].trailId))?.s).toBe(7);
    expect(fromStream(await viaPath.query({ logId: s.logs[0].trailId, from: 7, to: 7 })).messages.filter((m) => m.t === "trc")).toHaveLength(3);
    expect((await fetch(`${svc.url}/w/9/info`)).status).toBe(404);
  });

  it("serves the tampered samples, and the evidence once Scout forks", async () => {
    expect((await post("/api/step", { n: 4 })).status).toBe(200);
    const samples = await get<{ id: string }[]>("/api/samples");
    expect(samples.map((x) => x.id)).toEqual(["review", "tamper-1", "tamper-2", "tamper-3", "tamper-4"]);
    expect((await post("/api/step", { n: 5 })).status).toBe(200);
    const ev = await get<{ holder: string; evidence: StoredEvidence }[]>("/api/evidence");
    const holders = new Set(ev.filter((x) => x.evidence.kind === "controller" && x.evidence.s === 6).map((x) => x.holder));
    expect([...holders].sort()).toEqual(["Ada's watcher", "Quarry's watcher", "Witness 1", "Witness 2", "Witness 3"]);
    expect(evidenceFromJson(ev[0].evidence).a.raw).toBeTruthy();
  });

  it("answers on localhost as well as 127.0.0.1", async () => {
    expect(svc.appUrl).toMatch(/^http:\/\/localhost:\d+$/);
    const r = await fetch(`${svc.appUrl.replace("localhost", "[::1]")}/api/state`).catch(() => undefined);
    if (r) expect(r.status).toBe(200); // when this machine has IPv6 loopback
  });

  it("resets the demo", async () => {
    const r = await post("/api/reset", {});
    expect(r.status).toBe(200);
    const s = (await r.json()) as State;
    expect(s.progress).toBe(0);
    expect(s.logs).toEqual([]);
    expect((await post("/api/step", { n: 1 })).status).toBe(200);
  });
});
