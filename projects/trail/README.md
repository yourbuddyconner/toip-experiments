# Trail

Verifiable audit trails for AI agents, devices and services, and the shared event-log library under them.

- Design: `docs/design.md`.
- Status: design written, not built.

## What it is

Trail is two things:

1. **`packages/eventlog`** (`@zk-toip/eventlog`), a library. It keeps append-only, hash-chained, signed logs that the writer can't quietly edit, truncate or fork. Keys rotate, and old signatures still verify against the key state of their time.
2. **`projects/trail`**, a small service and explorer that proves the library works. It runs three witnesses and a watcher, and a web explorer for reviewing a trail.

## How it uses KERI

Each identity is a KERI AID with a key event log in real KERI 1.0 format. That gives pre-rotation and recovery from a stolen key, and KERIpy can verify the log. On top of it, Trail adds **trails**: our own audit logs, owned by an AID, sealed into its key event log, and receipted by the same witnesses. Witnesses receipt only the first version they see, and watchers detect two versions of the same entry. Entry contents stay with the writer and whoever it discloses them to. Witnesses see only small headers.

`did:key` stays the identity for TSP and signed documents. A two-way binding links it to the AID.

## Who uses it

- `projects/agents`: every action an agent takes, reviewable by its principal and checkable by counterparties.
- `projects/capture`: device key histories, and captures that verify after the device rotates its keys.
- `projects/settle`: a later replacement for the processor's transparency log.
- `projects/mesh`: a compact binary form of every message, for Bluetooth and LoRa.

## The demo, when built

An agent, Scout, works for Ada. The demo shows:
1. a forged edit caught;
2. a fork shown to a supplier caught;
3. a witness that signs two versions caught;
4. a stolen key rotated away, with the attacker's entries marked as cut;
5. a camera's photos verifying across key rotations.

See section 15 of the design.
