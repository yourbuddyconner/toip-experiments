# Community Rides

A straw-man ride-share for a local community, built on the OpenVTC TypeScript libraries, an implementation of the ToIP specs the P2P Trust Stack uses (TSP, Trust Tasks). For show and tell: it makes "the community vouches, peers verify" concrete, and shows what each party learns at each step.

State: design written, not built. Read `docs/design.md`.

Built on `@openvtc/vti-tsp-js`, `@openvtc/trust-tasks`, `@openvtc/trust-tasks-tsp` and `@openvtc/trust-tasks-proof` (see `docs/sources/S02-trust-tasks-registry-and-openvtc.md` at the repository root), with Rego policies through OPA.
