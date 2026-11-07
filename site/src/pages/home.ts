import { REPO, u } from "../../build/config";
import { didTag, hueOf } from "../../build/fingerprint";
import type { SealedSample } from "../../build/hero";
import { code } from "../../build/highlight";
import { esc, html, raw, type Raw } from "../../build/html";
import { exampleRegion } from "../../build/source";
import { libraries } from "../data/libraries";
import { projects } from "../data/projects";
import { externals as X } from "../data/links";
import type { Page } from "../layout";
import { libLinks, status } from "../parts";

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
  <section class="hero" aria-labelledby="hero-title">
    <div>
      <p class="eyebrow"><span class="eyebrow__dot" aria-hidden="true"></span> Interoperable tools for Trust over IP</p>
      <h1 id="hero-title">Trust people<br>can <em>verify.</em></h1>
      <p class="lede">Build apps where people hold their own keys, exchange private messages, and check each other's claims directly.</p>
      <p>TypeScript libraries and runnable apps built with ToIP protocols, verifiable credentials, and cryptographic proofs. Start with two identities and a signed, encrypted message.</p>
      <p class="actions"><a class="btn" href="${u("/quickstart/")}">Build your first exchange <span aria-hidden="true">↗</span></a><a href="${u("/toolkit/")}">Browse the libraries</a></p>
      <dl class="hero__facts"><div><dt>Libraries</dt><dd>${libraries.length}</dd></div><div><dt>Working apps</dt><dd>${projects.filter((p) => p.status === "working").length}</dd></div><div><dt>Task types</dt><dd>${specCount}</dd></div></dl>
    </div>
    ${wire(sample)}
  </section>

  <section class="capabilities" aria-labelledby="capabilities">
    <div><p class="eyebrow">What you can build with</p><h2 id="capabilities">From identity<br>to interaction.</h2><p>Choose the pieces your application needs.</p></div>
    <div class="capabilities__grid">
      <article><span class="capability-mark" aria-hidden="true">⌘</span><h3>Identity</h3><p>Create identifiers with ${libLinks(["trust-core"])}. Keep a verifiable key history with ${libLinks(["eventlog"])}.</p></article>
      <article><span class="capability-mark" aria-hidden="true">↗</span><h3>Private messages</h3><p>Send signed, encrypted Trust Tasks over the ${libLinks(["relay"])} or ${libLinks(["mesh-transport"])}.</p></article>
      <article><span class="capability-mark" aria-hidden="true">✓</span><h3>Verifiable claims</h3><p>Issue credentials, delegate with ${libLinks(["mandates"])}, or prove membership with ${libLinks(["anon-membership"])}.</p></article>
      <article><span class="capability-mark" aria-hidden="true">⊞</span><h3>Working applications</h3><p>Explore <a href="${u("/examples/#settle")}">conditional payments</a>, <a href="${u("/examples/#shared-todo")}">private collaboration</a>, and <a href="${u("/examples/")}">more runnable examples</a>.</p></article>
    </div>
  </section>

  <a class="ecosystem-invitation" href="${u("/ecosystem/")}"><div><span class="eyebrow">Beyond this toolkit</span><h2>Find your way around the ecosystem.</h2><p>Coming from ToIP? Meet the related communities and compare their implementation choices.</p></div><span class="ecosystem-invitation__arrow" aria-hidden="true">↗</span></a>

  <section class="band" aria-labelledby="toolkit">
    <h2 id="toolkit">The toolkit</h2>
    <div class="prose"><p>Start with the pieces your app needs. All eight libraries live in <a href="${REPO}/tree/main/packages"><code>packages/</code></a> and have their own tests. Import them directly from the repository; the packages aren't on npm yet.</p></div>
    <table class="rows">
      <thead><tr><th scope="col">Library</th><th scope="col">What it does</th><th scope="col">Status</th></tr></thead>
      <tbody>
        ${libraries.map((l) => html`<tr><th scope="row"><a href="${u(`/toolkit/${l.slug}/`)}"><code>${l.name}</code></a></th><td>${l.does}</td><td>${status(l.status)}</td></tr>`)}
      </tbody>
    </table>
  </section>

  <section class="band" aria-labelledby="built">
    <h2 id="built">See the ideas at work</h2>
    <div class="prose"><p>Each project explores a concrete trust problem. Read the design, inspect the protocol, or run a working example on your machine.</p></div>
    <table class="rows">
      <thead><tr><th scope="col">Project</th><th scope="col">What it is</th><th scope="col">Status</th></tr></thead>
      <tbody>
        ${projects.map((p) => html`<tr><th scope="row"><a href="${u(`/examples/#${p.slug}`)}">${p.name}</a></th><td>${p.pitch.split(/(?<=\.) /)[0]}</td><td>${status(p.status)}</td></tr>`)}
      </tbody>
    </table>
  </section>

  <section class="band first" aria-labelledby="first">
    <h2 id="first">Your first trust interaction</h2>
    <div class="prose">
      <p>Alice sends a request. Bob verifies it and signs his reply. Before Bob's handler runs, the toolkit decrypts the message and checks its signature, recipient, timestamp, and replay history. This is working code from the quickstart.</p>
    </div>
    ${code(first, "ts", { caption: "From site/examples/quickstart/02-trust-task.ts" })}
    <p class="actions"><a class="btn" href="${u("/quickstart/")}">Start the quickstart</a></p>
  </section>

  <section class="band" aria-labelledby="involved">
    <h2 id="involved">Get involved</h2>
    <div class="prose">
      <p>Report a bug, improve an example, or <a href="${u("/get-involved/#propose")}">propose an application</a>. Protocol work happens at the <a href="${X.toip}">Trust over IP Foundation</a>; this repository focuses on implementations and experiments.</p>
      <p><a href="${u("/get-involved/")}">Contribution guide</a></p>
    </div>
  </section>
</div>`;
  return {
    path: "/",
    title: "toip.tools: build on the Trust over IP stack",
    description: "A TypeScript toolkit and working examples for building on Trust over IP: DIDs, credentials, the Trust Spanning Protocol and Trust Tasks.",
    section: "home",
    body,
  };
}
