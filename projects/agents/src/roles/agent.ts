/**
 * One agent process (design §5): a Settle party, a trail, a passport and a guard, with the loop on top. The
 * loop only gets the guard, as a GuardApi.
 */
import { httpWitnessClient, taskWitnessClient, type WitnessClient } from "@toip-tools/eventlog";
import type { Credential, Identity } from "@toip-tools/trust-core";
import type { MandateEngine, Requirements, StatusRegistry, StatusResolver } from "@toip-tools/mandates";
import type { SettleApi } from "@toip-tools/settle/src/client/client";
import type { Party } from "@toip-tools/settle/src/agents/party";
import type { SettlePolicy } from "@toip-tools/settle/src/protocol/policy";
import type { Clock } from "@toip-tools/trust-core";
import { createAgentTrail, type EventlogSink } from "../audit/sink";
import { Guard } from "../guard/guard";
import { mandateGates } from "../guard/gates";
import type { Workspace } from "../guard/workspace";
import { signProfile, type HubClient } from "../hub/client";
import { runSession, type SessionResult } from "../loop/loop";
import type { ModelClient } from "../loop/model";
import { toolsFor, toolsHash } from "../loop/tools";
import { issuePassport } from "../passport";
import { JOB_REFUSED } from "../protocol/tasks";

export interface AgentHandle {
  name: string;
  did: string;
  role: "hirer" | "worker";
  guard: Guard;
  party: Party;
  sink: EventlogSink;
  passport: Credential;
  sessions: SessionResult[];
  /** The running session, if any. */
  running(): boolean;
  /** Runs a session for a task. Tasks wait their turn. */
  runTask(text: string): Promise<SessionResult>;
  stop(): void;
}

export interface AgentSpec {
  name: string;
  description: string;
  role: "hirer" | "worker";
  identity: Identity;
  rotationSeed: Uint8Array;
  operator: { identity: Identity; name: string };
  accountable: { did: string; name: string };
  /** The root principal: approvals go there, it may control the agent, it witnesses. */
  principal: { did: string; name: string; next: string; witnesses: boolean };
  api: SettleApi;
  policy: SettlePolicy;
  hub: HubClient;
  hubWitness: { url: string; aid: string };
  engine: MandateEngine;
  status: StatusResolver;
  clock: Clock;
  /** A model for each session, in order. */
  models: (session: number) => ModelClient;
  system: string;
  directory: { skills: string[]; kind: "agent"; rate?: string };
  verify?: { name: string; category: string };
  ci?: { did: string; repo: string };
  workspace?: Workspace;
  statusRegistry?: StatusRegistry;
  rootCredentials?: Credential[];
  workerRequirements?: Requirements;
  names: (did: string) => string | undefined;
  onNote?: (who: string, text: string) => void;
  onTurn?: (who: string, t: { n: number; tools: { name: string; input: unknown; result: unknown }[]; text: string }) => void;
  maxWaitSeconds?: number;
}

