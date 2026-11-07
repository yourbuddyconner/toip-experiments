# Agents

Agent passports and mandates. An AI agent gets its own identity and a bounded, revocable authority to act for a person or an organization. It hires people and other agents on Settle, and everything it does goes into a signed log its principal can check.

- Design: `docs/design.md`.
- Status: **design written, not built.**

## The idea

- **Passport.** The agent has its own `did:key` and TSP endpoint, and a credential from its operator saying who runs it, which model and harness it uses, and who is accountable.
- **Mandate.** The principal signs a delegation credential: how much the agent may spend (per payment, per day, in total), with whom, for what work, which Trust Tasks it may send, until when, and whether it may pass a narrower mandate to a sub-agent. A chain of mandates can only narrow. Mandates are revoked through status lists.
- **The guard.** Deterministic code between the model and the keys. Every tool call that commits money or sends a Trust Task is checked against the mandate chain first, with a Rego policy (opa-wasm, as in Settle) that returns reasons in plain words. The model never holds a key.
- **Counterparties check too.** A worker verifies the agent's mandate chain before it invoices and before it accepts terms, so even a compromised agent can't pay outside its bounds with an honest worker.
- **Escalation.** A request beyond the mandate goes to the principal over TSP. The principal approves that one exact action, and the guard carries it out.
- **Audit.** Every model turn, tool call, decision, approval and payment goes into a hash-chained, signed event log (from `projects/trail`). The principal's console witnesses its heads, so history can't be quietly rewritten.

## The demo, when built

Claude agents on a local Settle network: Ops agent hires Coder agent to fix a failing test, paid when CI passes; refuses a prompt-injected quote; delegates errands to a sub-agent, which hires a human courier and asks the principal to approve a payment over its limit. Then the principal reviews the log and revokes the sub-agent. About three minutes. It runs without an API key using scripted models.

## What it builds on

- `packages/trust-core`: identities, TSP, Trust Task documents, credentials, status lists, Rego policies, the relay.
- `projects/settle`: payment links, checkout, escrow, attesters, the processor and the arbiter. Three small Settle changes are listed in the design (§11.4).
- A proposed shared library, `packages/mandates`, general enough for devices in `projects/capture` (design §16).
