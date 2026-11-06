# Shared To-Do

Shared to-do lists for a household or small group, with no server you have to trust. Each person runs the app on their own device. Lists sync through a relay that only passes sealed messages along.

Under the hood:
- Every person and every list has its own key and DID, made on the device.
- Membership is a credential the list's key signs, and who is in a list is a roster the list's key signs.
- Every change is a signed operation, sent to each member as an encrypted TSP message, and checked by every device before it is applied.

Built on the Apache-2.0 OpenVTC libraries for TSP and Trust Tasks, through `packages/trust-core`, with the relay in `packages/relay`. It uses none of the P2P Trust Stack's own code, which is GPL (`docs/sources/S03`).

Design: `docs/design.md`. Plan: `docs/plan-v2.md`.

## Run it

Requirements: Node 22.5 or later.

```bash
npm install
npm run dev          # from the repository root: relay on ws://localhost:8787, app on http://localhost:5181
```

## Try it with two people on one machine

Each `?profile=` is a separate device, with its own keys and data in this browser.

1. Open http://localhost:5181/?profile=alice, enter a name, make a list, and add a few items.
2. Open the list's **People** sheet, choose a role, and select **Make an invitation**. Copy the link.
3. In another tab, open http://localhost:5181/?profile=bob, followed by the link's `#invite=…` part. Enter a name, and select **Ask to join**.
4. Alice's tab lets Bob in. Edits now flow both ways.

Other things to try:
- **Private items.** Tick "Private" and choose readers. Everyone else sees a locked row.
- **Offline.** Stop the relay and make changes. The header shows "Offline · n waiting to send". Start the relay again and they go through.
- **Removing someone.** Remove a member, and their later changes are refused everywhere.
- **What's happening.** This panel shows the messages this device sent and received, the checks each change went through, and what the relay can see.

Only one tab per profile can be open at a time.

## Deploy it

- **Relay.** Run `npm start --workspace @zk-toip/relay` anywhere with Node 22.5 or later, behind TLS. Set:
  - `PORT` (default 8787)
  - `RELAY_DB` (the SQLite file, default `relay.db`)
  - `RELAY_PUBLIC_URL`, the exact URL clients use, such as `wss://relay.example.com/v1`, because clients sign it when they authenticate.
- **App.** Run `VITE_RELAY_URL=wss://relay.example.com/v1 npm run build --workspace @zk-toip/shared-todo` and serve `projects/shared-todo/dist/` as static files, over HTTPS.

## Security notes

- **Keys live in the browser's IndexedDB**, unencrypted. The libraries need raw key bytes, so WebCrypto's non-extractable keys can't be used. Any script running on the app's origin could read them. Losing the browser's storage loses the identity, and the admin key of any list it created.
- **Invitations are bearer links.** Whoever opens one first gets in, once, within 7 days. Send them only to the person you mean.
- **What the relay learns:** which DIDs connect, who messages whom, when, and how much. It can't read lists, forge or alter changes, or decide who is in. It could drop or delay messages. Devices catch up from each other with sync.
- **Device clocks set the order of edits.** The last edit wins, so a device whose clock is wrong can win or lose against others. Edits more than 5 minutes in the future are refused.
- **A removed member keeps their copy.** Removal stops their future changes. It can't make them forget.

## Tests

```bash
npm test                                # every package
npm test --workspace @zk-toip/shared-todo
```

- **Unit tests:** the checks, the signed roster, and a permutation test showing every arrival order gives the same list.
- **Integration tests:** several devices over a real relay, covering:
  - joining while the inviter is offline
  - reused and expired invitations
  - private items
  - refused changes
  - offline outboxes
  - sync
  - revocation, with history kept for later joiners
  - replayed old rosters
  - restarts
  - no item text ever in the relay's database
- **A UI smoke test.**

## Where we guess about the stack

- Relationships start with the first Direct TSP message, not the RFI/RFA handshake.
- `did:key` instead of `did:peer:4`.
- Invitations are OOBI-style links, not the stack's OOBI format.
- A list is a community whose key its creator holds. Real VTCs have a governance document and M-of-N signing.
- The relay is our own WebSocket mailbox, not TSP Routed Mode or the stack's libp2p relays.
- Message types are ours, under `https://zk-toip.example/spec/todo/…`.
- Whether the OpenVTC libraries interoperate with the P2P Trust Stack's own implementation wasn't checked.
