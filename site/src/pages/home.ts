import { u } from "../../build/config";
import { didTag, hueOf } from "../../build/fingerprint";
import type { SealedSample } from "../../build/hero";
import { code } from "../../build/highlight";
import { esc, html, raw, type Raw } from "../../build/html";
import { exampleRegion } from "../../build/source";
import { libraries } from "../data/libraries";
import { projects } from "../data/projects";
import type { Page } from "../layout";
import { guides } from "../data/guides";

/** JSON with light markup, for the opened document. */
function jsonHtml(v: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const entries = Object.entries(v as Record<string, unknown>);
    return `<span class="p">{</span>\n${entries
      .map(([k, val], i) => `${pad}  <span class="k">"${esc(k)}"</span><span class="p">:</span> ${jsonHtml(val, indent + 1)}${i < entries.length - 1 ? '<span class="p">,</span>' : ""}`)
      .join("\n")}\n${pad}<span class="p">}</span>`;
  }
  if (typeof v === "string") return `<span class="s">"${esc(v)}"</span>`;
  return esc(JSON.stringify(v));
}

function wire(s: SealedSample): Raw {
  const part = (k: SealedSample["parts"][number]["kind"]) => s.parts.find((p) => p.kind === k)!;
  const sealed = part("sealed");
  const sig = part("signature");
  const head = part("head");
  const frame = part("frame");
  const shownSealed = 192;
  return html`<figure class="wire" aria-labelledby="wire-cap">
  <div class="wire__panel">
    <div class="wire__top"><span class="wire__specimen">A message you can inspect</span><span>TSP / Direct</span></div>
    <div class="wire__journey" aria-hidden="true">
      <div class="wire__person"><b>A</b><span>Alice<small>signs &amp; sends</small></span></div>
      <div class="wire__route"><span>${s.bytes.toLocaleString("en-US")} encrypted bytes</span></div>
      <div class="wire__person"><b>B</b><span>Bob<small>opens &amp; verifies</small></span></div>
    </div>
    <div class="seg">
      <div class="seg__label">TSP header<br>${head.length} bytes</div>
      <p class="seg__bytes">${head.hex}</p>
    </div>
    <div class="seg seg--clear" style="--h:${hueOf(s.alice)}">
      <div class="seg__label">From, in the clear</div>
      <p class="seg__bytes">${part("sender").text}</p>
    </div>
    <div class="seg seg--clear" style="--h:${hueOf(s.bob)}">
      <div class="seg__label">To, in the clear</div>
      <p class="seg__bytes"><span class="sr-only">After ${frame.length} framing bytes: </span>${part("receiver").text}</p>
    </div>
    <div class="seg seg--sealed">
      <div class="seg__label">Sealed to Bob's key<br>${sealed.length} bytes</div>
      <p class="seg__bytes">${sealed.hex.slice(0, shownSealed)}<span class="gap">… ${sealed.length - shownSealed / 2 - 16} more bytes …</span>${sealed.hex.slice(-32)}</p>
    </div>
    <div class="seg seg--sig" style="--h:${hueOf(s.alice)}">
      <div class="seg__label">Signed by Alice</div>
      <p class="seg__bytes">${sig.hex}</p>
    </div>
  </div>
  <div class="wire__opened">
    <div class="wire__opened-head">${didTag(s.bob, { short: true, name: "Bob" })}<span>opens the message</span><span class="ok">Verified · addressed to Bob · fresh · no replay</span></div>
    <pre class="json" tabindex="0">${raw(jsonHtml(s.document))}</pre>
  </div>
  <figcaption id="wire-cap">A real message from ${didTag(s.alice, { short: true, name: "Alice" })} to Bob, sealed at build time. The relay sees the sender and recipient. Only Bob can read the contents; Alice's signature proves she sent them.</figcaption>
</figure>`;
}

