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
    <div class="wire__top"><span>On the wire <strong>${s.bytes.toLocaleString("en-US")} bytes</strong></span><span>TSP Direct</span></div>
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
  <figcaption id="wire-cap">A real message from ${didTag(s.alice, { short: true, name: "Alice" })} to Bob, sealed at build time. The relay sees the sender and recipient. Only Bob can read the contents and verify Alice's signature.</figcaption>
</figure>`;
}

export function homePage(sample: SealedSample, specCount: number): Page {
  const first = exampleRegion("examples/quickstart/02-trust-task.ts", "hero");
  const body = html`
<div class="wrap">
  <section class="hero" aria-labelledby="hero-title">
    <div>
      <p class="eyebrow">TypeScript tools for Trust over IP</p>
      <h1 id="hero-title">Trust people can verify.</h1>
      <p class="lede">Build apps where people hold their own keys, exchange private messages, and check each other's claims directly.</p>
      <p>Trust over IP (ToIP) provides the open protocols. This toolkit brings them together in eight TypeScript libraries, with working apps to learn from. Start with two identities and a signed, encrypted message.</p>
      <p class="actions"><a class="btn" href="${u("/quickstart/")}">Send your first Trust Task <span aria-hidden="true">↗</span></a><a href="${u("/concepts/")}">Explore the concepts</a></p>
      <p class="hero__note">Open source. Runs in browsers and Node. No account required for the quickstart.</p>
    </div>
    ${wire(sample)}
  </section>

  <section class="band" aria-labelledby="layers">
    <h2 id="layers">From keys to working apps</h2>
    <div class="prose">
      <p>The <a href="${X.p2pStack}">P2P Trust Stack</a> organizes this work into four layers. Each answers a different question: who are you, how do we communicate, what can we do together, and what can we build?</p>
    </div>
    <ol class="layers">
      <li><span class="n">Layer 1</span><h3>Trust support</h3><p>Create an identity and control its keys. ${libLinks(["trust-core"])} provides <code>did:key</code> identities; ${libLinks(["eventlog"])} adds KERI key histories so an identifier can survive key rotation.</p></li>
      <li><span class="n">Layer 2</span><h3>Trust spanning</h3><p>Exchange messages signed by the sender and encrypted for the recipient. ${libLinks(["trust-core"])} implements TSP Direct messaging through OpenVTC, with ${libLinks(["relay"])} for internet delivery and ${libLinks(["mesh-transport"])} for radio links.</p></li>
      <li><span class="n">Layer 3</span><h3>Trust tasks</h3><p>Put that connection to work: issue credentials, delegate authority with ${libLinks(["mandates"])}, or prove group membership with ${libLinks(["anon-membership"])}. Browse <a href="${u("/spec/")}">${specCount} message specifications</a> used by the toolkit and its apps.</p></li>
      <li><span class="n">Layer 4</span><h3>Trust applications</h3><p>Build something people can use. Explore conditional payments in <a href="${u("/examples/#settle")}">Settle</a>, private collaboration in <a href="${u("/examples/#shared-todo")}">Shared To-Do</a>, and <a href="${u("/examples/")}">more working examples</a> for anonymous speech, agent delegation, and audit trails.</p></li>
    </ol>
    <p class="prose small quiet">This toolkit uses <code>did:key</code> identities and a WebSocket relay. The P2P Trust Stack uses other DID methods and libp2p transport. Interoperability between the two implementations has not yet been tested.</p>
  </section>

  <section class="band" aria-labelledby="toolkit">
    <h2 id="toolkit">The toolkit</h2>
    <div class="prose"><p>Start with the pieces your app needs. All eight libraries live in <a href="${REPO}/tree/main/packages"><code>packages/</code></a> and have their own tests. Use them from the repository while npm publishing is in progress.</p></div>
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
      <p>This toolkit began at the <a href="${X.iiw}">Internet Identity Workshop</a> in November 2026, building on specifications developed at the <a href="${X.toip}">Trust over IP Foundation</a>. Help by trying an example, improving an implementation, or <a href="${u("/get-involved/#propose")}">bringing a trust problem of your own</a>.</p>
      <p><a href="${u("/get-involved/")}">Find a place to contribute</a></p>
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
