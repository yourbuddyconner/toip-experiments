/**
 * The demo script (design §12.3) in the terminal, with real proofs: npm run demo --workspace @toip-tools/agora.
 * Everything runs in this process. TSP goes over an in-memory bus; the host and registrars answer HTTP on free ports.
 */
import { MembershipProver } from "@toip-tools/anon-membership";
import { Bus, DemoClock, Endpoint, identityFromSeed, seedFrom, signDocument } from "@toip-tools/trust-core";
import { AgoraClient, MemoryWallet } from "./client/client";
import { AgoraError, HostApi, RegistrarApi } from "./client/http";
import { ForumReader, MemoryKeyValue } from "./client/reader";
import { newId, type NymPass } from "./protocol/documents";
import { nymName } from "./protocol/names";
import { startWorld } from "./platform/world";

const DAY = 86_400_000;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const say = (s: string) => console.log(`  ${s}`);
const head = (s: string) => console.log(`\n${bold(s)}`);
const refused = async (p: Promise<unknown>) => {
  try {
    await p;
    return "accepted (!)";
  } catch (e) {
    return (e as AgoraError).code ?? String(e);
  }
};

const clock = new DemoClock("2026-11-06T09:00:00.000Z");
const bus = new Bus(clock);
const world = await startWorld({ clock, tsp: { bus }, tickMs: 0, devClock: true });
const prover = await MembershipProver.create();
const host = new HostApi(world.hostServer.url);
const registrar = new RegistrarApi(world.registrarServer.url);
const member = async (name: string, seed = seedFrom(`agora-demo/${name}`)) =>
  AgoraClient.open({ seed, clock, host, registrar, prover, wallet: new MemoryWallet(), endpoint: new Endpoint({ identity: identityFromSeed(seed), transport: bus, clock, timeoutMs: 10_000 }) });
const reader = new ForumReader(host, registrar, world.verifier, clock, new MemoryKeyValue());
const { cascade, pine, riverton } = world.byKey;

