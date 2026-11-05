# 0001: A monorepo of projects

Date: 2026-11-05

## Context

The repository started as one ideation thread: where zk-pdp fits the P2P Trust Stack. The convener now also wants a straw-man application, a community ride-share, to show at meetings. More ideas and builds may follow.

## Options

1. Keep one thread, and put the app in another repository.
2. Make this a monorepo: one folder per project under `projects/`, with sources, decisions, the notebook and the provenance rules shared at `docs/`.

## Decision

Option 2. The first ideation thread moved to `projects/zk-pdp-fit/` with its history kept (`git mv`). The ride-share is `projects/community-rides/`. A code project's tooling stays inside its own folder until a second code project needs to share it.

Proposed by the convener ("make this a monorepo of projects / ideas"). Layout by the assistant.
