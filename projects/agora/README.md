# Agora

Forums where every post is anonymous, but posting needs a credential. "Only licensed RNs post here." "Only residents of district 7 vote in this poll." Each person has one pseudonym per forum, so there are no sockpuppets. A person's pseudonyms in different forums can't be linked.

- Design: `docs/design.md`.
- State: **design written, not built.**

## How it works, in short

1. **An issuer issues a credential, as it does today.** For example, a licensing board, an employer or a city.
2. **The member joins a group.** They show the credential to a registrar once, with a commitment to a secret only their device knows. The registrar adds a leaf to a Merkle tree and publishes signed roots.
3. **The member proves.** Once a day per forum, they prove in zero knowledge: "my leaf is in one of these groups, my attributes meet this forum's rules, and this is my pseudonym here." The pseudonym is a hash of their secret and the forum. The proof binds a fresh session key, and their posts are signed with it.
4. **The host checks and stores.** It checks proofs and signatures, enforces one pseudonym per person, bans and rate limits, and keeps a signed, append-only feed. It can't tell who wrote anything. Readers check everything themselves.
5. **Polls work the same way.** Each vote is its own proof against roots pinned when the poll opened, with a nullifier for that poll. So there's one vote per person, and ballots are secret.

## What it needs from shared code

| Package | For |
|---|---|
| `packages/anon-membership` | the gate circuit: membership, attribute predicates, nullifiers |
| `packages/anon-groups` | registrars and root logs (proposed) |
| `packages/feed` | the signed append-only feed (proposed) |
| `packages/vault` | Settle's passkey vault, moved into a package (proposed) |
| `packages/trust-core` and `packages/relay` | identities, signed documents, credentials, status lists, TSP |

`projects/tipline` owns the design of `packages/anon-membership`. Design section 14 says what Agora needs from it.
