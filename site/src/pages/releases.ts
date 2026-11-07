import { u } from "../../build/config";
import type { Release } from "../../build/changelogs";
import { code } from "../../build/highlight";
import { html, md } from "../../build/html";
import { npmUrl } from "../../build/seo";
import { docsNav } from "../docs-nav";
import type { Page } from "../layout";
import { pageHead } from "../parts";

export const releaseId = (r: Release) => `${r.library}-${r.version.replace(/\./g, "-")}`;
export const FEED_PATH = "/releases.xml";

export function releasesPage(releases: Release[]): Page {
  const body = html`<div class="wrap docs">
  ${docsNav("/releases/")}
  <div class="docs__content">
    ${pageHead("Releases", "Every published version of the @toip-tools libraries, from their changelogs.")}
    <div class="prose"><p>Subscribe with the <a href="${u(FEED_PATH)}" type="application/atom+xml">Atom feed</a>. The libraries are versioned together; install a release with its exact version:</p></div>
    ${code(releases.length ? `npm install ${releases[0].name}@${releases[0].version}` : "npm install @toip-tools/trust-core", "bash", { caption: "Terminal" })}
    ${releases.map((r) => html`<section class="release prose" id="${releaseId(r)}" aria-labelledby="${releaseId(r)}-h">
      <h2 id="${releaseId(r)}-h"><code>${r.name}</code> ${r.version}</h2>
      <p class="small quiet">${r.date ? html`<time datetime="${r.date}">${r.date.slice(0, 10)}</time> · ` : ""}<a href="${npmUrl(r.name, r.version)}">${r.name}@${r.version} on npm</a> · <a href="${u(`/toolkit/${r.library}/`)}">Documentation</a></p>
      ${md(r.notes)}
    </section>`)}
  </div>
</div>`;
  return {
    path: "/releases/",
    title: "Releases",
    seoTitle: "Releases and changelogs of the @toip-tools TypeScript libraries · toip.tools",
    description: "Every published version of the @toip-tools libraries on npm, with changelogs and an Atom feed.",
    section: "releases",
    kind: "collection",
    eyebrow: "Releases",
    ogFooter: "npm install @toip-tools/trust-core",
    tools: true,
    sources: ["packages/trust-core/CHANGELOG.md", "packages/relay/CHANGELOG.md", "packages/cose/CHANGELOG.md", "packages/web-vault/CHANGELOG.md", "packages/mandates/CHANGELOG.md", "packages/anon-membership/CHANGELOG.md", "packages/eventlog/CHANGELOG.md", "packages/mesh-transport/CHANGELOG.md"],
    body,
  };
}
