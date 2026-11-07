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
      "Conditional payments between parties who don't trust each other. A customer pays a link; the money waits in a stablecoin escrow on Solana that nobody controls alone, not even the processor; two of payer, payee and arbiter must sign to move it. Every step between the parties is a signed Trust Task over TSP, and each party's device runs the payment's Rego policy before it signs anything.",
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
      { src: "img/settle-released.jpg", alt: "A released payment: payer and payee seals are checked, the arbiter's is empty, and an activity list shows each signed step from invoice to receipt.", caption: "Two of three seals released the money. The activity list is the Trust Tasks.", width: 1280, height: 1245 },
      { src: "img/settle-arbiter.jpg", alt: "The operator view of a dispute: the payer reported no hot water, and the arbiter is ruling 180 of 300 USDC to the plumber, with reasons.", caption: "An arbiter rules a split. The ruling is signed and goes into the evidence.", width: 1280, height: 860 },
    ],
    specs: "settle",
  },
  {
    slug: "shared-todo",
    name: "Shared To-Do",
    status: "working",
    pitch:
      "Shared to-do lists for a household, with no server you have to trust. Each person and each list has its own key and DID, made on the device. Membership is a credential the list's key signs; every change is a signed operation sent to each member as an encrypted TSP message and checked by every device before it's applied. A relay only passes sealed messages along.",
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
      "A drop box for whistleblowers. A source proves to a journalist \"I am a current member of organization X\" without saying which member, sends a tip with documents, and can carry on a conversation. Each tip uses a fresh, unlinkable DID, and the source keeps nothing on their device but a code written on paper.",
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
      "Forums where every post is anonymous but posting needs a credential: \"only licensed RNs post here\", \"only residents of district 7 vote in this poll\". Each person has one pseudonym per forum, so there are no sockpuppets, and their pseudonyms in different forums can't be linked.",
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
      "Passports and mandates for AI agents. An agent gets its own identity and a bounded, revocable authority to act for a person or a company. It hires people and other agents on Settle; deterministic code between the model and the keys checks every payment and message against the mandate chain; and everything it does goes into a signed log its principal can check.",
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
      "Verifiable audit trails for agents, devices and services: a small service with three witnesses, a watcher and a web explorer, on top of the event-log library. It catches a forged edit, a fork shown to one party, a witness that signs two versions, and a stolen key rotated away.",
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
    status: "being built",
    pitch:
      "Cameras and sensors with their own identities. A device signs what it captures with a key the page or chip won't give up; every edit adds a signed link; anyone can check in a browser where a photo or reading came from, when, and what was done to it. Redactions are provable: the verifier checks that every pixel outside the redacted area is what the camera captured.",
    demonstrates: ["Device keys in WebCrypto and passkeys.", "Owner-to-device mandates.", "Key histories that keep old captures verifiable after a rotation."],
    libraries: ["cose", "eventlog", "mandates", "web-vault", "mesh-transport"],
    coming: "The MVP is being built now.",
  },
  {
    slug: "mesh",
    name: "Mesh",
    status: "being built",
    pitch:
      "Trust Tasks without the internet: over LoRa radio, Bluetooth LE, and on a USB stick carried by hand. A sealed message needs its carrier to be trusted only to deliver it, so a radio can carry it as well as a relay can. The demo opens a door with no internet in under two seconds, and forwards a Settle attestation from a cabin through a gateway.",
    demonstrates: ["Compact Trust Tasks with every proof intact.", "Random-looking address tags instead of DIDs on the air.", "Gateways that hand exact TSP bytes to the relay."],
    libraries: ["mesh-transport", "cose", "trust-core"],
    coming: "Being built now, on a simulated radio first.",
  },
  {
    slug: "commons",
    name: "Commons",
    status: "design only",
    pitch:
      "A suite of small apps for an apartment building and its households: guest and delivery passes checked by a door kiosk, shared expenses, maintenance requests, household votes, a board and lists. One identity per person; the building and each household are nested communities.",
    demonstrates: ["Nested communities and roles.", "Many small apps sharing one identity and one trust core."],
    libraries: ["trust-core", "relay"],
  },
  {
    slug: "community-rides",
    name: "Community Rides",
    status: "design only",
    pitch:
      "A straw-man ride share for a local community, written for show and tell. It makes \"the community vouches, peers verify\" concrete, and shows what each party learns at each step. It is designed directly on the OpenVTC libraries, using real Trust Tasks registry specs where their required fields can be filled honestly.",
    demonstrates: ["Registry Trust Tasks alongside your own.", "What each party learns, step by step."],
    libraries: [],
  },
];

export const projectBySlug = (s: string) => projects.find((p) => p.slug === s)!;
