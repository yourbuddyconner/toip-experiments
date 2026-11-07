// The projects in projects/, with honest status. Facts come from each project's README and design.

export type ProjectStatus = "working" | "being built" | "design only";

export interface Project {
  slug: string;
  name: string;
  status: ProjectStatus;
  pitch: string;
  demonstrates: string[];
  libraries: string[];
  run?: { what: string; cmd: string }[];
  coming?: string;
  shots?: { src: string; alt: string; caption: string; width: number; height: number }[];
  specs?: string;
}

export const projects: Project[] = [
  {
    slug: "settle",
    name: "Settle",
    status: "working",
    pitch:
      "Conditional payments with shared control of escrow. A customer pays through a link, and stablecoins wait in a Solana escrow until two of the payer, payee, and arbiter sign to move them. Signed Trust Tasks coordinate each step. Before signing, each party's device checks the payment's Rego policy.",
    demonstrates: [
      "A Trust Task vocabulary for a real protocol: invoices, terms, attestations, disputes, rulings, receipts.",
      "Identity off-chain, fresh keys on-chain, bound together by credentials only the parties see.",
      "Passkey-sealed keys in the browser, and operators who sign in with their own key instead of a password.",
    ],
    libraries: ["trust-core", "relay", "web-vault"],
    run: [
      { what: "The whole network and the web app, on a local Solana cluster", cmd: "npm run settle" },
      { what: "A narrated demo in the terminal", cmd: "npm run demo --workspace projects/settle" },
      { what: "The app in a real browser, with screenshots", cmd: "npm run e2e --workspace projects/settle" },
    ],
    shots: [
      { src: "img/settle-checkout.jpg", alt: "Settle's hosted checkout: Joe's Plumbing, verified, asks 120.00 USDC to fix a kitchen sink, and explains that the money goes into an escrow nobody can empty alone.", caption: "Hosted checkout for a payment link.", width: 1280, height: 974 },
      { src: "img/settle-released.jpg", alt: "A released payment: payer and payee seals are checked, the arbiter's is empty, and an activity list shows each signed step from invoice to receipt.", caption: "Two signatures release the funds. The activity log records each Trust Task.", width: 1280, height: 1245 },
      { src: "img/settle-arbiter.jpg", alt: "The operator view of a dispute: the payer reported no hot water, and the arbiter is ruling 180 of 300 USDC to the plumber, with reasons.", caption: "An arbiter signs a split ruling, preserving the decision as evidence.", width: 1280, height: 860 },
    ],
    specs: "settle",
  },
  {
    slug: "shared-todo",
    name: "Shared To-Do",
    status: "working",
    pitch:
      "Private to-do lists for a household. Each person and list has its own key and DID, created on the device. The list signs membership credentials, and members exchange signed changes in encrypted TSP messages. Every device verifies a change before applying it; the relay handles delivery without reading the list.",
    demonstrates: [
      "The basic ToIP ideas in an app small enough to read in an afternoon.",
      "Invitations, roles, removal, and private items sealed to chosen readers.",
      "Offline outboxes and catching up from other members, through a relay that can't read anything.",
    ],
    libraries: ["trust-core", "relay"],
    run: [{ what: "The relay on ws://localhost:8787 and the app on http://localhost:5181", cmd: "npm run dev" }],
    specs: "todo",
  },
  {
    slug: "tipline",
    name: "Tipline",
    status: "working",
    pitch:
      "A drop box that lets sources prove membership without revealing their identity. A source shows a journalist that they belong to an organization, shares documents, and continues the conversation using a fresh DID for the tip. A code written on paper lets them return without keeping the conversation on their device.",
    demonstrates: ["Zero-knowledge group membership in the browser.", "Counting distinct sources by nullifier without knowing any of them."],
    libraries: ["anon-membership", "trust-core", "relay", "web-vault"],
    run: [
      { what: "The organization, the source app, the journalist's inbox and the relay, each on its own localhost origin", cmd: "npm run tipline" },
      { what: "The whole story, narrated in the terminal", cmd: "npm run demo --workspace projects/tipline" },
      { what: "The demo in a real browser, checking the source leaves nothing behind", cmd: "npm run e2e --workspace projects/tipline" },
    ],
  },
  {
    slug: "agora",
    name: "Agora",
    status: "working",
    pitch:
      "Anonymous forums with verified membership. A forum can require a nursing license to post, or district residency to vote, without asking members to reveal their identity. Each membership has one pseudonym per forum; the membership proofs keep those pseudonyms from being linked across forums.",
    demonstrates: ["Credential-gated anonymity with attribute predicates.", "One vote per person with secret ballots.", "A signed, append-only feed the host can't quietly rewrite."],
    libraries: ["anon-membership", "eventlog", "trust-core", "relay", "web-vault"],
    run: [
      { what: "Issuers, the forum host and the web app on http://localhost:4320", cmd: "npm run agora" },
      { what: "The twelve demo steps, narrated in the terminal", cmd: "npm run demo --workspace projects/agora" },
      { what: "Members, a non-member and a reader, in a real browser", cmd: "npm run e2e --workspace projects/agora" },
    ],
  },
  {
    slug: "agents",
    name: "Agents",
    status: "working",
    pitch:
      "AI agents with identities, spending limits, and accountable actions. A person or company gives an agent a revocable mandate. As it hires people and other agents through Settle, a guard checks every payment and message against that mandate chain. A signed audit trail lets the principal review what happened.",
    demonstrates: ["Delegation that only narrows, checked by both the agent's guard and its counterparties.", "Escalation to a human for one exact action.", "Audit trails an agent can't quietly rewrite."],
    libraries: ["mandates", "eventlog", "trust-core", "relay"],
    run: [
      { what: "The principal's console and the courier's view on http://localhost:4330", cmd: "npm run agents" },
      { what: "The whole story in the terminal, with scripted models", cmd: "npm run demo --workspace projects/agents" },
      { what: "The same story with Claude, if ANTHROPIC_API_KEY is set", cmd: "npm run demo --workspace projects/agents -- --live" },
    ],
  },
  {
    slug: "trail",
    name: "Trail",
    status: "working",
    pitch:
      "Verifiable audit trails for agents, devices, and services. A local network of witnesses and watchers makes log tampering visible in a web explorer. The demo walks through forged edits, conflicting histories, dishonest witnesses, and recovery from a stolen key.",
    demonstrates: ["KERI key event logs with pre-rotation and witnesses, verified by KERIpy.", "Duplicity detection by watchers."],
    libraries: ["eventlog", "trust-core"],
    run: [
      { what: "Four witnesses, two watchers and the explorer on http://localhost:4340", cmd: "npm run trail" },
      { what: "The ten steps, attacks included, narrated in the terminal", cmd: "npm run demo --workspace projects/trail" },
      { what: "The explorer through all ten steps in a real browser", cmd: "npm run e2e --workspace projects/trail" },
    ],
  },
  {
    slug: "capture",
    name: "Capture",
    status: "working",
    pitch:
      "Verifiable origins for photos and sensor readings. The design gives each device an identity and a key it can use without exporting. Captures and edits form a signed history that readers can check in a browser. Redaction proofs are designed to show that pixels outside a hidden region still match the original capture.",
    demonstrates: ["Device keys in WebCrypto and passkeys.", "Owner-to-device mandates.", "Key histories that keep old captures verifiable after a rotation."],
    libraries: ["cose", "eventlog", "mandates", "web-vault", "mesh-transport"],
    run: [
      { what: "The camera, editor, verifier and sensor dashboard on http://localhost:4350, with witnesses and simulated sensors", cmd: "npm run capture" },
      { what: "One more sensor, sending signed readings over the simulated LoRa radio", cmd: "npm run sensor --workspace projects/capture" },
      { what: "Capture, a blur edit and verification in a real browser with a fake camera", cmd: "npm run e2e --workspace projects/capture" },
    ],
  },
  {
    slug: "mesh",
    name: "Mesh",
    status: "working",
    pitch:
      "Trust Tasks beyond an internet connection. Three simulator demos verify a door pass offline, forward a Settle attestation through a radio gateway, and deliver a sealed bundle by hand. A visualizer shows the frames, retries, and airtime. Real-radio bring-up and Bluetooth LE remain future work.",
    demonstrates: ["Compact Trust Tasks with every proof intact.", "Random-looking address tags instead of DIDs on the air.", "Gateways that hand exact TSP bytes to the relay."],
    libraries: ["mesh-transport", "cose", "trust-core"],
    run: [
      { what: "The radio visualizer on http://localhost:4360: a field map, frames in flight, airtime meters", cmd: "npm run mesh" },
      { what: "All three acts on the simulated radio, narrated in the terminal", cmd: "npm run demo --workspace projects/mesh" },
      { what: "Checks a LoRa gateway or RAK3172 is talking to you (see HARDWARE.md)", cmd: "npm run mesh --workspace projects/mesh -- doctor" },
    ],
  },
  {
    slug: "commons",
    name: "Commons",
    status: "design only",
    pitch:
      "Everyday tools for an apartment building and its households. The design brings guest passes, shared expenses, maintenance requests, votes, and noticeboards under one identity per person. The building and its households form nested communities with their own roles.",
    demonstrates: ["Nested communities and roles.", "Many small apps sharing one identity and one trust core."],
    libraries: ["trust-core", "relay"],
  },
  {
    slug: "community-rides",
    name: "Community Rides",
    status: "design only",
    pitch:
      "A proposal for ride sharing within a local community. The community vouches for its members, and riders and drivers verify those claims directly. Built around the OpenVTC libraries and applicable registry specifications, the design traces what each party learns at every step.",
    demonstrates: ["Registry Trust Tasks alongside your own.", "What each party learns, step by step."],
    libraries: [],
  },
];

export const projectBySlug = (s: string) => projects.find((p) => p.slug === s)!;
