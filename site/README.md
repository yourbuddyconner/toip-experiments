# toip.tools

The developer site at https://toip.tools: setup instructions, a quickstart, task-focused guides, library guides, a searchable SDK reference, runnable projects, concepts, an FAQ, and an ecosystem guide. Every page also exists as Markdown, and the site publishes `llms.txt`, JSON indexes and structured data for search engines and AI agents.

## Design

- **Palette.** Warm paper (`#f7f3eb`), evergreen ink (`#1e372f`), and vermilion accents (`#b4462b`). Dark protocol panels use `#142c26`; verification stays green. Focus rings remain blue.
- **Type.** Self-hosted [Recursive](https://github.com/arrowtype/recursive) handles headings, prose, and code, with its `MONO` axis separating code. Body text is 17 px with generous leading and a bounded reading width.
- **The wire.** The home page illustrates a real Trust Task sealed at build time, with sender, recipient, ciphertext, signature, and the document Bob opens. A small exchange diagram introduces the byte view. Reduced-motion and JavaScript-free versions show the complete message immediately.
- **Fingerprints.** Every DID the site prints carries a small 2 by 8 glyph and a hue, both from SHA-256 of the DID, so the same key looks the same everywhere. The wordmark's glyph is the fingerprint of `toip.tools`.
- **Code.** Build-time highlighting uses a custom Shiki theme with distinct colors for comments, keywords, strings, functions, and types. Each panel labels its language, provides a copy button, and scrolls horizontally. Recorded output has a separate light treatment.
- **Images.** Project screenshots open in a native dialog with a caption, close button, Escape dismissal, and focus restoration. Without JavaScript, the links open the original images.
- **Ecosystem.** A directory, approach profiles, and a comparison table distinguish shared specifications from independent implementation choices. Concepts and the home page link to this guide rather than mixing project comparisons into protocol explanations.
- **Navigation.** The home page leads to setup, the quickstart, and the SDK reference. Documentation shares a grouped sidebar that becomes a disclosure menu on mobile. The SDK index includes the illustrated library collection and export search.
- **Concepts.** Implementation notes use separate inset panels with library links, short points, and distinct scope notes.
- Status badges use a shape and a word. Numbered markers are reserved for the quickstart's steps.
- **Social images.** Each page's `og.png` (1200 by 630) uses the paper ground, the wordmark's fingerprint, the page's title in Recursive, a vermilion section label, and a dark code strip with an install command or import.
- **Page tools.** Documentation pages carry a "View as Markdown" link; with JavaScript it gains a "Copy page as Markdown" button. The docs page and `/api/` offer a copyable prompt for coding assistants.

## Run it

```bash
npm install            # at the repository root: the packages the site imports
cd site
npm install            # the site's own tools
npm run dev            # build, serve at http://localhost:4321/, rebuild on change
```

- `npm run build`: build into `dist/`. `SITE_BASE=/ npm run build` builds for the custom domain.
- `npm run preview`: serve `dist/` as built.
- `npm run check`: test syntax highlighting and API extraction, typecheck examples and build scripts, run the quickstart, the runnable snippets and every guide, build strictly, validate the outputs for crawlers and agents (`build/verify-outputs.ts`), check every link, and check dependency licenses. CI runs it before each deploy.
- `npm run quickstart`: run the four quickstart steps.
- `npm run examples:record`: run the examples and guides and save their output to `examples/*/output/`, which the pages show. Run it after changing an example.
- `npm run links -- --external`: also fetch every external link.
- `npm run screenshots`: screenshots of the main pages (guides, FAQ and the docs page included) at 1440 and 390 px, with JavaScript off, and with keyboard focus, into `screenshots/` (not committed). Needs Playwright's Chromium (`npx playwright install chromium`).
- `npm run test:ui`: after building, check ecosystem navigation and layout, homepage scope, and image previews on desktop and mobile. Includes keyboard dismissal, focus restoration, and the JavaScript-free image fallback. Uses Playwright's Chromium.

## How it's built

No framework. `build/build.ts` renders TypeScript template functions (`src/pages/*.ts`) to static HTML, highlights code with Shiki at build time, and copies the fonts. One small script adds copy buttons, SDK search, image previews, and the message animation. All reference pages and image links remain available without JavaScript.

- `examples/quickstart/` and `examples/snippets/` are real programs. `tsconfig.json` maps `@toip-tools/*` to `../packages/*/src/index.ts`, so they import the libraries under their published names today, and after the rename.
- **Spec pages are generated.** `build/specs.ts` finds every `ourSpec("<name>")` in `packages/*/src` and `projects/*/src`, takes each one's doc comment, and joins it with the hand-checked facts in `src/data/spec-notes.json` (purpose, sender and receiver, kind, design section). Payload shapes are extracted from the TypeScript declarations the notes name, so they show what the code says. A new type in code still gets a page; the strict build fails until it has notes, and if a named declaration or design heading disappears.
- Library facts are in `src/data/libraries.ts`, projects in `src/data/projects.ts`, external links in `src/data/links.ts`.
- **SDK pages are generated.** `build/sdk-api.ts` uses the TypeScript compiler to read public source entry points from package exports, including platform subpaths. It extracts signatures, overloads, parameters, option fields, return types, public members, JSDoc, and source locations. `src/data/sdk-guides.ts` supplies task-based guidance and error handling alongside runnable examples.

## Search engines and agents

The build writes, from the same pages as the HTML:

- **A Markdown twin of every page** at `<page>/index.md` (`build/markdown.ts` converts the rendered `<main>`), linked from the page with `<link rel="alternate" type="text/markdown">`. Templates mark interface-only elements with `data-md-skip`, or give replacement text with `data-md`.
- **`/llms.txt` and `/llms-full.txt`** (https://llmstxt.org), from those twins: an index of the most useful pages, and the documentation, guides, library pages, API export lists and Trust Task reference in one file (`build/agent-files.ts`).
- **JSON indexes**: `/api/libraries.json` (packages, entry points and exports, from the SDK reference generator), `/api/specs.json` (Trust Task types) and `/api/examples.json` (projects). `/api/` describes them.
- **`/sitemap.xml`** with each page's lastmod from the last commit to its sources (`Page.sources`, `build/git-dates.ts`), **`/robots.txt`** that allows every crawler and names the AI crawlers, **`/releases.xml`** (Atom, from the packages' `CHANGELOG.md` files; also `/releases/`), and **`/.well-known/security.txt`**.
- **Per-page metadata**: a search-focused `<title>` (`Page.seoTitle`), description, canonical URL, Open Graph and Twitter tags, and JSON-LD (`WebSite` with a `SearchAction` on `/toolkit/?q=`, `TechArticle`, `CollectionPage`, `SoftwareSourceCode` with its `SoftwareApplication`, `FAQPage`, `BreadcrumbList`), from `build/seo.ts`.
- **Social images**: `build/og.ts` draws each page's `og.png` from an HTML template with Playwright's Chromium, cached by content in `.cache/og/`. Without Chromium the strict build fails; run `npx playwright install chromium`.

Guides live in `src/data/guides.ts`, each with one program in `examples/guides/<slug>.ts` that the check runs. The FAQ is `src/pages/faq.ts`.

## Deploying, and switching on toip.tools

`.github/workflows/pages.yml` builds and deploys on every push to `main` that touches `site/`, `packages/` or a project's `src/`. The base path comes from whether `site/public/CNAME` exists: without it, the site is built for `/toip-tools/`; with it, for `/`.

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