export async function createAgent(s: AgentSpec): Promise<AgentHandle> {
  let guard: Guard | undefined;
  const party = await s.api.party({
    identity: s.identity,
    name: s.name,
    policy: s.policy,
    clock: s.clock,
    onChange: () => guard?.settleChanged(),
    onEvent: (e) => guard?.onSettleEvent(e),
    onTraffic: (_who, t) => guard?.onTraffic(t),
  });
  await party.start();
  await s.api.register(party);
  if (s.verify) await s.api.verify(party, s.verify.name, s.verify.category);
  const wallet = await party.openWallet();

  const witnesses: WitnessClient[] = [httpWitnessClient(s.hubWitness.url, s.hubWitness.aid)];
  if (s.principal.witnesses) witnesses.unshift(taskWitnessClient(party.endpoint, s.principal.did));
  const sink = await createAgentTrail({ identity: s.identity, rotationSeed: s.rotationSeed, principalNext: s.principal.next, witnesses, clock: s.clock });
  const model0 = s.models(0);
  const passport = issuePassport(s.operator.identity, s.clock, {
    agent: s.identity.did,
    name: s.name,
    description: s.description,
    operator: { id: s.operator.identity.did, name: s.operator.name },
    accountable: { id: s.accountable.did, name: s.accountable.name },
    runtime: { kind: "llm-agent", provider: model0.id.startsWith("scripted:") ? "scripted" : "anthropic", model: model0.id, toolsHash: toolsHash(toolsFor(s.role)) },
    endpoints: [{ type: "tsp-relay", url: (await s.api.config()).relayUrl }],
    audit: { aid: sink.aid, trail: sink.trailId, witnesses: sink.witnesses },
  });
  await s.hub.putPassport(passport);
  await s.hub.putWorker(signProfile(s.identity, s.clock, { name: s.name, kind: "agent", skills: s.directory.skills, wallet: wallet.token, operator: s.operator.name, credentials: party.credentials, ...(s.directory.rate ? { rate: s.directory.rate } : {}) }));

  const sessions: SessionResult[] = [];
  let chainOfTasks: Promise<unknown> = Promise.resolve();
  let active = 0;
  const runTask = (text: string): Promise<SessionResult> => {
    const run = chainOfTasks.then(async () => {
      active++;
      try {
        const r = await runSession({ model: s.models(sessions.length), guard: guard!, role: s.role, system: s.system, task: text, onTurn: (t) => s.onTurn?.(s.name, t) });
        sessions.push(r);
        return r;
      } finally {
        active--;
      }
    });
    chainOfTasks = run.catch(() => undefined);
    return run;
  };

  guard = new Guard({
    name: s.name,
    identity: s.identity,
    settle: party,
    engine: s.engine,
    audit: sink,
    hub: s.hub,
    status: s.status,
    clock: s.clock,
    passport,
    principal: s.principal.did,
    ...(s.rootCredentials ? { rootCredentials: s.rootCredentials } : {}),
    ...(s.statusRegistry ? { statusRegistry: s.statusRegistry } : {}),
    ...(s.ci ? { ci: s.ci } : {}),
    ...(s.workspace ? { workspace: s.workspace } : {}),
    ...(s.workerRequirements ? { workerRequirements: s.workerRequirements } : {}),
    names: s.names,
    onTask: (text) => void runTask(text),
    onNote: (t) => s.onNote?.(s.name, t),
    ...(s.maxWaitSeconds !== undefined ? { maxWaitSeconds: s.maxWaitSeconds } : {}),
  });

  // A worker agent checks a hirer's mandate before it invoices and before it agrees terms (C2).
  if (s.role === "worker") {
    party.gates = mandateGates({
      me: s.identity,
      engine: s.engine,
      status: s.status,
      requirements: s.workerRequirements ?? { passport: "required" },
      clock: s.clock,
      mint: party.directory.mint,
      arbiter: party.directory.arbiter.did,
      feeFor: (p) => party.feeFor(p),
      name: (d) => s.names(d) ?? d,
      witness: httpWitnessClient(s.hubWitness.url, s.hubWitness.aid),
      onRefused: ({ sender, link, reasons }) => void party.endpoint.notify(sender, JOB_REFUSED, { job: "", link: link.id, reasons }).catch(() => undefined),
      onAllowed: (r) => s.onNote?.(s.name, `checked ${s.names(r.sender) ?? r.sender}'s mandate before invoicing: allowed`),
    });
  }

  const ticker = setInterval(() => {
    void guard!.tick();
    void party.tick().catch(() => undefined);
  }, 1000);
  ticker.unref?.();

  return {
    name: s.name,
    did: s.identity.did,
    role: s.role,
    guard,
    party,
    sink,
    passport,
    sessions,
    running: () => active > 0,
    runTask,
    stop: () => {
      clearInterval(ticker);
      guard!.stopped = true;
      sink.close();
      party.stop();
    },
  };
}
