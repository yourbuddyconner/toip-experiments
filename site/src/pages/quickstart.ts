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
  ${code(exampleOutput(file), "console", { caption: "Recorded output" })}
  <div class="prose">${after}</div>
</section>`;
}

export function quickstartPage(): Page {
  const body = html`
<div class="wrap">
  ${pageHead("Your first trust exchange", "Create two identities, send a private message, and verify a credential. Four runnable examples, about ten minutes.")}

  <section class="prose" aria-labelledby="before">
    <h2 id="before">Before you start</h2>
    <p>You'll need Node 22.5 or later and Git. Every part of this tutorial runs on your machine, including the relay, so you can start without creating an account or setting up a remote server.</p>
    ${code(`git clone ${CLONE}\ncd toip-experiments\nnpm install`, "bash", { caption: "Get the code" })}
    <p>Run the commands below from the repository root. The examples import libraries from <a href="${REPO}/tree/main/packages"><code>packages/</code></a> using names such as <code>@toip-tools/trust-core</code>. The <code>--tsconfig</code> option points to <a href="${gh("site/tsconfig.json")}">the configuration</a> that resolves those names to the local source.</p>
  </section>

  ${step(
    1,
    "identities",
    "Create two identities",
    md`
      Alice and Bob each create a key pair. Their identifiers use \`did:key\`, which encodes the public key in the identifier itself. Anyone with the identifier can recover the public key without consulting a registry.
    `,
    "01-identities",
    md`
      The toolkit derives an X25519 encryption key from each Ed25519 signing key. One DID gives Alice what she needs to verify Bob's signatures and encrypt a message for him.
    `,
  )}

  ${step(
    2,
    "trust-task",
    "Send a Trust Task",
    md`
      A Trust Task is a signed JSON document describing one interaction. It names the task type, issuer, recipient, timestamp, and payload. Alice's \`Endpoint\` wraps it in a signed, encrypted TSP Direct message for Bob. For now, they use a \`Bus\`: an in-memory transport that lets you inspect what the network sees.
    `,
    "02-trust-task",
    md`
      Bob checks the sender's signature against Alice's DID. The network sees the two identifiers and the message sizes, but cannot read the contents. When the example tampers with a message, signature verification fails and Bob's handler never receives it.

      Bob's reply is signed too, with \`#response\` appended to the task type. A handler can return \`new Refusal(code, message)\` to decline a request. That refusal travels back as a signed response, and \`request()\` throws a \`TaskError\`.
    `,
  )}

  ${step(
    3,
    "relay",
    "Deliver a message while Bob is offline",
    md`
      Alice and Bob won't always be online together. A relay holds encrypted messages until the recipient connects and acknowledges delivery. Replace the \`Bus\` with \`RelayTransport\` to use that mailbox; the Trust Task handlers stay the same.
    `,
    "03-relay",
    md`
      Each device authenticates by signing a challenge from the relay. The relay uses \`node:sqlite\`; Node may print an \`ExperimentalWarning\` when it starts.

      To host a relay, run \`npm start --workspace packages/relay\` behind TLS. Set \`RELAY_PUBLIC_URL\` to the exact URL clients use: that URL is part of the authentication challenge they sign.
    `,
  )}

  ${step(
    4,
    "credentials",
    "Present a credential, then revoke it",
    md`
      A community garden issues Bob a membership credential: a signed statement in the W3C Verifiable Credentials shape, linked to an entry in the garden's status list. Bob sends it to Alice in a Trust Task. She checks the garden's signature, confirms the credential belongs to Bob, and checks whether it has been revoked.
    `,
    "04-credentials",
    md`
      Alice verifies the credential using the garden's trusted DID and its latest signed status list. The list can be hosted anywhere; its signature lets her detect changes. In the example, altering a claim invalidates the credential, and updating one status bit revokes Bob's membership.
    `,
  )}

  <section class="prose" aria-labelledby="next">
    <h2 id="next">Keep building</h2>
    <p>You created identities, exchanged signed and encrypted messages, delivered one through a relay, and verified a revocable credential. The relay handled delivery; Alice and Bob checked the messages and claims themselves.</p>
    <ul>
      <li>Understand the protocols in <a href="${u("/concepts/")}">Concepts</a>, with diagrams and links to the specifications.</li>
      <li>Find your next building block in <a href="${u("/toolkit/")}">the toolkit</a>: try <a href="${u("/toolkit/mandates/")}">delegation</a> or <a href="${u("/toolkit/eventlog/")}">verifiable audit trails</a>.</li>
      <li>See a complete app in <a href="${u("/examples/#settle")}">Settle</a>, where <a href="${specHref("settle/escrow/attest")}">Trust Tasks</a> coordinate conditional payments. Start it with <code>npm run settle</code>.</li>
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