export function homePage(sample: SealedSample, specCount: number): Page {
  const first = exampleRegion("examples/quickstart/02-trust-task.ts", "hero");
  const body = html`
<div class="wrap">
  <section class="landing-hero" aria-labelledby="hero-title">
    <div>
      <p class="eyebrow"><span class="eyebrow__dot" aria-hidden="true"></span> Interoperable tools for Trust over IP</p>
      <h1 id="hero-title">Build with<br>Trust over IP.</h1>
      <p class="lede">A TypeScript SDK for identities, private messages, verifiable credentials, and delegation.</p>
      <p>Run a signed request and response locally, then use the same libraries in your application.</p>
      <p class="actions"><a class="btn" href="${u("/docs/")}">Get started <span aria-hidden="true">↗</span></a><a href="${u("/quickstart/")}">Run the quickstart</a></p>
      <p class="landing-meta">${libraries.length} libraries on npm · Browser and Node · ${guides.length} guides</p>
    </div>
    <div class="landing-example">${code(first, "ts", { caption: "Quickstart: a signed request and response" })}<p><a href="${u("/quickstart/#trust-task")}">View the complete example</a></p></div>
  </section>

  <section class="landing-section" aria-labelledby="start-building">
    <h2 id="start-building">Start building</h2>
    <ol class="landing-paths">
      <li><a href="${u("/docs/#setup")}"><span class="landing-paths__step">01</span><h3>Set up the SDK</h3><p>Install the libraries from npm and choose your runtime.</p><span class="landing-paths__link">Setup <span aria-hidden="true">↗</span></span></a></li>
      <li><a href="${u("/quickstart/")}"><span class="landing-paths__step">02</span><h3>Run a trust exchange</h3><p>Create identities, send a private message, and verify a credential.</p><span class="landing-paths__link">Quickstart <span aria-hidden="true">↗</span></span></a></li>
      <li><a href="${u("/toolkit/")}"><span class="landing-paths__step">03</span><h3>Build your application</h3><p>Find usage guides, parameters, return types, and working examples.</p><span class="landing-paths__link">SDK reference <span aria-hidden="true">↗</span></span></a></li>
    </ol>
  </section>

  <section class="landing-section" aria-labelledby="how-to">
    <div class="landing-section__heading"><h2 id="how-to">Guides</h2><a href="${u("/guides/")}">All guides <span aria-hidden="true">↗</span></a></div>
    <ul class="landing-guides">${guides.map(g => html`<li><a href="${u(`/guides/${g.slug}/`)}">${g.title}</a></li>`)}</ul>
  </section>

  <section class="landing-section" aria-labelledby="built">
    <div class="landing-section__heading"><h2 id="built">Example applications</h2><a href="${u("/examples/")}">All examples <span aria-hidden="true">↗</span></a></div>
    <div class="landing-apps">${projects.filter(p => p.status === "working").slice(0, 3).map(p => html`<a href="${u(`/examples/#${p.slug}`)}"><h3>${p.name}</h3><p>${p.pitch.split(/(?<=\.) /)[0]}</p><span>Run the example <span aria-hidden="true">↗</span></span></a>`)}</div>
  </section>

  <section class="landing-resources" aria-label="More resources">
    <div><h2>Concepts</h2><p>Learn how identities, credentials, messaging, and governance fit together.</p><a href="${u("/concepts/")}">Read the concepts <span aria-hidden="true">↗</span></a></div>
    <div><h2>Ecosystem</h2><p>Understand the communities, specifications, and implementation choices behind this work.</p><a href="${u("/ecosystem/")}">Explore the ecosystem <span aria-hidden="true">↗</span></a></div>
    <div><h2>Trust Tasks</h2><p>Look up ${specCount} message types used by the SDK and example applications.</p><a href="${u("/spec/")}">Task reference <span aria-hidden="true">↗</span></a></div>
  </section>

  <details class="landing-inspector" data-md-skip><summary>Inspect a signed, encrypted message</summary>${wire(sample)}</details>
</div>`;
  return {
    path: "/",
    title: "toip.tools — TypeScript SDK for Trust over IP",
    seoTitle: "toip.tools: TypeScript libraries for Trust over IP, DIDs, verifiable credentials and TSP",
    description: "TypeScript libraries on npm and runnable examples for Trust over IP: did:key identities, verifiable credentials, the Trust Spanning Protocol and Trust Tasks.",
    section: "home",
    kind: "home",
    eyebrow: "TypeScript SDK",
    ogTitle: "Build with Trust over IP.",
    ogFooter: "npm install @toip-tools/trust-core",
    sources: ["site/src/pages/home.ts", "site/src/data/projects.ts", "site/examples/quickstart/02-trust-task.ts"],
    body,
  };
}
