// Proves in a Web Worker and verifies on the page, as a web app would. browser.test.ts builds this
// with Vite, opens it in Chromium and watches every request.
import {
  GroupTree,
  MembershipVerifier,
  commitmentOf,
  dayOf,
  groupFieldOf,
  initHashing,
  leafHash,
  membershipInputs,
  messageOf,
  nullifierOf,
  plainLeaf,
  scopeOf,
} from "../../src/index";
import { MembershipWorkerClient } from "../../src/worker";

const out: Record<string, unknown> = {};
try {
  const runs = Number(new URLSearchParams(location.search).get("runs") ?? "1");
  let t = performance.now();
  await initHashing();
  out.hashInitMs = performance.now() - t;
  const group = "did:key:z6MkBrowser#employees";
  const secret = 123456789n;
  const leaves = Array.from({ length: 100 }, (_, i) => BigInt(i + 1));
  leaves[42] = leafHash(plainLeaf(commitmentOf(secret, groupFieldOf(group))));
  const tree = GroupTree.fromLeaves(leaves);
  const { statement, witness } = membershipInputs({
    secret,
    groups: [{ group, tree }],
    scope: scopeOf("test/v1", "browser"),
    signal: messageOf("test/v1", { n: 1 }),
    today: dayOf(Date.now()),
  });

  const client = new MembershipWorkerClient(new Worker(new URL("./prover.worker.ts", import.meta.url), { type: "module" }));
  t = performance.now();
  await client.warm();
  out.proverSetupMs = performance.now() - t;
  const proveMs: number[] = [];
  let proof;
  for (let i = 0; i < runs; i++) {
    t = performance.now();
    proof = await client.prove(statement, witness);
    proveMs.push(performance.now() - t);
  }
  out.proveMs = proveMs;

  t = performance.now();
  const verifier = await MembershipVerifier.create();
  out.verifierSetupMs = performance.now() - t;
  const verifyMs: number[] = [];
  let r;
  for (let i = 0; i < runs; i++) {
    t = performance.now();
    r = await verifier.verify(proof, statement);
    verifyMs.push(performance.now() - t);
  }
  out.verifyMs = verifyMs;
  out.ok = r!.ok;
  out.nullifierMatches = r!.ok && r!.nullifier === nullifierOf(secret, statement.scope, 0);
  const tampered = await verifier.verify({ ...proof!, statement: { ...proof!.statement, signal: proof!.statement.scope } });
  out.tamperedOk = tampered.ok;
  await verifier.destroy();
  await client.destroy();

  out.crossOriginIsolated = crossOriginIsolated;
  out.threads = navigator.hardwareConcurrency;
  out.indexedDb = (await indexedDB.databases()).map((d) => d.name);
  out.localStorage = localStorage.length;
  out.caches = (await caches.keys()).length;
} catch (e) {
  out.error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
}
(window as unknown as { __result: unknown }).__result = out;
