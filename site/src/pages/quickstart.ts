import { CLONE, REPO, gh, u } from "../../build/config";
import { code } from "../../build/highlight";
import { html, md, type Raw } from "../../build/html";
import { exampleOutput, exampleSource } from "../../build/source";
import type { Page } from "../layout";
import { pageHead, specHref } from "../parts";

const run = (step: string) => `npx tsx --tsconfig site/tsconfig.json site/examples/quickstart/${step}.ts`;

function step(n: number, id: string, title: string, intro: Raw, file: string, after: Raw): Raw {
  return html`<section class="step" aria-labelledby="${id}">
  <h2 id="${id}"><span class="step__n" aria-hidden="true">${n}</span><span><span class="sr-only">Step ${n}: </span>${title}</span></h2>
  <div class="prose">${intro}</div>
  ${code(exampleSource(`examples/quickstart/${file}.ts`), "ts", { caption: `site/examples/quickstart/${file}.ts` })}
  <div class="prose"><p>Run it from the repository root:</p></div>
  ${code(run(file), "bash", { caption: "Terminal" })}
  ${code(exampleOutput(file), "console", { caption: "What it printed when this site was built" })}
  <div class="prose">${after}</div>
</section>`;
}

export function quickstartPage(): Page {
  const body = html`
<div class="wrap">
  ${pageHead("Quickstart", "From nothing to a signed, encrypted exchange between two identities, a relay that holds mail for someone offline, and a credential that gets revoked. About ten minutes.")}

  <section class="prose" aria-labelledby="before">
    <h2 id="before">Before you start</h2>
    <p>You need Node 22.5 or later (the relay uses <code>node:sqlite</code>) and git. Nothing else: no accounts, no keys to request, no servers to sign up for. Every party in this tutorial runs on your machine.</p>
    ${code(`git clone ${CLONE}\ncd toip-experiments\nnpm install`, "bash", { caption: "Get the code" })}
    <p>The libraries live in <a href="${REPO}/tree/main/packages"><code>packages/</code></a>. The examples import them as <code>@toip-tools/trust-core</code> and so on; <a href="${gh("site/tsconfig.json")}"><code>site/tsconfig.json</code></a> maps those names to the packages' sources, which is why every command passes <code>--tsconfig</code>.</p>
  </section>

  ${step(
    1,
    "identities",
    "Make two identities",
    md`
      An identity is a key pair. Its name, a \`did:key\`, is the public key written out, so anyone holding the name has the key: there's no registry to ask. Alice and Bob each make one.
    `,
    "01-identities",
    md`
      The X25519 encryption key is derived from the Ed25519 signing key, as the P2P Trust Stack derives them. One DID is enough to both check someone's signature and seal a message only they can open.
    `,
  )}

  ${step(
    2,
    "trust-task",
    "Send a Trust Task",
    md`
      A Trust Task is a JSON document with a type, an issuer, a recipient, a time and a payload, signed by its issuer. An \`Endpoint\` sends it as a TSP Direct message: signed with Alice's key and sealed to Bob's. Here they talk over the \`Bus\`, an in-memory network that lets you watch every message go by.
    `,
    "02-trust-task",
    md`
      Look at what each side learned. Bob knows exactly who wrote to him, because the signature checks against Alice's DID. The network saw two DIDs and two sizes. The forged copy never reached Bob's handler: his TSP layer refused it because Alice's signature no longer matched.

      The reply came back signed by Bob, with the type \`…#response\`. A handler can also return \`new Refusal(code, message)\`, which arrives as a signed error that \`request()\` throws as a \`TaskError\`.
    `,
  )}

  ${step(
    3,
    "relay",
    "Leave a message at a relay",
    md`
      People are offline most of the time. The relay is a mailbox: it keeps sealed messages until their recipient signs in and acknowledges them. Swap the \`Bus\` for a \`RelayTransport\` and nothing else in your code changes.
    `,
    "03-relay",
    md`
      Each device signed in by signing the relay's challenge with its own key. Node prints an \`ExperimentalWarning\` for SQLite when the relay starts; it's harmless.

      To run a relay for real, use \`npm start --workspace packages/relay\` behind TLS, and set \`RELAY_PUBLIC_URL\` to the exact URL clients use, because they sign it when they authenticate.
    `,
  )}

  ${step(
    4,
    "credentials",
    "Present a credential, then revoke it",
    md`
      A third party joins: a community garden that vouches for its members. It issues Bob a credential, a signed statement about him in the W3C Verifiable Credentials shape, with a slot in its status list. Bob presents it to Alice inside a Trust Task, and Alice checks it on her own: the garden's signature, who it's about, and whether the garden has since revoked it.
    `,
    "04-credentials",
    md`
      Alice never contacted the garden to check Bob. She needed the garden's DID, which she trusts, and its latest signed status list, which anyone may host because nobody can forge it. Changing one claim broke the signature; flipping one bit in the list revoked the membership.
    `,
  )}

  <section class="prose" aria-labelledby="next">
    <h2 id="next">What you just built, and where to go next</h2>
    <p>Two parties with self-made identifiers exchanged messages that prove their sender and hide their content from everyone in between, through infrastructure they don't have to trust. A third party vouched for one of them, and the other checked that claim, and its revocation, without asking anyone.</p>
    <ul>
      <li><a href="${u("/concepts/")}">Concepts</a> explains DIDs, credentials, TSP, Trust Tasks, governance, KERI and zero-knowledge membership, with the specifications behind them.</li>
      <li><a href="${u("/toolkit/")}">The toolkit</a> has a page per library, from delegation (<a href="${u("/toolkit/mandates/")}"><code>mandates</code></a>) to audit logs (<a href="${u("/toolkit/eventlog/")}"><code>eventlog</code></a>).</li>
      <li><a href="${u("/examples/#settle")}">Settle</a> is these pieces in a full app: payment links, an escrow nobody controls alone, and <a href="${specHref("settle/escrow/attest")}">Trust Tasks</a> for every step. <code>npm run settle</code> starts it.</li>
      <li>Run all four steps at once from <code>site/</code> with <code>npm install</code> and <code>npm run quickstart</code>.</li>
    </ul>
  </section>
</div>`;
  return {
    path: "/quickstart/",
    title: "Quickstart",
    description: "Make two did:key identities, send a signed, encrypted Trust Task over a relay, and issue, verify and revoke a credential, in about ten minutes.",
    section: "quickstart",
    body,
  };
}
