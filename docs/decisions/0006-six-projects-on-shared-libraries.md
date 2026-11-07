# 0006: Six new projects, built on shared libraries

Date: 2026-11-06

## Context

After Settle, the convener picked six ideas to build: a whistleblower drop box (Tipline), credential-gated anonymous forums (Agora), AI agent passports and mandates with agents hiring people and each other on Settle (Agents), verifiable audit trails, maybe with KERI (Trail), cameras and sensors with identities (Capture), and Trust Tasks over Bluetooth and LoRa (Mesh). The convener asked for a specification per project, a set of common libraries the projects share, and an MVP of each.

Each project's design is in `projects/<name>/docs/design.md`. Each design ends with what it needs from shared code.

## Options

1. Each project carries its own copy of what it needs.
2. One library per need that more than one project has, in `packages/`, built before the projects.

## Decision

Option 2. The libraries, and who uses them:

| Package | Owner design | Used by |
|---|---|---|
| `packages/anon-membership` | Tipline §13, extended by Agora §14.1 and §14.2 (group registrars and signed root logs are part of it) | Tipline, Agora |
| `packages/eventlog` | Trail §13, with Agents §16.4 and Capture §19.4 | Trail, Agents, Capture; later Settle's transparency log |
| `packages/mandates` | Agents §16 | Agents; Capture for owner-to-device delegation |
| `packages/cose` | Capture §19.1 | Capture, Mesh |
| `packages/web-vault` | Settle's `web/src/vault.ts`, moved | Settle, Tipline, Agora, Capture |
| `packages/mesh-transport` | Mesh | Mesh, Capture |

Agora's proposed `feed` package is not separate: a forum host's feed is a trail in `packages/eventlog`. Capture's `provenance` code stays in `projects/capture`, because nothing else uses it.

The libraries are built first, each with its tests, then the projects on top of them. A library changes to suit a project only through its owner design's API, so the projects stay compatible.

Asked for by the convener (specs, common libraries, MVPs, written by parallel agents). The split into these six packages was proposed by the assistant from the six designs.
