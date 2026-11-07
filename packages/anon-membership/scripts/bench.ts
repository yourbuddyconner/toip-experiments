// Measures proving and verification for the depth-20 gate circuit, in Node and in Chromium.
//
//   npm run bench --workspace @toip-tools/anon-membership [-- --runs 10]
//
// Writes results/bench.json. Numbers are for the machine it runs on.
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, arch } from "node:os";
import { fileURLToPath } from "node:url";
import {
  GroupTree,
  MembershipProver,
  MembershipVerifier,
  commitmentOf,
  fieldFromBytes,
  groupFieldOf,
  initHashing,
  leafHash,
  loadArtifacts,
  membershipInputs,
} from "../src/index";
import { fromB64u } from "@toip-tools/trust-core";
const fromB64uLength = (s: string) => fromB64u(s).length;
import { buildPage, chromiumAvailable, runInChromium, servePage } from "../tests/browser/harness";

const runs = Number(process.argv[process.argv.indexOf("--runs") + 1] || 5);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x: number) => Math.round(x * 10) / 10;

await initHashing();
const a = await loadArtifacts();
const group = "did:key:z6MkBench#employees";
const secret = fieldFromBytes(new TextEncoder().encode("bench secret"));
const leaves = Array.from({ length: 5000 }, (_, i) => BigInt(i + 1));
leaves[4321] = leafHash({ commitment: commitmentOf(secret, groupFieldOf(group)), schemaId: 7n, validUntilDay: 30000, registeredDay: 20000, attrs: [5n, 6n, 7n, 8n] });
const tree = GroupTree.fromLeaves(leaves);
// The full statement: four groups, three predicates, a rate limit.
const others = [1, 2, 3].map((i) => ({ group: `did:key:z6MkOther${i}#g`, tree: GroupTree.fromLeaves([BigInt(i)]) }));
const { statement, witness } = membershipInputs({
  secret,
  groups: [others[0], { group, tree }, others[1], others[2]],
  leaf: { schemaId: 7n, validUntilDay: 30000, registeredDay: 20000, attrs: [5n, 6n, 7n, 8n] },
  scope: 99n,
  signal: 42n,
  today: 20763,
  registeredBy: 20756,
  predicates: [{ op: "eq", value: 5n }, { op: "gte", value: 6n }, { op: "lte", value: 7n }],
  limit: 10,
  messageIndex: 3,
});

const node: Record<string, unknown> = {};
for (const threads of [undefined, 1]) {
  const label = threads === 1 ? "1 thread" : "default threads";
  let t = performance.now();
  const prover = await MembershipProver.create({ threads });
  const setup = performance.now() - t;
  const prove: number[] = [];
  let proof;
  for (let i = 0; i < runs; i++) {
    t = performance.now();
    proof = await prover.prove(statement, witness);
    prove.push(performance.now() - t);
  }
  t = performance.now();
  const verifier = await MembershipVerifier.create({ threads });
  const vsetup = performance.now() - t;
  const verify: number[] = [];
  for (let i = 0; i < runs; i++) {
    t = performance.now();
    const r = await verifier.verify(proof, statement);
    verify.push(performance.now() - t);
    if (!r.ok) throw new Error("verification failed");
  }
  node[label] = { proverSetupMs: round(setup), proveMsMedian: round(median(prove)), verifierSetupMs: round(vsetup), verifyMsMedian: round(median(verify)), proofBytes: fromB64uLength(proof!.proof) };
  await prover.destroy();
  await verifier.destroy();
}

let browser: unknown = "chromium not installed";
if (chromiumAvailable()) {
  const server = await servePage(await buildPage());
  const { result, blocked } = await runInChromium(server.url + `?runs=${runs}`);
  await server.close();
  const r = result as { proveMs: number[]; verifyMs: number[]; proverSetupMs: number; verifierSetupMs: number; threads: number; crossOriginIsolated: boolean };
  browser = {
    note: "simple statement (1 group, no predicates); the circuit is the same size for every statement",
    proverSetupMs: round(r.proverSetupMs),
    proveMsMedian: round(median(r.proveMs)),
    verifierSetupMs: round(r.verifierSetupMs),
    verifyMsMedian: round(median(r.verifyMs)),
    threads: r.threads,
    crossOriginIsolated: r.crossOriginIsolated,
    blockedRequests: blocked.length,
  };
}

const out = {
  circuit: a.id,
  gates: a.gates,
  crsPoints: a.crsPoints,
  runs,
  machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, cores: cpus().length, node: process.version },
  toolchain: { noir_js: "1.0.0", bb_js: "6.0.0 (WebAssembly backend)", verifierTarget: "noir-recursive (ZK)" },
  node,
  chromium: browser,
  at: new Date().toISOString(),
};
const dir = fileURLToPath(new URL("../results/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(dir + "bench.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
