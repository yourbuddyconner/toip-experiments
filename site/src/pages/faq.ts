import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, REPO_DIR, abs, u } from "../../build/config";
import { html, md, slug } from "../../build/html";
import { externals as X } from "../data/links";
import { libraries } from "../data/libraries";
import { docsNav } from "../docs-nav";
import type { Page } from "../layout";
import { pageHead } from "../parts";

interface Faq {
  q: string;
  /** Markdown. Links may be site-absolute ("/docs/"). */
  a: string;
}

const plain = (s: string) =>
  s
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function faqs(): Faq[] {
  const version = JSON.parse(readFileSync(join(REPO_DIR, "packages/trust-core/package.json"), "utf8")).version as string;
  const license = JSON.parse(readFileSync(join(REPO_DIR, "packages/trust-core/package.json"), "utf8")).license as string;
  const runtimes = libraries.map((l) => `- \`${l.name}\`: ${l.runsIn}`).join("\n");
  return [
    {
      q: "What is Trust over IP?",
      a: `Trust over IP (ToIP) is an architecture for digital trust from the [Trust over IP Foundation](${X.toip}). It pairs technology (verifiable identifiers and their keys, the Trust Spanning Protocol for messages between them, and tasks such as issuing and checking credentials) with governance: the rules an ecosystem sets for who is trusted for what. The [ToIP model](${X.toipModel}) separates that shared architecture from the independently run ecosystems that use it. The [Concepts](/concepts/) page explains each layer.`,
    },
    {
      q: "What is the Trust Spanning Protocol (TSP)?",
      a: `TSP is a ToIP [specification](${X.tspSpec}) for messages between verifiable identifiers (VIDs). Each message is signed by its sender and encrypted for its recipient with HPKE, whatever transport carries it. In Direct mode, which these libraries use, the sender and recipient identifiers travel in clear; the specification's Routed and Nested modes add metadata protection through intermediaries. The libraries use the OpenVTC TypeScript implementation, \`@openvtc/vti-tsp-js\`. See [Send an end-to-end encrypted message with TSP](/guides/tsp-encrypted-message/).`,
    },
    {
      q: "What is a Trust Task?",
      a: `A Trust Task is a signed JSON document describing one interaction, such as a request for a quote, a membership credential presentation or an approval. Every one uses the same envelope: an \`id\`, a specification URI as its \`type\`, an \`issuer\`, a \`recipient\`, a timestamp, a payload and a proof. A response uses the same type with \`#response\` appended. The framework comes from the [ToIP Trust Tasks task force](${X.trustTasksTf}); the types defined in this repository use the \`https://toip.tools/spec/\` namespace and are listed in the [Trust Task reference](/spec/).`,
    },
    {
      q: "Is toip.tools part of the Trust over IP Foundation?",
      a: `No. toip.tools and the \`@toip-tools\` libraries are an independent project, unaffiliated with the Trust over IP Foundation. They implement published specifications (ToIP's TSP, KERI and Trust Tasks, W3C DIDs, Verifiable Credentials and Data Integrity, and IETF COSE and CBOR) and build on the OpenVTC TypeScript libraries. The project began at the [Internet Identity Workshop](${X.iiw}) in November 2026. To work on the specifications themselves, see [Contribute](/get-involved/).`,
    },
    {
      q: "How do I install the libraries?",
      a: `Every library is a separate package on npm under \`@toip-tools\`, at version ${version}. Start with trust-core, which the others build on: \`npm install @toip-tools/trust-core\`. Add the others as you need them, for example \`@toip-tools/relay\`, \`@toip-tools/mandates\` or \`@toip-tools/eventlog\`. The packages are ES modules with TypeScript declarations. The [Quickstart](/quickstart/) installs two of them in a new project and runs four examples.`,
    },
    {
      q: "Which Node.js version do I need?",
      a: "Node 22.13 or later. The relay stores its queue with `node:sqlite`, which needs it; the guides, the quickstart and this site's checks run on Node 22.",
    },
    {
      q: "Do the libraries work in the browser?",
      a: `Most do, through a bundler. Each library's runtime:\n\n${runtimes}`,
    },
    {
      q: "Which DID methods are supported?",
      a: "trust-core creates and resolves Ed25519 `did:key` identifiers, offline, with no registry. `@toip-tools/eventlog` creates KERI identifiers, written `did:keri:<AID>`, and resolves them from their key event logs. There is no resolver for other DID methods.",
    },
    {
      q: "Do I need a server, an account or a blockchain?",
      a: "No. A `did:key` identity is 32 random bytes made on the device, and verifying a signature needs only the DID. To deliver messages to someone who is offline, run the relay (`npx @toip-tools/relay`); for tests and demos, the in-memory `Bus` needs nothing. One example application, Settle, uses a Solana escrow, but the libraries don't.",
    },
    {
      q: "Are the libraries ready for production?",
      a: `They are at version ${version}: expect changes between releases, and pin versions. Each library's page lists what it doesn't do. The zero-knowledge library, \`@toip-tools/anon-membership\`, is experimental cryptography: its proof system's zero-knowledge mode is designed to be zero-knowledge, and Noir says it is not yet for production use. Report problems in the [issue tracker](${REPO}/issues).`,
    },
    {
      q: "What license are the libraries under?",
      a: `${license === "Apache-2.0" ? "The Apache License 2.0 (`Apache-2.0`)" : `\`${license}\``}, as stated in each package's \`package.json\` and the repository's [LICENSE](${REPO}/blob/main/LICENSE) file.`,
    },
    {
      q: "How do I use these docs with an AI coding assistant?",
      a: `Point it at [llms.txt](/llms.txt) for an index, or [llms-full.txt](/llms-full.txt) for all the documentation in one Markdown file. Every page also has a Markdown version at \`index.md\` under its address, and the [machine-readable indexes](/api/) list every package, export, Trust Task type and example as JSON.`,
    },
    {
      q: "How do I report a security problem?",
      a: `Use GitHub's [security page for the repository](${REPO}/security), or open an [issue](${REPO}/issues) if the problem is not sensitive. The same contacts are in [/.well-known/security.txt](/.well-known/security.txt).`,
    },
  ];
}

