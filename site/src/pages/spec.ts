import { SPEC_ORIGIN, gh, u } from "../../build/config";
import { code } from "../../build/highlight";
import { html, type Raw } from "../../build/html";
import { currentSpecBase, type Spec } from "../../build/specs";
import type { Page } from "../layout";
import { arrow, pageHead, specHref } from "../parts";

const FAMILIES: Record<string, { title: string; what: Raw }> = {
  settle: {
    title: "Settle: conditional payments",
    what: html`Invoices, terms, escrow, attestations, disputes, rulings and receipts between a payer, a payee, an attester, an arbiter and a processor. Used by <a href="${u("/examples/#settle")}">Settle</a>.`,
  },
  todo: {
    title: "Shared To-Do: a list without a server",
    what: html`Joining, membership, signed operations, rosters and catching up. Used by <a href="${u("/examples/#shared-todo")}">Shared To-Do</a>.`,
  },
  mandates: {
    title: "Mandates: delegation and approval",
    what: html`Issuing and revoking mandates, and asking a principal to approve one action. From <a href="${u("/toolkit/mandates/")}"><code>@toip-tools/mandates</code></a>.`,
  },
  trail: {
    title: "Trail: witnesses and disclosure",
    what: html`Submitting events to witnesses, querying logs, disclosing bundles and reporting duplicity. From <a href="${u("/toolkit/eventlog/")}"><code>@toip-tools/eventlog</code></a>.`,
  },
  "anon-membership": {
    title: "Anonymous membership: enrollment",
    what: html`A member enrolls a commitment with a group's issuer. From <a href="${u("/toolkit/anon-membership/")}"><code>@toip-tools/anon-membership</code></a>.`,
  },
};

