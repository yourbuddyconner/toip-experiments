/**
 * The demo script (design §11) in a terminal: npm run demo --workspace @toip-tools/tipline.
 * Real relay, real proofs, every party in this process. The browser version is web/e2e.ts.
 */
import { newTipCode } from "./protocol/codes";
import { storyOf } from "./protocol/descriptor";
import { REASON_TEXT } from "./protocol/messages";
import { buildTip, checkGroup, deliver, findMembership, TipConversation, type Membership } from "./agents/source";
import { checkMembership, enrollWallet, membershipCode } from "./agents/wallet";
import { ACME_URL, OUTLET_URL, STORY, makeWorld, until } from "./world";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const say = (n: string, s: string) => console.log(`\n${bold(n)} ${s}`);
const note = (s: string) => console.log(`   ${dim(s)}`);

const w = await makeWorld();
try {
  const logUrl = `${ACME_URL}groups/employees/log.json`;
  const snapshotUrl = (e: string) => `${ACME_URL}groups/employees/snapshot/${e}.bin`;
  const group = storyOf(w.descriptor, STORY)!.groups[0];
  const view = async () => {
    const c = await checkGroup({ outletUrl: OUTLET_URL, group, fetcher: w.fetcher, clock: w.clock, alsoOrganization: true, organization: "Acme" });
    if (!c.ok) throw new Error(c.why);
    return c.view;
  };
  const member = async (code: string): Promise<Membership> => {
    const m = await findMembership({ code, view: await view(), outletUrl: OUTLET_URL, fetcher: w.fetcher });
    if (!m.ok) throw new Error(m.why);
    return m.membership;
  };
  const tip = async (code: string, subject: string, m: Membership) => {
    const built = await buildTip({
      code,
      descriptor: w.descriptor,
      story: storyOf(w.descriptor, STORY)!,
      membership: m,
      body: { subject, text: "…" },
      files: [],
      prover: w.prover,
      clock: w.clock,
    });
    await deliver(built, { relayUrl: w.relay.url });
    return built;
  };

  say("1.", "Acme Chemicals runs its employee group: 58 employees enroll from their own wallets.");
  w.acme.seed(58);
  const priya = await w.wallet("priya");
  const marcus = await w.wallet("marcus");
  w.acme.addEmployee("Priya Raman", priya.identity.did);
  w.acme.addEmployee("Marcus Bell", marcus.identity.did);

  say("2.", "Priya and Marcus enroll over TSP. Acme sees each DID next to a commitment, and nothing more.");
  await enrollWallet(priya.endpoint, w.acme.identity.did, w.acme.groupId, priya.seed);
  await enrollWallet(marcus.endpoint, w.acme.identity.did, w.acme.groupId, marcus.seed);
  const p = w.acme.members().find((m) => m.name === "Priya Raman")!;
  note(`Priya: ${p.did.slice(0, 24)}… → leaf ${p.index}, commitment ${p.commitment!.slice(0, 18)}…`);
  const root = w.acme.publish();
  await w.mirror.refresh();
  note(`Acme signs today's root: epoch ${root.epoch}, ${root.size} members, snapshot ${root.snapshotHash.slice(0, 16)}…`);
  const wallet = await checkMembership({ walletSeed: priya.seed, groupId: w.acme.groupId, issuer: w.acme.identity.did, logUrl, snapshotUrl, fetcher: w.fetcher, clock: w.clock });
  note(`Priya's wallet finds her leaf: ${JSON.stringify(wallet)}`);

  say("3.", `Sam opens a story at The Ledger, for Acme's employees, at least ${group.minSize} members, roots up to ${group.maxEpochAge} days old.`);
  const inbox = w.startInbox();

  say("4.", "Priya, in a private window, checks the group at the mirror against Acme's own log, proves, and sends.");
  const v = await view();
  note(`The group checks out: ${v.head.size} members, and the mirror matches Acme's log. "You are one of ${v.head.size}."`);
  const code = newTipCode();
  const t0 = Date.now();
  const first = await tip(code, "Valve 7 pressure log was rewritten", await member(membershipCode(priya.seed, w.acme.groupId)));
  note(`Proved in ${first.proveMs} ms; sent ${first.wires.length} sealed messages from a fresh DID, ${first.identity.did.slice(0, 24)}…, in ${Date.now() - t0} ms. Tip code ${code}.`);

  say("5.", "What Acme's relay saw:");
  await until(() => inbox.tip(first.tipId)?.status === "complete", 20_000);
  for (const m of w.stored.filter((m) => m.to === w.sam.did)) note(`${m.from.slice(0, 24)}… → drop box, ${m.bytes} bytes`);

  say("6.", "Sam's inbox:");
  const a = inbox.tip(first.tipId)!;
  note(`${a.label}, a member of Acme Chemicals employees (${a.size} members) as of ${a.epoch}. Designed-to-be-zero-knowledge proof verified.`);

  say("7.", "Sam replies. Priya closes her window.");
  await inbox.reply(first.tipId, "Who else saw the original log?");

  say("8.", "A day later Priya comes back with only her tip code.");
  await w.skipDays(1);
  const convo = new TipConversation({ code, descriptor: w.descriptor, relayUrl: w.relay.url, clock: w.clock });
  await convo.start();
  await until(() => convo.messages.some((m) => m.from === "dropbox"), 20_000);
  note(`She reads: "${convo.messages.find((m) => m.from === "dropbox")!.text}" (receipt: ${convo.receipt?.status ?? "…"})`);
  await convo.send("Two shift supervisors.");
  await convo.flushed();
  convo.close();

  say("9.", "Priya tries to look like a second source, with a new tip code.");
  const second = await tip(newTipCode(), "Another angle", await member(membershipCode(priya.seed, w.acme.groupId)));
  await until(() => inbox.tip(second.tipId)?.status === "complete", 20_000);
  note(`The inbox: ${inbox.tip(second.tipId)!.label} again.`);

  say("10.", "Marcus tips on the same story.");
  const marcusOld = await member(membershipCode(marcus.seed, w.acme.groupId));
  const third = await tip(newTipCode(), "Maintenance was told to wait", marcusOld);
  await until(() => inbox.tip(third.tipId)?.status === "complete", 20_000);
  note(`${inbox.tip(third.tipId)!.label}. "${inbox.sources(STORY)} distinct members of this group. The issuer could control some of them."`);

  say("11.", "Acme removes Marcus, and four days pass.");
  w.acme.removeEmployee(marcus.identity.did);
  await w.skipDays(4);
  const n = inbox.refusals().length;
  await tip(newTipCode(), "After I was let go", marcusOld);
  await until(() => inbox.refusals().length > n, 20_000);
  note(`A proof against his old root is refused: ${REASON_TEXT[inbox.refusals().at(-1)!.reason]}.`);

  say("12.", "Acme cheats: a second root for today, holding Priya and 59 fakes, on the outlet's mirror.");
  const fork = w.acme.forkRoot(priya.identity.did);
  w.mirror.tamper(fork.root, fork.snapshot);
  const c = await checkGroup({ outletUrl: OUTLET_URL, group, fetcher: w.fetcher, clock: w.clock, alsoOrganization: true, organization: "Acme" });
  note(`Priya's app: ${c.ok ? "accepted (wrong!)" : c.why}.`);
  const status = await inbox.groupStatus();
  note(`Sam's inbox keeps both signed roots: ${status[0].evidence?.map((r) => `${r.size} members`).join(" and ")}.`);
  w.mirror.untamper();

  say("13.", "What Acme can find:");
  const state = JSON.stringify(w.acme.state());
  const relaySeen = JSON.stringify(w.stored);
  for (const [what, needle] of [
    ["Priya's employee DID", priya.identity.did],
    ["Priya's commitment", p.commitment!],
    ["Priya's nullifier", a.nullifier],
  ] as const) {
    note(`${what}: ${state.includes(needle) ? "in Acme's roster" : "not in Acme's state"}; ${relaySeen.includes(needle) ? "in the relay's records (enrollment)" : "not in the relay's records"}.`);
  }
  console.log(`\n${bold("Done.")} The browser version: npm run e2e --workspace @toip-tools/tipline\n`);
} finally {
  await w.close();
}
process.exit(0);
