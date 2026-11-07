import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, type App } from "../src/server";
import type { Trace } from "../src/trace";

let app: App;
beforeAll(async () => {
  app = await startApp({ port: 0, web: "none" });
});
afterAll(async () => {
  await app.close();
});

describe("the visualizer's server", () => {
  it("runs an act on request and returns its trace", async () => {
    const r = await fetch(`${app.url}/api/act/2?loss=0.2&seed=3`);
    expect(r.status).toBe(200);
    const t = (await r.json()) as Trace;
    expect(t).toMatchObject({ act: 2, loss: 0.2, seed: 3, summary: { ok: true } });
    expect(t.nodes.map((n) => n.id)).toEqual(["alice", "ridge", "lodge", "relay", "landlord"]);
    expect(t.frames.length).toBeGreaterThan(5);
    expect(app.appUrl).toBe(`http://localhost:${app.port}`);
  });

  it("refuses bad parameters and unknown paths", async () => {
    expect((await fetch(`${app.url}/api/act/1?loss=2`)).status).toBe(400);
    expect((await fetch(`${app.url}/api/act/1?seed=1.5`)).status).toBe(400);
    expect((await fetch(`${app.url}/api/act/4`)).status).toBe(404);
    expect((await fetch(`${app.url}/api/act/1`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${app.url}/`)).status).toBe(404);
    expect(await (await fetch(`${app.url}/api/health`)).json()).toEqual({ ok: true });
  });
});
