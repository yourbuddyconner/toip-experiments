# 0004: Shared To-Do becomes a working app

Date: 2026-11-05

## Context

v1 of Shared To-Do was a scripted, single-page demo: four simulated devices and a relay in one browser page, driven by a "next step" button. The convener's response: "I don't want a demo on rails, I want a practical application that would be as close to reality as possible".

## Options asked, and the convener's answers

- Platform: an installable web app (chosen), a mobile app, or desktop/CLI.
- Network: a relay server we write (chosen), peer-to-peer first, or local only.
- Trust mechanics: an optional inspector (chosen), or a plain app only.

## Decision

Replace v1 with a working app (design v2):
- one browser profile is one person's device, with keys and data persisted in IndexedDB
- devices reach each other through a WebSocket relay (`packages/relay`) that authenticates DIDs and queues sealed TSP messages for offline devices
- an inspector shows this device's messages and checks

`packages/trust-core`, the operation format, the checks and the Rego rules carry over. The scripted world, scenario and single-page UI are removed. They stay in git history at commit `b3e9fd7`.

Choices by the convener as above. Design by the assistant.
