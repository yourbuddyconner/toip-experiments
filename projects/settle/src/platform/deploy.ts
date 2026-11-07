/**
 * Deploys the Settle program to a real cluster, paid for by the platform's treasury key.
 *
 *   npm run deploy --workspace @toip-tools/settle -- --cluster devnet
 *
 * It uses the Solana CLI (https://solana.com/docs/intro/installation) and deploys program/dist/settle_escrow.so
 * at the development program id (program/keys), with the treasury as its upgrade authority. If the treasury is
 * short of SOL, it asks the cluster's faucet; on devnet that is often rate-limited, so it may tell you the
 * address to send SOL to instead.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fromB64u } from "@toip-tools/trust-core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Chain } from "../chain/chain";
import { PROGRAM_KEYPAIR, PROGRAM_SO } from "../chain/simnet";
import { CLUSTERS, developmentProgramId, LAMPORTS_PER_SOL } from "./cluster";
import { DataDir, signerOf } from "./state";
import { dataDirFor, flag } from "./main-args";

/** What running the platform needs on top (its start minimum and the processor's fee float), so one top-up does both. */
const RUN_LAMPORTS = (3n * LAMPORTS_PER_SOL) / 10n;

function solanaCli(): string {
  for (const c of [process.env.SOLANA_CLI, "solana", join(homedir(), ".local/share/solana/install/active_release/bin/solana")]) {
    if (!c) continue;
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {
      // try the next
    }
  }
  throw new Error("the Solana CLI isn't installed: see https://solana.com/docs/intro/installation (or set SOLANA_CLI)");
}

export async function deploy(clusterArg: string, dataDir: string, log = console.log): Promise<{ programId: string; signature?: string }> {
  const rpcUrl = CLUSTERS[clusterArg] ?? clusterArg;
  if (!/^https?:\/\//.test(rpcUrl)) throw new Error(`deploy to a real cluster: devnet, localnet or an RPC URL (not "${clusterArg}")`);
  const programId = await developmentProgramId();
  const chain = await Chain.connect(rpcUrl, programId);
  const data = new DataDir(dataDir);
  const secrets = data.secrets({ rpcUrl, programId });
  const treasury = await signerOf(secrets.keys.treasury);

  const existing = await chain.rpc.getAccountInfo(programId, { encoding: "base64", commitment: "confirmed" }).send();
  if (existing.value?.executable) {
    log(`The Settle program is already deployed on ${clusterArg} at ${programId}.`);
    return { programId };
  }

  // The program's data account holds the program; the buffer holds it again while it's written, and is closed after.
  const size = statSync(PROGRAM_SO).size;
  const DEPLOY_LAMPORTS = (await chain.rent(size + 45)) + (await chain.rent(size + 37)) + LAMPORTS_PER_SOL / 20n;
  const want = DEPLOY_LAMPORTS + RUN_LAMPORTS;
  const have = await chain.lamports(treasury.address);
  if (have < DEPLOY_LAMPORTS) {
    log(`Asking ${clusterArg}'s faucet for SOL for the treasury (${treasury.address})...`);
    for (let i = 0; i < 2 && (await chain.lamports(treasury.address)) < DEPLOY_LAMPORTS; i++) await chain.airdrop(treasury.address, 2n).catch((e) => log(`  the faucet said no: ${String(e.message).slice(0, 120)}`));
  }
  const now = await chain.lamports(treasury.address);
  if (now < DEPLOY_LAMPORTS) {
    const sol = (l: bigint) => (Number(l) / 1e9).toFixed(2);
    throw new Error(
      `the treasury has ${sol(now)} SOL; deploying needs ${sol(DEPLOY_LAMPORTS)} and running the platform about ${sol(RUN_LAMPORTS)} more. ` +
        `Send ${sol(want - now)} SOL or more to ${treasury.address}${clusterArg === "devnet" ? " (https://faucet.solana.com)" : ""} and run this again.`,
    );
  }

  // The CLI wants the treasury as a keypair file; it exists only while the deploy runs.
  const seed = fromB64u(secrets.keys.treasury);
  const keyfile = data.path(".treasury-keypair.json");
  writeFileSync(keyfile, JSON.stringify([...seed, ...ed25519.getPublicKey(seed)]), { mode: 0o600 });
  try {
    log(`Deploying ${PROGRAM_SO} to ${clusterArg} as ${programId}...`);
    const out = execFileSync(solanaCli(), ["program", "deploy", "--url", rpcUrl, "--keypair", keyfile, "--program-id", PROGRAM_KEYPAIR, "--upgrade-authority", keyfile, "--commitment", "confirmed", PROGRAM_SO], { encoding: "utf8" });
    const signature = /Signature: (\w+)/.exec(out)?.[1];
    log(out.trim());
    return { programId, signature };
  } finally {
    if (existsSync(keyfile)) rmSync(keyfile);
  }
}

if (process.argv[1]?.endsWith("deploy.ts")) {
  const cluster = flag("cluster") ?? "devnet";
  deploy(cluster, dataDirFor(cluster)).then(
    () => process.exit(0),
    (e) => {
      console.error(`\n  ${(e as Error).message}\n`);
      process.exit(1);
    },
  );
}
