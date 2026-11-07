# Settle Arbitration: rules for payments made by agents

Date: 2026-11-06. These rules add to how Settle Arbitration decides disputes. They cover one case: a payment where the payer was a software agent acting for someone else (agents design §4.5, §11.4 S4).

## What counts as evidence

1. **The mandate presentation.** An agent shows the payee a signed presentation before it pays. It holds the mandate chain from the principal down to the agent, any approvals, and the exact action: payee, price, fee, attester, arbiter, dispute window and token. The payee keeps it with the payment.
2. **The agent's audit trail.** The principal or the agent may export the agent's signed, witnessed log. The arbiter checks it offline.
3. **The usual Settle evidence.** Terms, acceptances, attestations, disputes and receipts.

## How the arbiter weighs a presentation

1. The arbiter re-runs the mandate decision for the payment, from the presentation, with the status lists as they were at the time of the payment, as far as the evidence shows them.
2. **A payee who checked.** If the presentation verified at the time and the terms matched the presented action, the payment was within the agent's authority as far as the payee could know. The principal can't undo it by saying the agent shouldn't have paid. The ordinary rules on the work itself still apply.
3. **A payee who didn't check.** If the payee accepted an agent's payment without a presentation, or with one that didn't verify at the time, or with terms that didn't match it, the payee bears that risk. If the principal shows the payment was outside the mandate, the arbiter may rule the money back to the payer, less the processor's fee.
4. **An approval.** A payment over a limit counts as authorized if the presentation carried a valid approval, signed by an issuer in the chain over the hash of that exact action.
5. **A revoked mandate.** A mandate revoked before the payment doesn't authorize it, once the revocation was published. A payee who checked with a status list that was fresh enough under the mandate's limit (one hour by default) is treated as having checked.
6. **The trail.** A trail that shows a different history from the presentation, or two versions of one entry, counts against the side that produced it.

## What the arbiter doesn't decide

- Whether the agent was wise to pay. Only whether it was authorized, and whether the work was done.
- Anything about the model the agent runs. A passport is its operator's claim, and the operator answers for it.
