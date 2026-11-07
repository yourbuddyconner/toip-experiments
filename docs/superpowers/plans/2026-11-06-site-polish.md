# Site Copy and Visual Polish Implementation Plan

**Goal:** Give the GitHub Pages site clear, connected prose, a polished reading experience, and visible syntax highlighting, then commit and push as requested.

**Architecture:** Keep the static TypeScript templates, self-hosted Recursive font, and build-time Shiki highlighting. Edit reader-facing copy in `site/src/pages/`, `site/src/data/`, and `site/src/layout.ts`; refine the shared stylesheet rather than introduce a framework.

**Tech stack:** TypeScript templates, CSS, Shiki, Node test runner, Playwright.

## Editorial and visual direction

Lead with what developers can build, then explain the stack and offer a concrete next step. Use shorter sentences, consistent terminology, and precise descriptions of implemented features and limitations. Preserve technical examples and protocols. Retain the paper, navy ink, and green verification palette; use stronger hierarchy, generous spacing, restrained surfaces, and readable code colors.

The user requested autonomous completion, including commit and push; proceed without intermediate approval gates.

## Tasks

- [x] Rewrite the home page, quickstart, concepts, toolkit, examples, contribution page, shared footer, and spec-page introductions. Tighten library and project descriptions. Check factual statements against the existing source and retain material limitations.
- [x] Reproduce the monochrome code output in `site/build/highlight.ts` with a regression test covering TypeScript, shell, and JSON. Run it before the fix, correct the theme rules that mask token colors, and run it again. Include the test in `site/package.json`'s check command.
- [x] Refine `site/src/styles/site.css` and shared template details: typography, navigation, hero, section spacing, tables, sidebars, figures, code captions, and mobile layout. Keep keyboard focus and reduced-motion behavior.
- [x] Add the user's requested image modal in `site/src/scripts/site.js`. Verify desktop and mobile opening, caption and alt text, Escape, close button, backdrop dismissal, focus restoration, and the JavaScript-free fallback with `site/build/ui.test.ts`.
- [x] Run `npm run check` from `site/`. Inspect desktop and mobile renders of the home page, quickstart, concepts, library reference, examples, and specs. Check for horizontal page overflow, highlighted code, JavaScript-free content, and keyboard access. The browser plugin has no callable runtime in this session, so use the repository's Playwright tooling as the available fallback.
- [ ] Review the final diff, commit the authorized changes, push `main`, and check the Pages workflow.
