# Tipline

A drop box for whistleblowers. A source proves to a journalist "I am a current member of organization X" without saying which member, sends a tip with documents, and can carry on a conversation. Each tip uses a fresh, unlinkable DID, and the source keeps nothing on their device but a code written on paper.

- **State:** design written, not built.
- **Design:** `docs/design.md`.

## How it works, in brief

1. The organization keeps a group of its members' commitments and signs one Merkle root a day. Each member's own wallet makes and keeps the secret behind their commitment.
2. The source proves in the browser, with a Noir circuit and Barretenberg's UltraHonk in its zero-knowledge mode, that their commitment is under a recent root. The proof also gives a nullifier, which is the same for one member on one story and unrelated across stories.
3. The journalist's inbox checks the proof against the organization's signed root log and labels the source (Source A, Source B) by nullifier. So the journalist can count distinct insiders without knowing any of them.
4. Tips, files and replies are Trust Task documents sealed over TSP through the repository's relay. The design assumes the organization may run that relay.

The anonymous-membership proof is shared with `projects/agora`. Design §13 proposes it as `packages/anon-membership`.
