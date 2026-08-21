#!/usr/bin/env node

import path from "path";
import dotenv from "dotenv";
import chalk from "chalk";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { runWizard, inspectDrop } from "./wizard";
import { closePrompts } from "./prompt";
import { resolveChain } from "./chains";
import { planRpcs, resolveRpcsForChain } from "./rpc-resolver";

const HELP = `
SIRBOT — NFT Mint Sniper

  Snipes FCFS, Public, and GTD stages of OpenSea SeaDrop drops across
  Ethereum, Base, and Robinchain. Calldata is built from on-chain state,
  so no OpenSea account or access token is required.

Usage
  npm start                          run the interactive wizard
  npm start -- check <address>       inspect a collection's stages (no keys needed)
  npm start -- check <address> --chain base
  npm start -- --help                show this message

The wizard asks for: keys, chain, mint type, quantity, NFT link, RPC, gas and timing.
Optional defaults can be set in .env (see .env.example).
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }

  try {
    if (args[0] === "check") {
      await runCheck(args.slice(1));
      return;
    }
    await runWizard();
    closePrompts();
    process.exit(0);
  } catch (err: any) {
    closePrompts();
    console.error(chalk.red(`\n❌ ${err.message}\n`));
    process.exit(1);
  }
}

// npm start -- check <address> [--chain <key>]
async function runCheck(args: string[]): Promise<void> {
  const contractArg = args.find((a) => !a.startsWith("--"));
  if (!contractArg || !/^0x[0-9a-fA-F]{40}$/.test(contractArg)) {
    console.error(chalk.red(`  ✗ Usage: npm start -- check <0x-contract-address> [--chain ethereum|base|robinchain]\n`));
    process.exit(1);
  }

  const chainFlag = args.indexOf("--chain");
  const chainKey =
    (chainFlag >= 0 && args[chainFlag + 1]) ||
    (process.env.CHAIN || "base").trim().toLowerCase();
  const chainProfile = resolveChain(chainKey);
  if (!chainProfile) {
    console.error(chalk.red(`  ✗ Unknown chain "${chainKey}" — use ethereum, base, or robinchain.\n`));
    process.exit(1);
  }

  const { urls: candidateRpcs } = resolveRpcsForChain(chainKey);
  const rpcPlan = await planRpcs(candidateRpcs, chainProfile.chainId);
  if (rpcPlan.urls.length === 0) {
    throw new Error(`No usable RPC endpoint for ${chainProfile.name}`);
  }

  console.log(
    chalk.bold.cyan(`\n╔═══════════════════════════════════════╗\n║            S I R B O T                 ║\n║   FCFS · Public · GTD · no OpenSea     ║\n╚═══════════════════════════════════════╝`)
  );
  console.log(
    chalk.gray(
      `  Checking ${contractArg} on ${chainProfile.name} via ${rpcPlan.urls.length} endpoint(s)...`
    )
  );

  await inspectDrop({ contract: contractArg, chainKey, rpcUrls: rpcPlan.urls });
  console.log(chalk.gray("\n  To mint it, run the wizard (npm start) with this contract address.\n"));
}

void main();
