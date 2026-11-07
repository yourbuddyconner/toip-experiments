# Agents

Agent passports and mandates. An AI agent gets its own identity and a bounded, revocable authority to act for a person or an organization. It hires people and other agents on Settle, and everything it does goes into a signed log its principal can check.

- Design: `docs/design.md`. Its last section, "Implementation notes", says what was built and how it differs.
- Status: **a working MVP.** The demo runs end to end on a local Settle network, with scripted models or with Claude.

## Run it

```bash
npm install          # at the repository root
npm run agents       # the console at http://localhost:4330, Dana's view at http://localhost:4330/courier
```

One command starts a whole world in one process:
- a Settle network on its own local cluster (relay, processor, arbiter, Settle Verify, faucet);
- the hub: status lists, a worker directory, passports, and a witness for agents' trails;
- Conner Swann's device (the principal), Dana Ruiz's device (a human courier), a CI attester, and QuickFix (a hostile worker);
- three agents: Ops agent, its sub-agent Errands agent, and Coder agent (run by Byte Works).

In the console, issue Ops agent's mandate, fund it, and send it the task. Open the courier view in a second window to be Dana: quote the errand, then deliver it. Back in the console, approve the payment over the limit, select **Package received**, review the trails, and revoke Errands agent's mandate. Then give Errands agent another errand and see it refused.

Settings:
- `--live` uses Claude if credentials work (the SDK's usual chain: `ANTHROPIC_API_KEY`, or an `ant auth login` profile): `claude-opus-5-5` for Ops agent, `claude-sonnet-5-5` for Coder agent, `claude-haiku-5-5` for Errands agent. Without credentials, it says so and uses the scripted models.
- `--static` serves the built pages (`npm run build:web --workspace @toip-tools/agents` first). `--auto-courier` makes Dana quote and deliver by herself.
- Ports: `AGENTS_PORT` (4330), `AGENTS_HUB_PORT` (4331), `AGENTS_SETTLE_PORT` (4332), `AGENTS_RELAY_PORT` (4333), `AGENTS_RPC_PORT` (4334). `HOST` defaults to this machine only.
- Everything is in memory. Stopping the app throws the world away.

## The terminal demo

```bash
npm run demo --workspace @toip-tools/agents             # scripted models, no key needed, a few seconds
npm run demo --workspace @toip-tools/agents -- --live   # Claude, if credentials work
```

It narrates the design's story (§14.3), using free ports:
1. Conner issues Ops agent its mandate and funds its wallet with 150 USDC.
2. Ops agent offers the fix to Coder agent and QuickFix. Coder quotes 20 USDC. The guard allows 20.50 with the fee. Coder's device checks Ops agent's mandate before it invoices.
3. QuickFix's quote names itself as the attester, asks 150 USDC, and carries a prompt injection. The demo sends that hire straight to the guard, as a compromised model would. It is refused with reasons, and no approval request goes to Conner.
4. Coder fixes the bug and delivers a commit. CI clones it, runs `node --test`, and attests. The escrow pays Coder.
5. Ops agent delegates errands to Errands agent: 30 a payment, 60 in total, one day, no further delegation, funded with 60.
6. Errands agent offers Dana the errand. Her 45 USDC quote is over its limit, so the guard asks Conner. He approves that exact action. The guard checks out by itself. Dana's device shows who stands behind the payment.
7. Dana delivers. Conner confirms. Dana is paid.
8. Conner reviews both trails ("chain intact, receipted by you and the hub, no duplicity") and revokes Errands agent's mandate. Its next errand is refused.
9. It prints each trail's head and writes export bundles that verify offline.

## What's here

| Path | What |
|---|---|
| `src/guard/guard.ts` | The guard. It holds the identity, the Settle party and the trail. Every gated tool becomes an action, decided against the whole chain with `packages/mandates`. Allowed spends are witnessed before they move. Escalations go to the principal, and an approved action is carried out by the guard, not the model. Budgets, used approvals and snapshots. |
| `src/guard/api.ts` | `GuardApi`: the only thing the loop imports. Types only. |
| `src/guard/gates.ts` | A worker's gates (Settle's S1): the presentation must match the payment link and verify before invoicing; the terms must match it before accepting. It also checks and endorses the presentation's trail entry at the hub's witness. |
| `src/guard/workspace.ts` | Coder agent's files: a clone of the job's repository, with paths confined to it. |
| `src/loop/` | The loop and its tools. `ModelClient` with `AnthropicModel` (manual tool-use loop on `client.beta.messages.create`), `ScriptedModel` and `ReplayModel`. |
| `src/audit/sink.ts` | The agent's trail through `packages/eventlog`. Its AID's next keys are the agent's and the principal's. Witnessed by the principal's device and the hub. |
| `src/passport.ts` | Passports: the operator's signed claim about the agent, its model and its tools. |
| `src/roles/` | The principal's device, the CI attester, Dana's device, QuickFix, the agents' assembly, system prompts and scripts. |
| `src/hub/` | The hub server and its client. |
| `src/app/` | The app server: the console's and the courier view's JSON API, and the web pages. |
| `src/world.ts`, `src/story.ts`, `src/demo.ts` | The whole cast in one process, the story, and the narrated demo. |
| `web/` | The console and the courier view (React). `web/e2e.ts` drives both through the demo in a browser. |
| `sandbox/demo-repo/` | A tiny repository with a bug and a failing `node --test`. |

## Tests

```bash
npm test --workspace @toip-tools/agents      # no key, no network
npm run e2e --workspace @toip-tools/agents   # the console and the courier view in a real browser; screenshots in web/e2e-shots/
AGENTS_LIVE=1 npm test --workspace @toip-tools/agents   # also runs tests/live.test.ts with Claude (needs credentials)
```

The tests cover:
- the guard with a Settle spy: over-limit refusals with no checkout, budgets to the unit, two hires racing for the last of a budget, categories, revocation, stale lists, pausing, failing closed with no witness, escalation with grant, deny and lapse, approvals bound to one action, forged and reused approvals, delegations that only narrow;
- the loop/guard boundary: the loop's imports can't reach a key, the party or the log; bad tool inputs and unknown tools never reach the guard;
- compromised scripted models trying everything a hostile model would;
- a rogue hirer refused by a worker's gates;
- the audit trail: an entry for every turn, call and decision, verification, tampering, dropped entries, duplicity, trail references, offline bundles;
- restarting mid-escalation from a snapshot;
- the models: determinism, replay, the Anthropic request, refusal, `pause_turn` and `max_tokens`;
- the flows on a local Settle network: the whole story, CI failing then passing, and a rogue hirer.

## Not built yet

- The guard in its own process, or on a hardware key. Solana token delegation as the ceiling. The funded wallet is the hard limit for now.
- The console and Dana's view hold their keys in the app's process, not in the browser. The pages are their screens.
- A sandboxed CI runner and real CI (GitHub checks).
- Approvers below the root, push notifications, disputes started by the principal.
- Persistence across restarts of the app. The guard can snapshot and restore; the app doesn't save yet.
- KERI delegation for agents' AIDs, and key rotation from the console.
