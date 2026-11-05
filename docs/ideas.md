# Ideas

Ours, from 2026-11-05. Claims about the stack are from S01, a summary only.

## Why peer-to-peer may suit client-side proving better

- No central decision point to replace. Each peer already decides and enforces.
- Peers already hold their own credentials on the device.
- The verifier often owns the resource, which removes a zk-pdp open question: where the resource's record comes from.
- Joining, delegating and checking authority are rare compared with web requests, so seconds of proving may be acceptable.
- Proofs of 15 KB (Noir) or 125 KB (GordieHowe) fit in a message.

## Opportunities

1. **Community rules as compiled policies.** Write a community's governance rules in Cedar and compile them. A member proves they meet the rules without showing which credentials they hold. Fits the planned roles, delegation and voting, and Cedar's analysis tools can check the rules themselves.
2. **R-Card claims "only through a zero-knowledge proof".** The level exists, but no protocol is given. Commit the claims as zk-pdp commits records, and answer a Cedar question about them with a decision and a proof. This is the most direct fit.
3. **AI agents bound to a mandate.** A delegation credential carries the hash of a Cedar mandate. The agent proves each action is within it, and the counterparty never sees the whole mandate.
4. **Trust Tasks as proved decisions.** A membership, signing-authority or compliance check returns a decision with a proof, the same shape as zk-pdp's AuthZEN responses, carried in `TSP_GEN_CONFIDENTIAL`.
5. **Hidden paths through the trust graph.** "Is this agent in community Y, perhaps through a chain of delegations" is Cedar's `in`. zk-pdp's records carry ancestor lists, so membership can be proved without revealing the chain.

## Without changing their protocol

Encrypted messages carry application payloads, so a decision with its proof can be an ordinary app message.

1. A community app keeps its members' facts and signs the Merkle root. zk-pdp's signed mode does this with P-256 and, since E13, with Ed25519.
2. The community's own identifier vouches for that signing key in an ordinary credential. That binding is public, so the verifier checks it outside the proof.
3. A member's app proves "the rules allow me to do X" and sends the proof as a message.

Limits: the facts are as good as the community app that signs them, and are not traced to each two-party credential. Their "zero-knowledge only" level needs agreement on a format. Revocation and linkability are unsolved in zk-pdp.

## Demos that need nothing from them

- **Community gate:** prove "allowed to post, join or vote under these rules" without showing which credentials.
- **Agent mandate:** an agent proves an action is within a Cedar mandate whose hash a delegation credential carries.

## Larger steps

- Prove over their two-party credentials directly: parse a W3C credential and check its Ed25519 signatures inside the circuit. One signature check costs about 437,000 gates today (zk-pdp E13), and a credential signed by both parties needs two.
- Unlinkable proofs, so the same signed root does not tie a member's proofs together across peers.
