# toip.tools

The developer site at https://toip.tools: a quickstart, illustrated concepts, library guides, runnable projects, and a reference for every Trust Task type defined in this repository.

## Design

- **Palette.** Cool paper (`#f8f9fb`), white surfaces, and deep blue ink (`#13224a`), with slate (`#44526b`) secondary text and pale rules (`#d4dce7`). Code and the wire sit on navy (`#0f1d3a`). Green (`#0a6b5e`) marks verification and links; magenta (`#a1286a`) marks refusal. Focus rings are blue (`#2350d8`).
- **Type.** One self-hosted family, [Recursive](https://github.com/arrowtype/recursive). Its `MONO` axis separates proportional prose from code, DIDs, bytes, and spec URIs. Headings are bold and tightly spaced; body text is 17 px with generous leading and a bounded reading width.
- **The one bold element: the wire.** The landing page shows a real Trust Task, sealed from Alice to Bob when the site was built: the TSP envelope byte by byte on navy, with the two DIDs readable in the clear, the sealed payload as hex, and the signature, then the document Bob opened on paper below. It fills in once on load (not with reduced motion, and not without JavaScript, where it's simply all there).
- **Fingerprints.** Every DID the site prints carries a small 2 by 8 glyph and a hue, both from SHA-256 of the DID, so the same key looks the same everywhere. The wordmark's glyph is the fingerprint of `toip.tools`.
- **Code.** Build-time highlighting uses a custom Shiki theme with distinct colors for comments, keywords, strings, functions, and types. Each panel labels its language, provides a copy button, and scrolls horizontally. Recorded output has a separate light treatment.
- **Images.** Project screenshots open in a native dialog with a caption, close button, Escape dismissal, and focus restoration. Without JavaScript, the links open the original images.
- Left-aligned columns, section rules, and generous spacing carry the rest. Status badges use a shape and a word; numbered markers are reserved for the stack's layers and the quickstart's steps.

## Run it

```bash
npm install            # at the repository root: the packages the site imports
cd site
npm install            # the site's own tools
npm run dev            # build, serve at http://localhost:4321/, rebuild on change
```

- `npm run build`: build into `dist/`. `SITE_BASE=/ npm run build` builds for the custom domain.
- `npm run preview`: serve `dist/` as built.
- `npm run check`: test syntax highlighting, typecheck every example and snippet against the real packages, run the quickstart and runnable snippets, build strictly, and check every link. CI runs it before each deploy.
- `npm run quickstart`: run the four quickstart steps.
- `npm run examples:record`: run the examples and save their output to `examples/*/output/`, which the pages show. Run it after changing an example.
- `npm run links -- --external`: also fetch every external link.
- `npm run screenshots`: screenshots of the main pages at 1440 and 390 px, with JavaScript off, and with keyboard focus, into `screenshots/` (not committed). Needs Playwright's Chromium (`npx playwright install chromium`).
- `npm run test:ui`: after building, test image previews on desktop and mobile, including keyboard dismissal, focus restoration, and the JavaScript-free fallback. Uses Playwright's Chromium.

## How it's built

No framework. `build/build.ts` renders TypeScript template functions (`src/pages/*.ts`) to static HTML, highlights code with Shiki at build time, and copies the fonts. One small script adds copy buttons, image previews, and the landing page animation. All content and image links remain available without JavaScript.

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
