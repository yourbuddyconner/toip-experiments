/**
 * The demo's world (design §14.3) in one process: a Settle network on a local cluster, the hub with its
 * witness, the principal's device, the CI attester, Dana's device, QuickFix, and the three agents. Used by the
 * terminal demo, the app and the tests.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coldKeysFromSeed } from "@toip-tools/eventlog";
import { defaultEngine, httpStatusResolver, issueMandate, StatusRegistry, type Mandate, type MandateEngine, type StatusResolver } from "@toip-tools/mandates";
import { identityFromSeed, SystemClock, type Clock, type Identity } from "@toip-tools/trust-core";
import { startPlatform, type Platform } from "@toip-tools/settle/src/platform/platform";
import { SettleApi } from "@toip-tools/settle/src/client/client";
import { loadPolicy } from "@toip-tools/settle/src/protocol/policyFile";
import type { Party } from "@toip-tools/settle/src/agents/party";
import { DEFAULT_PORTS, USDC } from "./config";
import { startHub, type Hub } from "./hub/hub";
import { HubClient, signProfile } from "./hub/client";
import { httpWitnessClient } from "@toip-tools/eventlog";
import { makeBareRepo, Workspace } from "./guard/workspace";
import { createAgent, type AgentHandle } from "./roles/agent";
import { PrincipalDevice } from "./roles/principal";
import { CiAttester } from "./roles/ci";
import { Courier } from "./roles/courier";
import { QuickFix } from "./roles/quickfix";
import { CODER_SYSTEM, CODER_TASK, ERRANDS_SYSTEM, OPS_SYSTEM, OPS_TASK } from "./roles/prompts";
import { coderScript, errandsAgainScript, errandsScript, opsScript } from "./roles/scripts";
import { ScriptedModel, type Script } from "./loop/scripted";
import type { ModelClient } from "./loop/model";
import { AnthropicModel, MODELS } from "./loop/anthropic";

export const SANDBOX_REPO = join(import.meta.dirname, "..", "sandbox", "demo-repo");

export interface WorldOptions {
  /** 0 everywhere for tests. */
  ports?: Partial<Record<keyof typeof DEFAULT_PORTS, number>>;
  host?: string;
  /** "scripted" (default) or "live" (Claude, if credentials work). */
  mode?: "scripted" | "live";
  /** Override the scripts per agent, e.g. for tests. */
  scripts?: Partial<Record<"ops" | "errands" | "coder", Script[]>>;
  /** Dana quotes and delivers by herself (headless runs), or waits for clicks in her view. */
  courier?: "auto" | "manual";
  log?: (who: string, text: string) => void;
  onTurn?: (who: string, t: { n: number; tools: { name: string; input: unknown; result: unknown }[]; text: string }) => void;
  /** Longest inbox wait, in seconds. */
  maxWaitSeconds?: number;
}

export interface World {
  platform: Platform;
  api: SettleApi;
  hub: Hub;
  hubClient: HubClient;
  engine: MandateEngine;
  status: StatusResolver;
  clock: Clock;
  principal: PrincipalDevice;
  conner: Party;
  ops: AgentHandle;
  errands: AgentHandle;
  coder: AgentHandle;
  ci: CiAttester;
  dana: Courier;
  quickfix: QuickFix;
  byteWorks: { identity: Identity; registry: StatusRegistry; mandate: Mandate };
  repo: string;
  mode: "scripted" | "live";
  names: (did: string) => string;
  /** Step 1 of the demo: the mandate of design §7.1. */
  issueOpsMandate(): Promise<Mandate>;
  fundOps(units?: bigint): Promise<void>;
  giveOpsTask(text?: string): Promise<void>;
  close(): Promise<void>;
}

const randomSeed = () => crypto.getRandomValues(new Uint8Array(32));

