import { u } from "../build/config";
import { html, raw, type Raw } from "../build/html";
import { libBySlug } from "./data/libraries";

const tools = [
  { slug: "trust-core", category: "The foundation", description: "Create identities, exchange private messages, and verify credentials." },
  { slug: "relay", category: "Delivery", description: "A mailbox for encrypted messages. Online when you aren't." },
  { slug: "web-vault", category: "Key storage", description: "Your keys, protected by a passkey or passphrase." },
  { slug: "mandates", category: "Delegation", description: "Give an agent authority. Set its limits." },
  { slug: "anon-membership", category: "Privacy", description: "Prove you belong. Keep your identity private." },
  { slug: "cose", category: "Signatures", description: "Small binary messages. Verifiable signatures." },
  { slug: "eventlog", category: "Audit trails", description: "Rotate keys. Keep a history others can verify." },
  { slug: "mesh-transport", category: "Beyond the internet", description: "Take the same trust protocols over radio links and portable files." },
];

const drawings: Record<string, string> = {
  relay: '<path d="M12 26 32 13l20 13v25H12Z"/><path d="m12 26 20 14 20-14M12 51l14-15m26 15L38 36"/><path d="M26 9h12M32 3v12"/>',
  "web-vault": '<rect x="12" y="10" width="40" height="44" rx="7"/><circle cx="32" cy="31" r="9"/><path d="M32 22v18m-9-9h18M17 19h3m24 26h3"/>',
  mandates: '<circle cx="32" cy="12" r="7"/><circle cx="15" cy="49" r="7"/><circle cx="49" cy="49" r="7"/><path d="M32 19v11H15v12m17-12h17v12M29 45l3 3 6-7"/>',
  "anon-membership": '<circle cx="20" cy="20" r="6"/><circle cx="44" cy="20" r="6"/><path d="M9 41v-3a11 11 0 0 1 15-10m31 13v-3a11 11 0 0 0-15-10"/><circle cx="32" cy="39" r="14"/><path d="m26 39 4 4 8-9"/>',
  cose: '<path d="M17 9h22l9 9v37H17Z"/><path d="M39 9v11h9M24 29h5m6 0h6m-17 8h3m5 0h9m-17 8 4 4 10-10"/>',
  eventlog: '<rect x="6" y="11" width="15" height="16" rx="3"/><rect x="25" y="23" width="15" height="16" rx="3"/><rect x="44" y="35" width="15" height="16" rx="3"/><path d="M21 19h11v4m8 8h11v4M10 19h7m12 12h7m12 12h7"/>',
};

function illustration(slug: string): Raw {
  if (slug === "trust-core") return html`<svg class="library-tile__flow" viewBox="0 0 560 180" aria-hidden="true" focusable="false">
    <path class="library-tile__connection" d="M108 83h344"/>
    <circle class="library-tile__orbit" cx="280" cy="83" r="66"/>
    <circle class="library-tile__orbit" cx="280" cy="83" r="49"/>
    <rect class="library-tile__node" x="20" y="49" width="104" height="68" rx="8"/>
    <rect class="library-tile__node" x="436" y="49" width="104" height="68" rx="8"/>
    <circle class="library-tile__avatar" cx="52" cy="83" r="17"/><circle class="library-tile__avatar" cx="468" cy="83" r="17"/>
    <text class="library-tile__initial" x="52" y="89" text-anchor="middle">A</text><text class="library-tile__initial" x="468" y="89" text-anchor="middle">B</text>
    <text class="library-tile__diagram-label" x="78" y="81">Alice</text><text class="library-tile__diagram-label" x="494" y="81">Bob</text>
    <text class="library-tile__diagram-small" x="78" y="96">sender</text><text class="library-tile__diagram-small" x="494" y="96">recipient</text>
    <rect class="library-tile__envelope" x="246" y="59" width="68" height="48" rx="6"/>
    <path class="library-tile__envelope-line" d="m248 63 32 23 32-23m-64 40 23-24m41 24-23-24"/>
    <text class="library-tile__diagram-small" x="280" y="164" text-anchor="middle">signed · encrypted · verified</text>
  </svg>`;
  if (slug === "mesh-transport") return html`<svg class="library-tile__terrain" viewBox="0 0 260 100" aria-hidden="true" focusable="false">
    <path d="m0 92 37-38 35 25 45-58 53 57 30-32 60 46"/><path d="m0 100 54-27 27 20 42-42 45 42 37-17 55 24"/>
    <path class="library-tile__radio-route" d="M37 54Q79-5 117 21T200 46"/>
    <circle cx="37" cy="54" r="4"/><circle cx="117" cy="21" r="4"/><circle cx="200" cy="46" r="4"/>
    <circle class="library-tile__radio-ring" cx="117" cy="21" r="12"/><circle class="library-tile__radio-ring" cx="117" cy="21" r="20"/>
  </svg>`;
  return html`<svg class="library-tile__icon" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${raw(drawings[slug])}</svg>`;
}

export function toolkitShowcase(): Raw {
  return html`<section class="toolkit-showcase" aria-labelledby="toolkit">
    <div class="toolkit-showcase__heading">
      <div><h2 id="toolkit">Libraries</h2></div>
    </div>
    <div class="toolkit-showcase__grid">
      ${tools.map((tool) => {
        const library = libBySlug(tool.slug);
        const id = `toolkit-${tool.slug}`;
        return html`<a class="library-tile library-tile--${tool.slug}" href="${u(`/toolkit/${library.slug}/`)}" aria-labelledby="${id}" aria-describedby="${id}-description">
          <div class="library-tile__top"><span class="eyebrow">${tool.category}</span><span class="library-tile__arrow" aria-hidden="true">↗</span></div>
          <div class="library-tile__art">${illustration(tool.slug)}</div>
          <div class="library-tile__body"><h3 id="${id}">${library.slug}</h3><p id="${id}-description">${tool.description}</p></div>
          ${tool.slug === "trust-core" ? html`<div class="library-tile__tags" aria-hidden="true"><span>did:key</span><span>TSP</span><span>Trust Tasks</span><span>Credentials</span></div>` : ""}
        </a>`;
      })}
    </div>
    <p class="toolkit-showcase__note">Use the libraries from the repository. <a href="${u("/docs/#setup")}">Setup instructions <span aria-hidden="true">↗</span></a></p>
  </section>`;
}
