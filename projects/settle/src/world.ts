/**
 * The repair job's cast (design §10) on a local chain and a real relay: a landlord, Joe the plumber,
 * Alice the tenant, Settle's arbiter and processor, and a licensing board that vouches for Joe.
 */
import { DemoClock, identityFromSeed, issueCredential, seedFrom, type Traffic } from "@zk-toip/trust-core";
import type { Address, KeyPairSigner } from "@solana/kit";
import { Simnet } from "./chain/simnet";
import { SettlePolicy } from "./protocol/policy";
import { Arbiter, Attester, Payee, Payer, Processor } from "./agents/roles";
import type { AgentEvent, Directory } from "./agents/base";

export const USDC = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

export interface World {
  clock: DemoClock;
  net: Simnet;
  mint: Address;
  landlord: Payer;
  joe: Payee;
  alice: Attester;
  arbiter: Arbiter;
  processor: Processor;
  boardDid: string;
  /** Moves test USDC into an account, standing in for each party's wallet or on-ramp. */
  wallet: (to: Address, units: bigint) => Promise<void>;
  /** Moves the demo clock and the chain's clock forward together. */
  advance: (seconds: number) => void;
  stop: () => void;
}

export async function createWorld(opts: { relayUrl: string; start?: string; onEvent?: (e: AgentEvent) => void; onTraffic?: (who: string, t: Traffic) => void; seed?: string }): Promise<World> {
  const clock = new DemoClock(opts.start ?? "2026-11-06T09:00:00Z");
  const net = await Simnet.create();
  net.setNow(BigInt(Math.floor(clock.now() / 1000)));
  const policy = await SettlePolicy.load();
  const tag = opts.seed ?? crypto.randomUUID();
  const id = (n: string) => identityFromSeed(seedFrom(`settle-world/${tag}/${n}`));
  const ids = { landlord: id("landlord"), joe: id("joe"), alice: id("alice"), arbiter: id("arbiter"), processor: id("processor"), board: id("board") };
  const issuer: KeyPairSigner = await net.funded();
  const mint = await net.createMint(issuer);
  const arbiterKey = await Arbiter.keyFor(ids.arbiter);
  const directory: Directory = {
    names: {
      [ids.landlord.did]: "Landlord",
      [ids.joe.did]: "Joe (plumber)",
      [ids.alice.did]: "Alice (tenant)",
      [ids.arbiter.did]: "Settle Arbitration",
      [ids.processor.did]: "Settle Processor",
      [ids.board.did]: "Contractor Licensing Board",
    },
    processor: ids.processor.did,
    arbiter: { did: ids.arbiter.did, key: arbiterKey.address },
    licensingBoard: ids.board.did,
    mint,
  };
  // Each agent gets its own copy of who's who, as separately configured devices would.
  const common = () => ({ relayUrl: opts.relayUrl, clock, net, policy, directory: structuredClone(directory), onEvent: opts.onEvent, onTraffic: opts.onTraffic });
  const landlord = new Payer({ ...common(), name: "Landlord", identity: ids.landlord });
  const joe = new Payee({ ...common(), name: "Joe (plumber)", identity: ids.joe });
  const alice = new Attester({ ...common(), name: "Alice (tenant)", identity: ids.alice });
  const arbiter = new Arbiter({ ...common(), name: "Settle Arbitration", identity: ids.arbiter });
  const processor = new Processor({ ...common(), name: "Settle Processor", identity: ids.processor });

  await processor.setup(mint);
  landlord.setProcessorFeePayer(processor.feePayer.address);
  landlord.trustedLicensers = [ids.board.did];
  joe.credentials.push(
    issueCredential(ids.board, clock, {
      type: ["VerifiableCredential", "ContractorLicense"],
      credentialSubject: { id: ids.joe.did, trade: "plumbing", license: "PL-20417", jurisdiction: "Example City" },
      validUntil: new Date(clock.now() + 365 * 86400_000).toISOString(),
    }),
  );
  await Promise.all([landlord, joe, alice, arbiter, processor].map((a) => a.start()));

  return {
    clock,
    net,
    mint,
    landlord,
    joe,
    alice,
    arbiter,
    processor,
    boardDid: ids.board.did,
    wallet: (to, units) => net.mintTo(mint, to, issuer, units),
    advance: (seconds) => {
      clock.advance(seconds * 1000);
      net.setNow(BigInt(Math.floor(clock.now() / 1000)));
    },
    stop: () => [landlord, joe, alice, arbiter, processor].forEach((a) => a.stop()),
  };
}