/** Families in FAMILIES' order (apps first), then any new ones alphabetically. */
function familyOrder(specs: Spec[]): string[] {
  const known = Object.keys(FAMILIES);
  const rank = (f: string) => (known.includes(f) ? known.indexOf(f) : known.length);
  return [...new Set(specs.map((s) => s.family))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const uri = (name: string) => `${SPEC_ORIGIN}/spec/${name}/0.1`;
const firstSentence = (s: string) => s.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? s;
const lineLink = (file: string, line?: number) => html`<a href="${gh(file)}${line ? `#L${line}` : ""}"><code>${file}${line ? `:${line}` : ""}</code></a>`;

function side(specs: Spec[], current?: string): Raw {
  const fams = familyOrder(specs);
  return html`<nav class="docs__side" aria-label="Trust Task types">
    <ul><li><a href="${u("/spec/")}"${current ? "" : html` aria-current="page"`}>All types</a></li></ul>
    ${fams.map(
      (f) => html`<p class="side-h">${f}</p><ul>${specs
        .filter((s) => s.family === f)
        .map((s) => html`<li><a href="${specHref(s.name)}"${current === s.name ? html` aria-current="page"` : ""}><code>${s.name.slice(f.length + 1) || s.name}</code></a></li>`)}</ul>`,
    )}
  </nav>`;
}

function envelope(s: Spec): string {
  return JSON.stringify(
    {
      id: "urn:uuid:…",
      type: uri(s.name),
      issuer: "did:key:… (the sender)",
      recipient: "did:key:… (the receiver)",
      issuedAt: "2026-11-06T18:00:00.000Z",
      payload: "…",
      proof: { type: "DataIntegrityProof", cryptosuite: "eddsa-jcs-2022", verificationMethod: "did:key:…#…", proofPurpose: "assertionMethod", proofValue: "z…" },
    },
    null,
    2,
  ).replace('"payload": "…"', '"payload": { … }');
}

function specPage(s: Spec, all: Spec[]): Page {
  const n = s.note;
  const body = html`
<div class="wrap docs docs--side-last">
  ${side(all, s.name)}
  <div>
    <div class="page-head">
      <h1 class="mono" style="font-size: clamp(1.6rem, 4vw, 2.4rem)">${s.name}</h1>
      <p class="spec-uri">${uri(s.name)}</p>
    </div>
    ${n ? html`<div class="prose"><p class="lede">${n.purpose}</p></div>` : s.doc ? html`<div class="prose"><p class="lede">${s.doc}</p></div>` : ""}
    <dl class="facts">
      ${n ? html`<dt>Sent</dt><dd><span class="flow">${n.from} ${arrow("to")} ${n.to}</span></dd>` : ""}
      ${n ? html`<dt>Kind</dt><dd>${n.kind === "one-way" ? "One-way. No response is expected; any answer is a separate message." : html`Request and response. The response's type is <code>${uri(s.name)}#response</code>.`}</dd>` : ""}
      <dt>Envelope</dt><dd>Signed by its issuer, addressed to one recipient, timestamped, sealed in a TSP Direct message. Not a bearer token.</dd>
      <dt>Defined in</dt><dd>${lineLink(s.file, s.line)}${s.constName ? html` as <code>${s.constName}</code>` : ""}</dd>
      ${n?.handledIn?.length ? html`<dt>Handled in</dt><dd>${n.handledIn.map((f, i) => html`${i ? ", " : ""}${lineLink(f)}`)}</dd>` : ""}
      ${n ? html`<dt>Design</dt><dd><a href="${gh(n.design, s.designAnchor)}">${n.designSection}</a> in <code>${n.design}</code></dd>` : ""}
    </dl>
    ${s.doc && n ? html`<div class="prose"><p class="small quiet">From the code's comment: “${s.doc}”</p></div>` : ""}

    <h2>Payload</h2>
    ${
      s.payload
        ? code(s.payload.text, "ts", { caption: s.payload.decl ? html`${s.payload.decl.file}:${s.payload.decl.line}` : html`As the handler declares it, in ${n?.payloadFile ?? s.file}` })
        : html`<div class="prose"><p>Not documented yet. See the code where it's defined.</p></div>`
    }
    ${s.response ? html`<h2>Response payload</h2>${code(s.response.text, "ts", { caption: s.response.decl ? html`${s.response.decl.file}:${s.response.decl.line}` : html`As the handler declares it, in ${n?.responseFile ?? s.file}` })}` : ""}
    ${s.related.length ? html`<h3>Types it uses</h3>${s.related.map((d) => code(d.text, "ts", { caption: `${d.file}:${d.line}` }))}` : ""}

    ${n?.note ? html`<h2>Notes</h2><div class="prose"><p>${n.note}</p></div>` : ""}

    <h2>The whole document</h2>
    <div class="prose"><p>Every Trust Task shares this envelope. The payload above goes in <code>payload</code>.</p></div>
    ${code(envelope(s), "json", { caption: "Shape of a document of this type" })}
  </div>
</div>`;
  return {
    path: `/spec/${s.name}/0.1/`,
    title: s.name,
    description: n ? firstSentence(n.purpose) : `The ${s.name} Trust Task type.`,
    section: "spec",
    body,
  };
}

function indexPage(specs: Spec[]): Page {
  const base = currentSpecBase();
  const fams = familyOrder(specs);
  const body = html`
<div class="wrap docs docs--side-last">
  ${side(specs)}
  <div>
    ${pageHead("Trust Task types", html`The ${specs.length} message types the toolkit and its apps define, each with what it's for, who sends it to whom, and its payload as the code declares it.`)}
    <div class="prose">
      <p>A Trust Task's <code>type</code> is a URI naming its specification. This toolkit's types live under <code>${SPEC_ORIGIN}/spec/&lt;name&gt;/0.1</code>, and each URI is a page here. Some may be proposed to the <a href="https://trusttasks.org/">Trust Tasks registry</a>; until then they're ours. Code defines them with <code>ourSpec("&lt;name&gt;")</code> from <a href="${u("/toolkit/trust-core/")}"><code>@toip-tools/trust-core</code></a>, and these pages are generated from that code each time the site is built.</p>
      ${base && !base.startsWith(SPEC_ORIGIN) ? html`<p class="small quiet">The code in the repository still uses the placeholder namespace <code>${base}</code>; the names after it are the same. It moves to <code>${SPEC_ORIGIN}/spec/</code> with the package rename.</p>` : ""}
    </div>
    ${fams.map(
      (f) => html`<section id="${f}" aria-labelledby="${f}-h">
      <h2 id="${f}-h">${FAMILIES[f]?.title ?? f}</h2>
      ${FAMILIES[f] ? html`<div class="prose"><p>${FAMILIES[f].what}</p></div>` : ""}
      <ul class="spec-list">${specs
        .filter((s) => s.family === f)
        .map(
          (s) => html`<li><a href="${specHref(s.name)}"><code>${s.name}</code></a><p>${s.note ? html`${firstSentence(s.note.purpose)} ${s.note.kind === "request/response" ? "Request and response." : ""}` : s.doc ?? ""}</p></li>`,
        )}</ul>
    </section>`,
    )}
  </div>
</div>`;
  return {
    path: "/spec/",
    title: "Trust Task types",
    description: "Every Trust Task type defined in the toolkit and its apps: purpose, sender and receiver, and payload, generated from the code.",
    section: "spec",
    body,
  };
}

export function specPages(specs: Spec[]): Page[] {
  return [indexPage(specs), ...specs.map((s) => specPage(s, specs))];
}