const based = (s: string) => s.replace(/\]\(\//g, `](${u("/")}`);

export function faqPage(): Page {
  const list = faqs();
  const body = html`<div class="wrap docs">
  ${docsNav("/faq/", list.map((f) => ({ label: f.q, href: `#${slug(f.q)}` })))}
  <div class="docs__content">
    ${pageHead("Frequently asked questions", "Short answers about Trust over IP, TSP, the libraries, and how this project relates to the Trust over IP Foundation.")}
    <div class="faq">${list.map((f) => html`<section class="faq__item prose" aria-labelledby="${slug(f.q)}">
      <h2 id="${slug(f.q)}">${f.q}</h2>
      ${md(based(f.a))}
    </section>`)}</div>
  </div>
</div>`;
  return {
    path: "/faq/",
    title: "FAQ",
    seoTitle: "FAQ: Trust over IP, TSP, Trust Tasks and the @toip-tools TypeScript libraries",
    description: "What Trust over IP and TSP are, how toip.tools relates to the ToIP Foundation, how to install, Node version, browser support, DID methods and license.",
    section: "faq",
    kind: "faq",
    eyebrow: "FAQ",
    ogFooter: "npm install @toip-tools/trust-core",
    tools: true,
    sources: ["site/src/pages/faq.ts", "site/src/data/libraries.ts"],
    schema: [{
      "@type": "FAQPage",
      "@id": `${abs("/faq/")}#faq`,
      url: abs("/faq/"),
      name: "Frequently asked questions about toip.tools",
      inLanguage: "en",
      mainEntity: list.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: plain(f.a) } })),
    }],
    body,
  };
}
