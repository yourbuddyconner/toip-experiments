import { abs, u } from "../../build/config";
import { code } from "../../build/highlight";
import { html, type Raw } from "../../build/html";
import { docsNav } from "../docs-nav";
import type { Page } from "../layout";
import { pageHead } from "../parts";

export const AGENT_FILES = {
  llms: "/llms.txt",
  llmsFull: "/llms-full.txt",
  libraries: "/api/libraries.json",
  specs: "/api/specs.json",
  examples: "/api/examples.json",
  sitemap: "/sitemap.xml",
  feed: "/releases.xml",
  robots: "/robots.txt",
};

export const ASSISTANT_PROMPT = `I'm building with the @toip-tools TypeScript libraries (on npm, Node 22.13 or later).
Before writing code, read ${abs(AGENT_FILES.llmsFull)}: it holds their documentation, guides and Trust Task reference.
Use only the exports and options it documents, install packages as @toip-tools/<name>, and tell me if something I ask for isn't supported.

My task: `;

/** A copyable prompt that points a coding assistant at the full docs. */
export function assistantBox(): Raw {
  return html`<aside class="assistant" aria-labelledby="assistant-h">
    <div class="assistant__head">
      <p class="eyebrow">For coding assistants</p>
      <h2 id="assistant-h">Ask your AI assistant</h2>
    </div>
    <p>Assistants write better code with the documentation in front of them. Paste this prompt into yours, then describe what you're building.</p>
    ${code(ASSISTANT_PROMPT, "text", { caption: "Prompt" })}
    <p class="assistant__links"><a href="${u(AGENT_FILES.llmsFull)}">llms-full.txt</a><span>all docs in one Markdown file</span><a href="${u(AGENT_FILES.llms)}">llms.txt</a><span>an index</span><a href="${u("/api/")}">JSON indexes</a><span>packages, exports and Trust Tasks</span></p>
  </aside>`;
}

export function agentsPage(): Page {
  const body = html`<div class="wrap docs">
  ${docsNav("/api/", [
    { label: "llms.txt", href: "#llms" },
    { label: "Markdown pages", href: "#markdown" },
    { label: "JSON indexes", href: "#json" },
    { label: "Feeds and crawling", href: "#crawling" },
  ])}
  <div class="docs__content">
    ${pageHead("Machine-readable docs", "Everything on this site, in forms that AI assistants, search engines and scripts can read directly.")}
    ${assistantBox()}

    <section class="prose" aria-labelledby="llms">
      <h2 id="llms">llms.txt</h2>
      <p><a href="${u(AGENT_FILES.llms)}"><code>/llms.txt</code></a> follows the <a href="https://llmstxt.org/">llms.txt proposal</a>: a short summary and a list of the most useful pages, each linked to its Markdown version. <a href="${u(AGENT_FILES.llmsFull)}"><code>/llms-full.txt</code></a> holds the documentation, quickstart, concepts, FAQ, every guide, every library guide, the API export lists and the Trust Task reference, concatenated as Markdown with real code.</p>
      <p>Both are generated at build time from the same pages as the HTML, so they can't drift from it.</p>
    </section>

    <section class="prose" aria-labelledby="markdown">
      <h2 id="markdown">Markdown version of every page</h2>
      <p>Add <code>index.md</code> to any page's address for the same content as clean Markdown: headings, prose, code blocks with their language, and absolute links. Each HTML page also names its twin in a <code>&lt;link rel="alternate" type="text/markdown"&gt;</code> tag, and documentation pages have a <strong>Copy page as Markdown</strong> button.</p>
      ${code(`curl ${abs("/guides/run-tsp-relay/index.md")}`, "bash", { caption: "Terminal" })}
    </section>

    <section class="prose" aria-labelledby="json">
      <h2 id="json">JSON indexes</h2>
      <dl class="facts">
        <dt><a href="${u(AGENT_FILES.libraries)}"><code>/api/libraries.json</code></a></dt>
        <dd>Every package: name, version, description, install command, runtimes, entry points, and each export with its kind, one-line summary and reference page. Also its documentation, npm and source URLs.</dd>
        <dt><a href="${u(AGENT_FILES.specs)}"><code>/api/specs.json</code></a></dt>
        <dd>Every Trust Task type: URI, purpose, sender, receiver, kind (one-way or request and response), the payload and response types as declared in the code, and links to its definition and design.</dd>
        <dt><a href="${u(AGENT_FILES.examples)}"><code>/api/examples.json</code></a></dt>
        <dd>Every example project: status, what it shows, the libraries it uses, and the commands that run it.</dd>
      </dl>
    </section>

    <section class="prose" aria-labelledby="crawling">
      <h2 id="crawling">Feeds and crawling</h2>
      <ul>
        <li><a href="${u(AGENT_FILES.sitemap)}"><code>/sitemap.xml</code></a> lists every page, with the date its sources last changed.</li>
        <li><a href="${u(AGENT_FILES.robots)}"><code>/robots.txt</code></a> allows every crawler, AI crawlers included.</li>
        <li><a href="${u(AGENT_FILES.feed)}"><code>/releases.xml</code></a> is an Atom feed of library releases; the <a href="${u("/releases/")}">releases page</a> shows the same changelogs.</li>
        <li>Pages carry JSON-LD structured data: <code>TechArticle</code>, <code>SoftwareSourceCode</code>, <code>FAQPage</code> and <code>BreadcrumbList</code>.</li>
      </ul>
    </section>
  </div>
</div>`;
  return {
    path: "/api/",
    title: "Machine-readable docs",
    seoTitle: "Machine-readable docs for AI agents: llms.txt, Markdown and JSON indexes · toip.tools",
    description: "llms.txt, llms-full.txt, a Markdown version of every page, and JSON indexes of every @toip-tools package, export, Trust Task type and example.",
    section: "api",
    kind: "collection",
    eyebrow: "For AI agents",
    ogFooter: `curl ${abs("/llms.txt")}`,
    tools: true,
    sources: ["site/src/pages/agents.ts", "site/build/agent-files.ts"],
    body,
  };
}