try {
  console.log(`\n${bold("Agora")}: credential-gated anonymous forums. Host ${dim(world.host.identity.did)}`);
  const [ana, ben, cal, dee] = await Promise.all(["ana", "ben", "cal", "dee"].map((n) => member(n)));

  head("1. Credentials");
  await ana.requestCredential(cascade.did, { credentialType: "NursingLicense", claims: { licenseType: "RN", state: "WA", licensedSince: "2019-05-01" } });
  await ana.requestCredential(riverton.did, { credentialType: "ResidencyCredential", claims: { district: "7", residentSince: "2021-03-15" } });
  await ben.requestCredential(pine.did, { credentialType: "NursingLicense", claims: { licenseType: "RN", state: "OR", licensedSince: "2015-01-01" } });
  await cal.requestCredential(cascade.did, { credentialType: "NursingLicense", claims: { licenseType: "LPN", state: "WA", licensedSince: "2020-06-01" } });
  await cal.requestCredential(riverton.did, { credentialType: "ResidencyCredential", claims: { district: "3", residentSince: "2018-08-01" } });
  say("Ana: RN from Cascade, resident of district 7. Ben: RN from Pine Valley. Cal: LPN from Cascade, district 3.");

  head("2. Join");
  for (const [c, g] of [
    [ana, cascade],
    [ana, riverton],
    [ben, pine],
    [cal, cascade],
    [cal, riverton],
  ] as const)
    await c.join(g.registrar.groupId);
  await world.tick();
  say(`Groups: Cascade ${cascade.registrar.size()}, Pine Valley ${pine.registrar.size()}, Riverton ${riverton.registrar.size()} members (40 simulated in each).`);

  head("3. Dee creates Night Shift and Riverton Town Square");
  const nightShift = await dee.createForum({
    title: "Night Shift",
    slug: "night-shift",
    description: "For RNs on nights.",
    rules: ["No names of patients or colleagues."],
    gate: {
      anyOf: [
        { group: cascade.registrar.groupId, registrar: cascade.did },
        { group: pine.registrar.groupId, registrar: pine.did },
      ],
      where: [{ attr: "licenseType", op: "eq", value: "RN" }],
      minRegisteredDays: 7,
      minAnonymitySet: 25,
    },
  });
  const townSquare = await dee.createForum({ title: "Riverton Town Square", slug: "town-square", description: "", gate: { anyOf: [{ group: riverton.registrar.groupId, registrar: riverton.did }], where: [], minRegisteredDays: 0, minAnonymitySet: 25 } });
  say(`Ana, today: ${(await ana.eligibility(nightShift.gate)).ok ? "can post" : (await ana.eligibility(nightShift.gate) as { reason: string }).reason}`);
  clock.advance(8 * DAY);
  await world.tick();
  say("Skipped ahead 8 days.");

  head("4. Ana posts");
  say(`She'll post as ${bold(ana.nameFor(nightShift.forum.id))}, out of about ${await ana.anonymitySet(nightShift.gate)} people.`);
  const t0 = performance.now();
  const thread = await ana.startThread({ forum: nightShift.forum.id, title: "Float pool on 4 West?", body: "Is anyone else floated every shift?" });
  say(`Pass proved and post sent in ${Math.round(performance.now() - t0)} ms.`);
  await ben.reply({ forum: nightShift.forum.id, thread: thread.id, threadScope: "forum", body: "Every other shift for me." });
  const v = await reader.read(nightShift.forum.id);
  for (const p of v.threads[0].posts) say(`${p.name.padEnd(22)} ${p.status === "verified" ? "Verified: a current RN" : p.status}  ${dim(p.body ?? "")}`);

  head("5. Cal is refused before any proof");
  say((await cal.eligibility(nightShift.gate) as { reason: string }).reason);

  head("6. One nym: Ana's second device, from her backup code");
  const laptop = await member("ana-laptop", seedFrom("agora-demo/ana"));
  await laptop.recover();
  say(`On the laptop she's ${bold(laptop.nameFor(nightShift.forum.id))} too.`);
  await laptop.requestCredential(cascade.did, { credentialType: "NursingLicense", claims: { licenseType: "RN", state: "WA", licensedSince: "2019-05-01" } });
  say(`A second leaf in Cascade: ${await refused(laptop.join(cascade.registrar.groupId))}`);

  head("7. Unlinkable across forums");
  await ana.startThread({ forum: townSquare.forum.id, title: "Elm St on Sundays", body: "Close it to cars?" });
  say(`In Town Square she's ${bold(ana.nameFor(townSquare.forum.id))}. The host holds two nyms and two session DIDs, and none of the wallet DIDs.`);

  head("8. Replay");
  const pass = (await host.feed(nightShift.forum.id)).bodies.map((b) => (b as unknown as { doc: NymPass }).doc).find((d) => d.type === "agora/nym-pass")!;
  const thief = identityFromSeed(crypto.getRandomValues(new Uint8Array(32)));
  const { proof: _p, ...rest } = pass;
  say(`Ana's pass with another session DID: ${await refused(host.pass(nightShift.forum.id, signDocument<NymPass>({ ...rest, id: newId(), issuer: thief.did }, thief, clock)))}`);

  head("9. Moderation");
  const bad = await ben.reply({ forum: nightShift.forum.id, thread: thread.id, threadScope: "forum", body: "Patient J. Doe was a nightmare." });
  await ana.report(nightShift.forum.id, bad.id, "Names a patient (rule 1).");
  await dee.moderate(nightShift.forum.id, "hide-post", bad.id, "No names of patients or colleagues.");
  await dee.moderate(nightShift.forum.id, "ban-nym", bad.nym, "No names of patients or colleagues.", { until: new Date(clock.now() + 7 * DAY).toISOString() });
  say(`Readers see: "${(await reader.read(nightShift.forum.id)).threads[0].posts.find((p) => p.id === bad.id)?.note}"`);
  say(`Ben's next post: ${await refused(ben.reply({ forum: nightShift.forum.id, thread: thread.id, threadScope: "forum", body: "Why?" }))}`);
  await ben.rotate();
  clock.advance(3600_000);
  await world.tick();
  say(`Ben rotates to ${nymName(ben.nymFor(nightShift.forum.id))}: ${(await ben.eligibility(nightShift.gate) as { reason: string }).reason}`);

  head("10. A poll for district 7");
  const poll = await dee.openPoll({ forum: townSquare.forum.id, question: "Close Elm St to cars on Sundays?", choices: ["Yes", "No"], closesAt: new Date(clock.now() + 2 * DAY).toISOString(), where: [{ attr: "district", op: "eq", value: "7" }] });
  const yes = await ana.prepareVote(poll, 0);
  await ana.sendVote(townSquare.forum.id, yes);
  say(`Ana votes Yes. The same vote again: ${await refused(ana.sendVote(townSquare.forum.id, yes))}`);
  say(`Cal: ${await refused(cal.prepareVote(poll, 0))} (${(await cal.eligibility(poll.gate, "This poll") as { reason: string }).reason})`);
  say(`Tally: ${JSON.stringify((await host.poll(townSquare.forum.id, poll.id)).tally)}`);

  head("11. Revocation");
  const victim = Object.keys(cascade.registrar.state().members).find((d) => d !== ana.did && d !== cal.did)!;
  cascade.revokeSubject(victim);
  clock.advance(3600_000);
  await world.tick();
  const root = cascade.registrar.roots().at(-1)!;
  say(`Cascade revoked one license. Root ${root.seq}: ${root.size} members, removed ${(root.ext as { removed: number }).removed}. A patient watcher could correlate removals with nyms going quiet; roots come at most hourly to blunt that.`);

  head("12. The feed can't be rewritten silently");
  const store = world.store as unknown as { bodies: Map<string, string> };
  const [said, raw] = [...store.bodies].find(([, r]) => r.includes("Every other shift for me."))!;
  store.bodies.set(said, raw.replace("Every other shift", "Never once"));
  say(`After editing one stored post: ${(await reader.read(nightShift.forum.id)).warnings[0]}`);
  console.log(`\n${bold("Done.")}\n`);
} finally {
  await prover.destroy();
  await world.close();
}
process.exit(0);
