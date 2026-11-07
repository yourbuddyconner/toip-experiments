# AGENTS.md

Guidance for AI coding agents working in this repository, and for agents helping someone use the `@toip-tools` libraries.

## If you're helping someone use the libraries

- The libraries are on npm under `@toip-tools/*`. Install only what's needed, e.g. `npm install @toip-tools/trust-core`. They need Node 22.13 or later; browser entry points work through a bundler.
- Documentation for agents: https://toip.tools/llms.txt (an index) and https://toip.tools/llms-full.txt (everything in one file). Every page also has a Markdown version.
- Start from the quickstart (https://toip.tools/quickstart/) and the SDK reference (https://toip.tools/toolkit/). Each library's README in `packages/<name>/README.md` lists its API.
- Which library does what:
  - `trust-core`: did:key identities, signed and encrypted Trust Tasks over TSP (the Trust Spanning Protocol), W3C verifiable credentials, status lists, local policy.
  - `relay`: a WebSocket mailbox for TSP messages.
  - `cose`: deterministic CBOR and COSE_Sign1 (Ed25519, P-256, passkeys).
  - `web-vault`: browser key storage sealed by a passkey or passphrase.
  - `mandates`: delegation with limits for people and AI agents.
  - `anon-membership`: zero-knowledge group membership (Noir).
  - `eventlog`: KERI key event logs and witnessed audit trails.
  - `mesh-transport`: TSP over LoRa radio and carried files.
- Trust Task types are URLs like `https://toip.tools/spec/settle/escrow/attest/0.1`. Each one is a page that describes the message.

## Repository layout

- `packages/`: the published libraries (`@toip-tools/<name>`), one npm workspace each.
- `projects/`: working applications built on them (Settle, Agents, Trail, Tipline, Agora, Capture, Mesh, Shared To-Do), plus design-only ideas. Each has `README.md` and `docs/design.md`.
- `site/`: the toip.tools site. It's a custom TypeScript build, not an npm workspace, and has its own `npm install`.
- `docs/`: decisions, sources and a notebook (see `docs/provenance.md`).

## Commands

```bash
npm install               # at the root; links every workspace
npm test                  # every package and project
npm run typecheck         # every workspace
npm run build             # the libraries' dist/ (not needed for tests or apps)
npm run licenses          # dependency check; must pass before adding a dependency
npm run settle            # or agents, trail, tipline, agora, capture, mesh: runs that app and prints its URLs
npm run e2e --workspace @toip-tools/<project>   # a project's browser test (Playwright)
cd site && npm install && npm run check         # the site: typecheck, run every example, strict build, links
```

## Conventions

- **Source condition.** Inside the repo, packages resolve to `src/` through the `@toip-tools/source` export condition, so tests, `tsx` and Vite run TypeScript directly with no build step. Published packages resolve to `dist/`.
- **Imports.** Relative imports in `packages/*/src` must use explicit `.js` extensions (`./clock.js`), or the published packages won't load in Node.
- **Changes to a library** need a changeset (`npx changeset`). The libraries share one version. See `RELEASING.md`.
- **Tests.** Use port 0 for servers in tests. Projects' default ports are 4300–4369; don't use 8787/8788.
- **New dependencies.** Pin exact versions. Run `npm run licenses` after adding one.
- **Trust Task types** are declared with `ourSpec("<name>")`. The site's spec pages are generated from those declarations, and `site/src/data/spec-notes.json` needs an entry for each new type, or the site's strict build fails.
- **Design first.** A project or library starts as `docs/design.md`; record decisions in it, and add implementation notes when it's built.
- **Writing.** Plain, short sentences in docs. Commits carry no AI attribution trailers.
