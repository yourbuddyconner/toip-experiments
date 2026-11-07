# toip.tools

The developer site for this repository: a quickstart, concepts, a page per library, the examples, and a page per Trust Task type. It will be served at https://toip.tools; until that domain is set up, at https://yourbuddyconner.github.io/toip-experiments/.

## Design

- **Palette.** Paper and ink: a cool paper (`#eef1f5`) and a deep blue ink (`#13224a`) for text, with a slate (`#44526b`) for secondary text and hairline rules (`#b9c3d1`). Code and the wire sit on a deeper navy (`#0f1d3a`). One green (`#0a6b5e`) means *verified* and underlines links; a magenta (`#a1286a`) means *refused*. Focus rings are a strong blue (`#2350d8`).
- **Type.** One family, [Recursive](https://github.com/arrowtype/recursive), self-hosted. Its `MONO` axis splits the page in two: proportional for what people read, monospace for what machines exchange (code, DIDs, bytes, spec URIs). Headings are heavy (780 to 850) and tight. Body is 17 px with a 1.25 scale, and prose stays under about 70 characters a line.
- **The one bold element: the wire.** The landing page shows a real Trust Task, sealed from Alice to Bob when the site was built: the TSP envelope byte by byte on navy, with the two DIDs readable in the clear, the sealed payload as hex, and the signature, then the document Bob opened on paper below. It fills in once on load (not with reduced motion, and not without JavaScript, where it's simply all there).
- **Fingerprints.** Every DID the site prints carries a small 2 by 8 glyph and a hue, both from SHA-256 of the DID, so the same key looks the same everywhere. The wordmark's glyph is the fingerprint of `toip.tools`.
- Everything else stays quiet: left-aligned columns, rules instead of cards, statuses as a shape plus a word, numbers only where there is a real sequence (the stack's layers, the quickstart's steps).

## Run it

```bash
npm install            # at the repository root: the packages the site imports
cd site
npm install            # the site's own tools
npm run dev            # build, serve at http://localhost:4321/toip-experiments/, rebuild on change
```

- `npm run build`: build into `dist/`. `SITE_BASE=/ npm run build` builds for the custom domain.
- `npm run preview`: serve `dist/` as built.
- `npm run check`: typecheck every example and snippet against the real packages, run the quickstart and the runnable snippets, build strictly, and check every link. CI runs it before each deploy.
- `npm run quickstart`: run the four quickstart steps.
- `npm run examples:record`: run the examples and save their output to `examples/*/output/`, which the pages show. Run it after changing an example.
- `npm run links -- --external`: also fetch every external link.
- `npm run screenshots`: screenshots of the main pages at 1440 and 390 px, with JavaScript off, and with keyboard focus, into `screenshots/` (not committed). Needs Playwright's Chromium (`npx playwright install chromium`).

## How it's built

No framework. `build/build.ts` renders TypeScript template functions (`src/pages/*.ts`) to static HTML, highlights code with Shiki at build time, and copies the fonts. Pages ship one small script for copy buttons and the landing page's one animation; every page reads the same without it.

- `examples/quickstart/` and `examples/snippets/` are real programs. `tsconfig.json` maps `@toip-tools/*` to `../packages/*/src/index.ts`, so they import the libraries under their published names today, and after the rename.
- **Spec pages are generated.** `build/specs.ts` finds every `ourSpec("<name>")` in `packages/*/src` and `projects/*/src`, takes each one's doc comment, and joins it with the hand-checked facts in `src/data/spec-notes.json` (purpose, sender and receiver, kind, design section). Payload shapes are extracted from the TypeScript declarations the notes name, so they show what the code says. A new type in code still gets a page; the strict build fails until it has notes, and if a named declaration or design heading disappears.
- Library facts are in `src/data/libraries.ts`, projects in `src/data/projects.ts`, external links in `src/data/links.ts`.

## Deploying, and switching on toip.tools

`.github/workflows/pages.yml` builds and deploys on every push to `main` that touches `site/`, `packages/` or a project's `src/`. The base path comes from whether `site/public/CNAME` exists: without it, the site is built for `/toip-experiments/`; with it, for `/`.

Once, in the repository's **Settings → Pages**, set **Source** to **GitHub Actions**.

To move to the custom domain:

1. At the domain's DNS provider, add records for the apex `toip.tools`:
   - `A` records: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `AAAA` records: `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`
   - and for `www`: a `CNAME` record pointing to `yourbuddyconner.github.io`.
2. Optionally, verify the domain for your account first (GitHub **Settings → Pages → Verified domains**), so nobody else can claim it.
3. Add the file `site/public/CNAME` containing the single line `toip.tools`, and push to `main`. The workflow then builds with base `/` and origin `https://toip.tools`.
4. In **Settings → Pages**, enter `toip.tools` as the custom domain, wait for the DNS check, then tick **Enforce HTTPS**.

Spec URIs already use `https://toip.tools/spec/<name>/0.1`, whatever the site is served from.
