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
    <div class="wire__top"><span>What a relay carries: <strong>${s.bytes.toLocaleString("en-US")} bytes</strong></span><span>TSP Direct message</span></div>
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
      <div class="seg__label">Alice's signature over all of it</div>
      <p class="seg__bytes">${sig.hex}</p>
    </div>
  </div>
  <div class="wire__opened">
    <div class="wire__opened-head">${didTag(s.bob, { short: true, name: "Bob" })}<span>opened it:</span><span class="ok">signature valid, addressed to Bob, fresh, not a replay</span></div>
    <pre class="json" tabindex="0">${raw(jsonHtml(s.document))}</pre>
  </div>
  <figcaption id="wire-cap">A real Trust Task from ${didTag(s.alice, { short: true, name: "Alice" })} to Bob, sealed when this page was built. Anyone carrying it can see who it's from and who it's for. Only Bob can open it, and Alice's signature proves she sent it.</figcaption>
</figure>`;
}

export function homePage(sample: SealedSample, specCount: number): Page {
  const building = projects.filter((p) => p.status === "being built").length;
  const words = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const first = exampleRegion("examples/quickstart/02-trust-task.ts", "hero");
  const body = html`
<div class="wrap">
  <section class="hero" aria-labelledby="hero-title">
    <div>
      <h1 id="hero-title">Trust between people and machines, with no platform in the middle.</h1>
      <p class="lede">Trust over IP (ToIP) is a family of open specifications for that: identifiers that people, organizations and devices make for themselves, credentials anyone can check, and the Trust Spanning Protocol (TSP), which carries signed, encrypted messages between any two of them.</p>
      <p>This site is a TypeScript toolkit for building on that stack today, with working apps that show what it's for. Two parties who have never met can check each other's claims directly, and no server in between gets to read, forge or decide.</p>
      <p class="actions"><a class="btn" href="${u("/quickstart/")}">Send your first Trust Task</a><a href="${u("/concepts/")}">Read the concepts</a></p>
    </div>
    ${wire(sample)}
  </section>

  <section class="band" aria-labelledby="layers">
    <h2 id="layers">The stack, in four layers</h2>
    <div class="prose">
      <p>The <a href="${X.p2pStack}">P2P Trust Stack</a> arranges ToIP's ideas in four layers, each building on the one below. Here is each layer, and what in this toolkit works at it.</p>
    </div>
    <ol class="layers">
      <li><span class="n">Layer 1</span><h3>Trust support</h3><p>Keys and the identifiers made from them. The stack uses <code>did:peer:4</code> and <code>did:scid:vh</code>. Here, ${libLinks(["trust-core"])} uses <code>did:key</code>, and ${libLinks(["eventlog"])} keeps KERI key event logs, whose keys can rotate.</p></li>
      <li><span class="n">Layer 2</span><h3>Trust spanning</h3><p>TSP: messages signed by the sender and sealed to the receiver, between agents that each hold their own keys. ${libLinks(["trust-core"])} sends real TSP Direct messages through the OpenVTC libraries, over ${libLinks(["relay"])}, and soon over radio with ${libLinks(["mesh-transport"])}.</p></li>
      <li><span class="n">Layer 3</span><h3>Trust tasks</h3><p>What parties do with a trusted channel: issue and check credentials, join communities, delegate authority, prove membership. Here: credentials and status lists, ${libLinks(["mandates"])} for delegation, ${libLinks(["anon-membership"])} for zero-knowledge membership, and <a href="${u("/spec/")}">${specCount} Trust Task types</a> of our own.</p></li>
      <li><span class="n">Layer 4</span><h3>Trust applications</h3><p>The apps people use. Upstream this layer hasn't started. Here, <a href="${u("/examples/#settle")}">Settle</a> and <a href="${u("/examples/#shared-todo")}">Shared To-Do</a> work today, and ${words[building] ?? building} more are being built.</p></li>
    </ol>
    <p class="prose small quiet">Where this toolkit differs from the stack: it uses <code>did:key</code> rather than <code>did:peer:4</code>, and its own WebSocket relay rather than TSP Routed Mode or the stack's libp2p transport. Whether it interoperates on the wire with the P2P Trust Stack's own implementation hasn't been tested yet.</p>
  </section>

  <section class="band" aria-labelledby="toolkit">
    <h2 id="toolkit">The toolkit</h2>
    <div class="prose"><p>Eight libraries in <a href="${REPO}/tree/main/packages"><code>packages/</code></a>, each with its own tests. Import them from the repository today.</p></div>
    <table class="rows">
      <thead><tr><th scope="col">Library</th><th scope="col">What it does</th><th scope="col">Status</th></tr></thead>
      <tbody>
        ${libraries.map((l) => html`<tr><th scope="row"><a href="${u(`/toolkit/${l.slug}/`)}"><code>${l.name}</code></a></th><td>${l.does}</td><td>${status(l.status)}</td></tr>`)}
      </tbody>
    </table>
  </section>

  <section class="band" aria-labelledby="built">
    <h2 id="built">What's been built with it</h2>
    <div class="prose"><p>Each project stands on its own, with a design you can read and, where it's built, commands that run it.</p></div>
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
      <p>Two identities, one signed and encrypted request, one signed reply. These lines are from the quickstart's second step, which runs as written. Bob's handler only runs after his side has decrypted the message, checked Alice's signature against her DID, and checked that it's addressed to him, fresh, and not a replay.</p>
    </div>
    ${code(first, "ts", { caption: "From site/examples/quickstart/02-trust-task.ts" })}
    <p class="actions"><a class="btn" href="${u("/quickstart/")}">Start the quickstart</a></p>
  </section>

  <section class="band" aria-labelledby="involved">
    <h2 id="involved">Get involved</h2>
    <div class="prose">
      <p>The specifications are made in the open at the <a href="${X.toip}">Trust over IP Foundation</a>, and the P2P Trust Stack is a partner project of the First Person Cooperative. This toolkit started at <a href="${X.iiw}">IIW</a> in November 2026. Try the quickstart, read a design, or <a href="${u("/get-involved/#propose")}">propose an example</a> of your own.</p>
      <p><a href="${u("/get-involved/")}">Where to take part</a></p>
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
