# 0003: Build Shared To-Do first, on a shared core package

Date: 2026-11-05

## Context

Community Rides' design and plan were written, but not built. The convener asked for "a simpler multi-user TODO app to build first that demonstrates the basic TOIP functionality". Both apps need the same trust plumbing: identities, a demo clock, an in-memory bus, a Trust Task endpoint over TSP, credentials, a status list and a Rego policy loader.

## Options

1. Build the to-do app with its own copy of the plumbing.
2. Move the plumbing into `packages/trust-core/`, build it first, then the to-do app on it, then Community Rides on it.

## Decision

Option 2. That is the case decision 0001 anticipated ("until a second code project needs to share it"). The repository root gets an npm workspace listing `packages/trust-core` and each code project explicitly. Community Rides' plan, Tasks 1 to 4, becomes the shared core's plan. Its remaining tasks are revised to depend on the package when that project is built.

Asked for by the convener (a simpler app first). The shared package was proposed by the assistant.
