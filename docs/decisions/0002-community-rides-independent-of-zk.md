# 0002: Community Rides is independent of zk-pdp

Date: 2026-11-05

## Context

The first draft of the Community Rides design added a "zero-knowledge mode" built on zk-pdp, and chose Cedar for its policies so the same policy could be decided in the clear or proved. The convener clarified the repository's scope: it has moved beyond zk-pdp. Applying zero-knowledge proofs to ToIP is one project in it (`projects/zk-pdp-fit/`), and the ride-share has nothing to do with zk-pdp, "though policies are likely a thing".

## Decision

Community Rides has no zero-knowledge mode and doesn't depend on zk-pdp. With Cedar's only reason gone, its policies are Rego, the stack's own policy language (S02), compiled to WebAssembly with OPA.

A ZK version of a ride-share check stays a possible demo for the `zk-pdp-fit` project. It is not part of this one.

Clarified by the convener. Rego chosen by the assistant.
