import type { World } from "./world";

export interface Step {
  n: number;
  title: string;
  caption: string;
  /** Demo time that passes before the step. Default one minute. */
  advanceMs?: number;
  run(w: World): Promise<void>;
}

/** Design section 3. Captions are for people who aren't technical. */
export const STEPS: readonly Step[] = [
  {
    n: 1,
    title: "Everyone has an identity",
    caption: "Each phone made its own key pair and an identifier from it. Nobody registered anywhere, and there is no account server.",
    run: async () => {},
  },
  {
    n: 2,
    title: "Alice creates the list",
    caption: "The list gets its own key and identifier, held on Alice's phone. Its rules say who may add, check off, edit and delete. Alice is its admin.",
    run: async (w) => {
      w.people.alice.createList("Maple St House");
    },
  },
  {
    n: 3,
    title: "Alice invites Bob",
    caption: "Bob scans Alice's invitation. From now on every message between them is encrypted for the recipient and signed by the sender. The list gives Bob an editor credential, and Bob signs back that he accepts it.",
    run: async (w) => {
      const inv = w.people.alice.invite("editor");
      w.refs.invitations.bob = inv;
      await w.people.bob.scan(inv);
    },
  },
  {
    n: 4,
    title: "Alice invites Carol, the landlord",
    caption: "Carol joins the same way, as a viewer: she can see the list but not change it.",
    run: async (w) => {
      const inv = w.people.alice.invite("viewer");
      w.refs.invitations.carol = inv;
      await w.people.carol.scan(inv);
    },
  },
  {
    n: 5,
    title: "Bob and Alice add items",
    caption: "Each change is signed by its author and sent, encrypted, to every member. Every phone checks the signature, the author's membership and the rules before showing it.",
    run: async (w) => {
      w.refs.items.milk = await w.people.bob.add("Milk");
      await w.settle();
      w.refs.items.porch = await w.people.alice.add("Fix the porch light");
    },
  },
  {
    n: 6,
    title: "A private item",
    caption: "Alice adds an item only she and Bob can read. Carol's phone still checks and accepts it, because it can verify who wrote it without reading it. What leaks: that it exists, who wrote it, when, and who can read it.",
    run: async (w) => {
      w.refs.items.gift = await w.people.alice.add("Carol's birthday present", [w.people.bob.did]);
    },
  },
  {
    n: 7,
    title: "Carol tries to add an item",
    caption: "Carol's app refuses, because viewers can't add. A modified app sends it anyway, and every other phone rejects it on its own.",
    run: async (w) => {
      const carol = w.people.carol;
      await carol.add("Raise rent");
      carol.sendAnyway = true;
      try {
        await carol.add("Raise rent");
      } finally {
        carol.sendAnyway = false;
      }
    },
  },
  {
    n: 8,
    title: "Mallory tries to sneak in",
    caption: "Bob once showed Mallory his membership credential. Credentials aren't secrets. But the change she sends is signed by her key, not Bob's, so every phone rejects it.",
    run: async (w) => {
      const { alice, bob, carol, mallory } = w.people;
      mallory.knowledge.add({ about: bob.did, what: "membership credential", how: "Bob showed it to me" });
      await mallory.sneakIn({ list: alice.list!.did, targets: [alice.did, bob.did, carol.did], membership: bob.membership!, text: "Let Mallory in" });
    },
  },
  {
    n: 9,
    title: "Bob goes offline",
    caption: "Alice checks off the milk. Bob's phone is off, so Alice's phone leaves the message at the relay, still sealed for Bob. The relay can't read it.",
    advanceMs: 3600_000,
    run: async (w) => {
      await w.people.bob.setOnline(false);
      await w.people.alice.check(w.refs.items.milk);
    },
  },
  {
    n: 10,
    title: "Bob catches up",
    caption: "Bob's phone collects the message from the relay and checks Alice's signature before applying it. The relay delivered it, but the signature says who wrote it.",
    run: async (w) => {
      await w.people.bob.setOnline(true);
    },
  },
  {
    n: 11,
    title: "Alice removes Bob",
    caption: "Alice revokes Bob's membership and every phone gets the signed revocation list. Bob's next change is rejected everywhere. He still has his old copy: revocation stops future changes, but it can't make anyone forget.",
    run: async (w) => {
      const { alice, bob } = w.people;
      await alice.revoke(bob.did);
      await w.settle();
      bob.sendAnyway = true;
      try {
        await bob.add("Bob's farewell party");
      } finally {
        bob.sendAnyway = false;
      }
    },
  },
  {
    n: 12,
    title: "Bob tampers with an old change",
    caption: "Bob edits a copy of Alice's change to say \"Give Bob his deposit back\" and forwards it to Carol. Carol's phone rejects it: the signature no longer matches.",
    run: async (w) => {
      const { bob, carol } = w.people;
      const op = bob.state.allOps().find((o) => o.kind === "add" && o.itemId === w.refs.items.porch);
      if (!op) throw new Error("Bob doesn't hold Alice's porch-light change");
      await bob.forwardTampered(op.id, "Give Bob his deposit back", carol.did);
    },
  },
];