export async function createWorld(o: WorldOptions = {}): Promise<World> {
  const ports = { ...DEFAULT_PORTS, ...(o.ports ?? {}) };
  const log = o.log ?? (() => {});
  const clock = new SystemClock();
  const mode = o.mode ?? "scripted";
  const dataDir = mkdtempSync(join(tmpdir(), "agents-world-"));

  const platform = await startPlatform({ port: ports.settle, relayPort: ports.relay, rpcPort: ports.rpc, host: o.host, web: "none", dataDir: join(dataDir, "settle") });
  const closers: (() => Promise<void> | void)[] = [() => platform.close()];
  try {
    const api = new SettleApi(platform.url);
    const policy = await loadPolicy();
    const engine = await defaultEngine();
    const hub = await startHub({ port: ports.hub, host: o.host, witnessSeed: randomSeed(), clock });
    closers.unshift(() => hub.close());
    const hubClient = new HubClient(hub.url);
    const hubWitness = { url: hubClient.witnessUrl, aid: hub.witness.aid };
    const status = httpStatusResolver(hubClient.statusBase);
    const config = await api.config();

    const known: Record<string, string> = {};
    const names = (did: string) => known[did] ?? config.names[did] ?? `${did.slice(0, 16)}…`;
    const ids = {
      conner: identityFromSeed(randomSeed()),
      byteWorks: identityFromSeed(randomSeed()),
      ops: identityFromSeed(randomSeed()),
      errands: identityFromSeed(randomSeed()),
      coder: identityFromSeed(randomSeed()),
      ci: identityFromSeed(randomSeed()),
      dana: identityFromSeed(randomSeed()),
      quickfix: identityFromSeed(randomSeed()),
    };
    Object.assign(known, {
      [ids.conner.did]: "Conner Swann",
      [ids.byteWorks.did]: "Byte Works",
      [ids.ops.did]: "Ops agent",
      [ids.errands.did]: "Errands agent",
      [ids.coder.did]: "Coder agent",
      [ids.ci.did]: "Demo CI",
      [ids.dana.did]: "Dana Ruiz",
      [ids.quickfix.did]: "QuickFix",
    });
    const connerRotation = randomSeed();
    const principalNext = (agent: string) => coldKeysFromSeed(connerRotation, `principal/${agent}`).commit(1, 1)[0];
    const join_ = async (identity: Identity, name: string) => {
      const p = await api.party({ identity, name, policy, clock });
      await p.start();
      await api.register(p);
      closers.unshift(() => p.stop());
      return p;
    };
    const tick = (p: Party) => {
      const t = setInterval(() => void p.tick().catch(() => undefined), 1000);
      t.unref?.();
      closers.unshift(() => clearInterval(t));
    };

    // ---- the principal: Conner, verified by Settle Verify, with test USDC
    const conner = await join_(ids.conner, "Conner Swann");
    await api.verify(conner, "Conner Swann", "");
    await api.addFunds(conner, USDC(500));
    tick(conner);
    const principal = new PrincipalDevice(conner, ids.conner, { clock, hub: hubClient, hubWitness, engine, names, onNote: (t) => log("Conner Swann", t) });
    await principal.start();
    closers.unshift(() => principal.stop());

    // ---- CI, the demo repository
    const repo = await makeBareRepo(SANDBOX_REPO, join(dataDir, "repos", "demo-repo.git"));
    const ciParty = await join_(ids.ci, "Demo CI");
    tick(ciParty);
    const ci = new CiAttester(ciParty, { repos: [repo], onNote: (t) => log("Demo CI", t) });
    ci.start();

    // ---- Dana, a verified courier
    const danaParty = await join_(ids.dana, "Dana Ruiz");
    await api.verify(danaParty, "Dana Ruiz Courier", "physical.errand");
    tick(danaParty);
    const dana = new Courier(danaParty, ids.dana, {
      engine,
      status,
      clock,
      names,
      verifier: config.verifier,
      witness: httpWitnessClient(hubWitness.url, hubWitness.aid),
      ...(o.courier === "manual" ? {} : { auto: { price: USDC(45), note: "Same day. I'm nearby.", deliverNote: "Picked up the parcel; it's at your door." } }),
      onNote: (t) => log("Dana Ruiz", t),
    });
    dana.start();
    closers.unshift(() => dana.stopAuto());
    await hubClient.putWorker(signProfile(ids.dana, clock, { name: "Dana Ruiz", kind: "human", skills: ["courier", "errands", "delivery"], rate: "about 40 USDC a pickup", credentials: danaParty.credentials }));

    // ---- QuickFix, hostile
    const qfParty = await join_(ids.quickfix, "QuickFix");
    const quickfix = new QuickFix(qfParty);
    quickfix.start();
    await hubClient.putWorker(signProfile(ids.quickfix, clock, { name: "QuickFix", kind: "agent", skills: ["software", "tests", "anything"], rate: "fast" }));

    // ---- the agents
    const live = mode === "live";
    const scripts = { ops: o.scripts?.ops ?? [opsScript()], errands: o.scripts?.errands ?? [errandsScript(), errandsAgainScript()], coder: o.scripts?.coder ?? [coderScript()] };
    const modelsFor = (key: keyof typeof scripts, liveModel: string) => (n: number): ModelClient =>
      live ? new AnthropicModel({ model: liveModel }) : new ScriptedModel(scripts[key][Math.min(n, scripts[key].length - 1)]);
    const common = { api, policy, hub: hubClient, hubWitness, engine, status, clock, names: (d: string) => known[d] ?? config.names[d], onNote: log, ...(o.onTurn ? { onTurn: o.onTurn } : {}), ...(o.maxWaitSeconds !== undefined ? { maxWaitSeconds: o.maxWaitSeconds } : {}) };
    const conner_ = { identity: ids.conner, name: "Conner Swann" };
    const rootCredentials = [...conner.credentials];
    const opsRegistry = new StatusRegistry(ids.ops, clock);

    const ops = await createAgent({
      ...common,
      name: "Ops agent",
      description: "Keeps the zk-toip demo repo green and runs small errands.",
      role: "hirer",
      identity: ids.ops,
      rotationSeed: randomSeed(),
      operator: conner_,
      accountable: { did: ids.conner.did, name: "Conner Swann" },
      principal: { did: ids.conner.did, name: "Conner Swann", next: principalNext("ops"), witnesses: true },
      models: modelsFor("ops", MODELS.ops),
      system: OPS_SYSTEM,
      directory: { skills: ["operations"], kind: "agent" },
      ci: { did: ids.ci.did, repo },
      statusRegistry: opsRegistry,
      rootCredentials,
    });
    closers.unshift(() => ops.stop());

    const errands = await createAgent({
      ...common,
      name: "Errands agent",
      description: "Ops agent's sub-agent for small physical errands.",
      role: "hirer",
      identity: ids.errands,
      rotationSeed: randomSeed(),
      operator: conner_,
      accountable: { did: ids.conner.did, name: "Conner Swann" },
      principal: { did: ids.conner.did, name: "Conner Swann", next: principalNext("errands"), witnesses: true },
      models: modelsFor("errands", MODELS.errands),
      system: ERRANDS_SYSTEM,
      directory: { skills: ["errands"], kind: "agent" },
      rootCredentials,
    });
    closers.unshift(() => errands.stop());

    // ---- Coder agent, run by Byte Works, with its own mandate: it may quote 5 to 100 USDC for software work, and never spend.
    const bw = { identity: ids.byteWorks, registry: new StatusRegistry(ids.byteWorks, clock) };
    await hubClient.putStatus(bw.registry.sign());
    const coderMandate = issueMandate(ids.byteWorks, clock, {
      subject: ids.coder.did,
      validUntil: new Date(clock.now() + 30 * 86_400_000).toISOString(),
      status: bw.registry.allocate(),
      profile: "settle/1",
      purpose: "Take paid coding jobs for Byte Works.",
      constraints: {
        actions: { attr: "type", anyOf: ["settle/get-paid", "agents/job/deliver", "settle/refund"] },
        asset: { attr: "asset", anyOf: [config.mint], when: ["settle/pay", "mandates/delegate"] },
        priceMin: { attr: "price", min: USDC(5).toString(), when: ["settle/get-paid"] },
        priceMax: { attr: "price", max: USDC(100).toString(), when: ["settle/get-paid"] },
        categories: { attr: "category", within: ["software.*"], when: ["settle/get-paid"] },
        spendTotal: { attr: "spend", budget: "0", period: "total" },
        tasks: { attr: "task", within: ["https://toip.tools/spec/agents/*", "https://toip.tools/spec/settle/*"] },
      },
      delegation: { maxDepth: 0 },
      revocation: { maxAgeSeconds: 3600 },
    });
    await hubClient.putStatus(bw.registry.sign());
    const coder = await createAgent({
      ...common,
      name: "Coder agent",
      description: "Byte Works' coding agent: fixes small bugs for pay.",
      role: "worker",
      identity: ids.coder,
      rotationSeed: randomSeed(),
      operator: { identity: ids.byteWorks, name: "Byte Works" },
      accountable: { did: ids.byteWorks.did, name: "Byte Works" },
      principal: { did: ids.byteWorks.did, name: "Byte Works", next: coldKeysFromSeed(randomSeed(), "byteworks").commit(1, 1)[0], witnesses: false },
      models: modelsFor("coder", MODELS.coder),
      system: CODER_SYSTEM,
      directory: { skills: ["software", "tests", "javascript"], kind: "agent", rate: "from 15 USDC" },
      verify: { name: "Byte Works", category: "software.dev" },
      workspace: new Workspace(join(dataDir, "coder")),
      workerRequirements: { passport: "required", rootMustHold: [`VerifiedBusiness@${config.verifier}`] },
    });
    closers.unshift(() => coder.stop());
    await coder.guard.acceptMandate([coderMandate]);
    // A worker agent's standing task: watch for offers.
    void coder.runTask(CODER_TASK);

    // Every issuer re-signs its status list well inside the hour verifiers allow.
    const refresh = setInterval(() => {
      void hubClient.putStatus(bw.registry.sign()).catch(() => undefined);
      void ops.guard.refreshStatus().catch(() => undefined);
    }, 10 * 60_000);
    refresh.unref?.();
    closers.unshift(() => clearInterval(refresh));

    let opsMandate: Mandate | undefined;
    const world: World = {
      platform,
      api,
      hub,
      hubClient,
      engine,
      status,
      clock,
      principal,
      conner,
      ops,
      errands,
      coder,
      ci,
      dana,
      quickfix,
      byteWorks: { ...bw, mandate: coderMandate },
      repo,
      mode,
      names,
      async issueOpsMandate() {
        if (opsMandate) return opsMandate;
        opsMandate = principal.issueRoot({
          agent: ids.ops.did,
          purpose: "Keep the demo repo green and run small errands for me.",
          perPayment: USDC(30),
          perDay: USDC(100),
          total: USDC(200),
          categories: ["software.*", "physical.errand"],
          attesters: [ids.ci.did, ids.conner.did],
          arbiter: config.arbiter.did,
          mint: config.mint,
          validDays: 7,
          maxDepth: 1,
        });
        await principal.sendMandate(opsMandate);
        const end = Date.now() + 15_000;
        while (ops.guard.chain[0]?.id !== opsMandate.id) {
          if (Date.now() > end) throw new Error("Ops agent didn't accept its mandate");
          await new Promise((r) => setTimeout(r, 25));
        }
        return opsMandate;
      },
      async fundOps(units = USDC(150)) {
        await principal.fund((await ops.party.openWallet()).token, units, ids.ops.did);
      },
      async giveOpsTask(text = OPS_TASK) {
        await principal.sendTask(ids.ops.did, text);
      },
      async close() {
        for (const c of closers) {
          try {
            await c();
          } catch {
            // keep closing
          }
        }
      },
    };
    return world;
  } catch (e) {
    for (const c of closers) await Promise.resolve(c()).catch(() => undefined);
    throw e;
  }
}
