// Interactive SIRBOT wizard — supports FCFS, Public, and GTD mint stages.
//
// Every FCFS/Public transaction here is built from on-chain SeaDrop state, so no
// OpenSea account, token or API key is involved in the mint itself.
//
// GTD mints require a Merkle proof that the user provides (from the collection's
// allowlist/GTD distribution). The wizard guides the user through this.
//
// Nothing is written to disk: pasted keys live in memory for the run only.

import chalk from "chalk";
import { JsonRpcProvider, Wallet, formatEther, getAddress, isAddress, solidityPackedKeccak256 } from "ethers";
import { CHAINS, ChainProfile, resolveChain } from "./chains";
import { parseNftLink } from "./nft-link";
import { resolveSlug } from "./slug-resolver";
import {
  maskRpc,
  planRpcs,
  privateRpcsFromEnv,
  resolveRpcsForChain,
  toRpcUrl,
} from "./rpc-resolver";
import { parseRpcEndpoints } from "./rpc-blast";
import { buildLocalMintPlan, buildLocalMintPlanAny, buildGtdMintPlan, LocalMintPlan, MintStageType, stageStatus } from "./seadrop";
import { mintSnipe } from "./mint";
import { formatRemaining, istTimeToDate, toIST } from "./time-format";
import { askChoice, askHidden, askNumber, askText, askYesNo, closePrompts } from "./prompt";

// ── Full interactive flow ────────────────────────────────────────────────

export async function runWizard(): Promise<void> {
  printBanner();

  // ── 1. Private keys ───────────────────────────────────────────────────
  const walletKeys = await promptKeys();

  // ── 2. Chain ──────────────────────────────────────────────────────────
  let chainKey = await askChoice<string>(
    "Which chain?",
    CHAINS.map((c) => ({ label: c.name, value: c.key, hint: `chain id ${c.chainId}` })),
    Math.max(
      0,
      CHAINS.findIndex((c) => c.key === (process.env.CHAIN || "base").toLowerCase())
    )
  );

  // ── 3. Mint type ──────────────────────────────────────────────────────
  const stageType = await askChoice<MintStageType>(
    "Mint type?",
    [
      { label: "FCFS (First Come, First Served)", value: "fcfs", hint: "open public sale" },
      { label: "Public", value: "public", hint: "standard public mint" },
      { label: "GTD (Guaranteed Total Distribution)", value: "gtd", hint: "allowlist / guaranteed allocation" },
    ],
    0
  );

  // ── 4. Quantity ───────────────────────────────────────────────────────
  const quantity = await promptQuantity(walletKeys.length);

  // ── 5. NFT link ───────────────────────────────────────────────────────
  const target = await promptTarget(chainKey);
  const nftContract = target.contract;
  chainKey = target.chainKey;
  const chainProfile = resolveChain(chainKey)!;

  // ── 6. RPC endpoints ──────────────────────────────────────────────────
  const manualRpcs = await promptRpc(chainProfile);
  const { urls: candidateRpcs, source } = resolveRpcsForChain(chainKey, manualRpcs);
  console.log(chalk.gray(`  Source: ${source}`));
  console.log(chalk.gray(`  Checking ${candidateRpcs.length} endpoint(s)...`));

  const rpcPlan = await planRpcs(candidateRpcs, chainProfile.chainId);

  for (const bad of rpcPlan.dropped) {
    const wrong = resolveChain(bad.chainId);
    console.log(
      chalk.red(`    ✗ ${labelOf(bad.url)} is chain ${bad.chainId}${wrong ? ` (${wrong.name})` : ""} — dropped`)
    );
  }
  for (const ep of parseRpcEndpoints(rpcPlan.urls)) {
    const failure = rpcPlan.failures.find((f) => f.url === ep.url);
    if (failure) {
      const benign = /not allowed|does not exist|not supported|method not found/i.test(failure.message);
      console.log(
        benign
          ? chalk.gray(`    • ${ep.label}  (send-only)`)
          : chalk.yellow(`    ⚠ ${ep.label}  ${failure.message.slice(0, 90)}`)
      );
    } else {
      console.log(chalk.green(`    ✓ ${ep.label}`));
    }
  }

  if (rpcPlan.urls.length === 0) {
    throw new Error(`No usable RPC endpoint for ${chainProfile.name}`);
  }
  if (!rpcPlan.verified) {
    console.log(chalk.yellow(`  ⚠ No endpoint confirmed chain id ${chainProfile.chainId}.`));
    if (!(await askYesNo("Continue anyway?", false))) {
      throw new Error("Aborted — could not verify the RPC chain");
    }
  } else {
    console.log(chalk.green(`  ✓ Confirmed chain id ${chainProfile.chainId} (${chainProfile.name})`));
  }
  const rpcUrls = rpcPlan.urls;

  // ── 7. Read the drop from chain ───────────────────────────────────────
  console.log(chalk.bold.white(`\n${stageType.toUpperCase()} stage`));

  let mintPlan: LocalMintPlan | null = null;

  if (stageType === "gtd") {
    // GTD requires Merkle proof from the user
    console.log(chalk.gray("  GTD mints require a Merkle proof from the collection's allowlist."));
    console.log(chalk.gray("  You can generate this from the collection's website or contract."));

    const merkleProof = await promptMerkleProof();
    const walletAddress = new Wallet(walletKeys[0]).address;

    mintPlan = await buildGtdMintPlan(rpcUrls[0], nftContract, quantity, walletAddress, merkleProof);
    if (!mintPlan) {
      throw new Error(
        `No SeaDrop GTD stage readable for ${nftContract} on ${chainProfile.name}.\n` +
        "  Either it isn't a SeaDrop collection, or its GTD stage is not configured."
      );
    }
  } else {
    mintPlan = await buildLocalMintPlanAny(rpcUrls, nftContract, quantity, stageType);
    if (!mintPlan) {
      throw new Error(
        `No SeaDrop ${stageType === "fcfs" ? "FCFS" : "public"} stage readable for ${nftContract} on ${chainProfile.name}.\n` +
        "  Either it isn't a SeaDrop collection, or the stage is not configured."
      );
    }
  }

  printDrop(mintPlan, chainProfile, quantity);

  const status = stageStatus(mintPlan.drop);
  if (status === "ended") {
    throw new Error(`This ${stageType.toUpperCase()} stage has already ended on-chain — nothing to mint.`);
  }

  // ── 8. Gas ────────────────────────────────────────────────────────────
  const provider = new JsonRpcProvider(rpcUrls[0], undefined, { staticNetwork: true });
  console.log(chalk.bold.white("\nGas"));
  const baseFeeGwei = await currentBaseFeeGwei(provider);
  if (baseFeeGwei !== null) {
    console.log(chalk.gray(`  Network base fee right now: ${baseFeeGwei.toFixed(6)} gwei`));
  }

  const envMaxFee = Number(process.env.MAX_FEE_PER_GAS || (chainKey === "ethereum" ? 80 : 2));
  const envPriority = Number(process.env.MAX_PRIORITY_FEE || (chainKey === "ethereum" ? 5 : 0.05));

  let defaultMaxFee = envMaxFee;
  if (baseFeeGwei !== null) {
    const suggested = Math.ceil((baseFeeGwei * 2 + envPriority) * 1000) / 1000;
    if (envMaxFee < baseFeeGwei) defaultMaxFee = suggested;
    console.log(chalk.gray(`  Must be at least ${baseFeeGwei.toFixed(6)} gwei; ${suggested} gives room to spare.`));
  }

  const maxFeeGwei = await askNumber("Max fee per gas (gwei) — your ceiling", defaultMaxFee, {
    min: baseFeeGwei ?? 0,
  });

  const priorityDefault = Math.min(envPriority, maxFeeGwei);
  const priorityGwei = await askNumber("Priority fee / tip (gwei)", priorityDefault, {
    min: 0,
    max: maxFeeGwei,
  });

  const maxFeePerGas = gweiToWei(maxFeeGwei);
  const maxPriorityFee = gweiToWei(priorityGwei);
  const gasLimit = parseInt(process.env.GAS_LIMIT || "0", 10) || 250_000;

  // ── 9. Timing ─────────────────────────────────────────────────────────
  const { targetStart, timingLabel } = await promptTiming(mintPlan.drop.startTime, status);

  // ── 10. Balances + affordability ──────────────────────────────────────
  console.log(chalk.bold.white("\nWallets"));
  const wallets = walletKeys.map((k) => new Wallet(k));
  const balances = await Promise.all(
    wallets.map((w) => provider.getBalance(w.address).catch(() => null))
  );
  const symbol = chainProfile.nativeSymbol;

  const required = BigInt(gasLimit) * maxFeePerGas + mintPlan.value;

  wallets.forEach((w, i) => {
    const bal = balances[i];
    const text = bal === null ? "balance unavailable" : `${Number(formatEther(bal)).toFixed(6)} ${symbol}`;
    const short = bal !== null && bal < required;
    const line = `  [W${i}] ${w.address}  ${text}`;
    console.log(short ? chalk.red(`${line}  ✗ needs ${formatEther(required)}`) : chalk.gray(line));
  });

  const shortWallets = wallets.filter((_, i) => balances[i] !== null && (balances[i] as bigint) < required);
  if (shortWallets.length > 0) {
    console.log(
      chalk.gray(
        `\n  Nodes require gasLimit × maxFee${mintPlan.value > 0n ? " + mint price" : ""} = ${formatEther(required)} ${symbol} held per wallet.`
      )
    );
    const poorest = balances
      .filter((b): b is bigint => b !== null)
      .reduce((a, b) => (a < b ? a : b));
    const affordable = Number((poorest - mintPlan.value) / BigInt(gasLimit)) / 1e9;
    if (affordable > 0) {
      console.log(
        chalk.yellow(`  Either fund the wallets, or re-run with a max fee at or below ${affordable.toFixed(4)} gwei.`)
      );
    }
    if (shortWallets.length === wallets.length) {
      throw new Error("Every wallet is underfunded — nothing could be broadcast.");
    }
    console.log(chalk.yellow("  The remaining wallet(s) can still fire."));
  }

  // ── 11. Confirm ──────────────────────────────────────────────────────
  console.log(chalk.bold.white("\n──────── READY ────────"));
  line("Chain", `${chainProfile.name} (${chainProfile.chainId})`);
  line("RPC", `${labelOf(rpcUrls[0])} + ${rpcUrls.length - 1} more`);
  line("Target", target.label);
  line("Contract", nftContract);
  line("Stage", stageType.toUpperCase());
  line("Wallets", `${wallets.length}`);
  line("Quantity", `${quantity} per wallet → ${quantity * wallets.length} total`);
  line(
    "Mint cost",
    `${formatEther(mintPlan.value)} per wallet → ${formatEther(mintPlan.value * BigInt(wallets.length))} total (+ gas)`
  );
  line("Gas", `${maxFeeGwei} / ${priorityGwei} gwei · limit ${gasLimit}`);
  line("Timing", timingLabel);
  console.log(chalk.bold.white("───────────────────────"));

  if (!(await askYesNo(chalk.bold("Fire?"), false))) {
    console.log(chalk.yellow("\n  Aborted — nothing was sent.\n"));
    closePrompts();
    return;
  }

  // Hand stdin back so readline never competes with the blast logging.
  closePrompts();

  await mintSnipe({
    nftContract,
    quantity,
    walletKeys,
    rpcUrls,
    maxFeePerGas,
    maxPriorityFee,
    gasLimit,
    targetStart,
    plan: mintPlan,
  });
}

// ── Drop inspection (no keys needed): npm start -- check <address> ──────

export interface InspectOpts {
  contract: string;
  chainKey: string;
  rpcUrls: string[];
}

export async function inspectDrop(opts: InspectOpts): Promise<void> {
  const { contract, chainKey, rpcUrls } = opts;
  const chainProfile = resolveChain(chainKey)!;

  console.log(chalk.bold.white("\nChecking all stages..."));

  // Check public/FCFS stage
  const publicPlan = await buildLocalMintPlanAny(rpcUrls, contract, 1);
  if (publicPlan) {
    console.log(chalk.bold.white("\n✓ Public / FCFS Stage"));
    printDrop(publicPlan, chainProfile, 1);
  } else {
    console.log(chalk.yellow("\n✗ No public/FCFS stage found"));
  }

  // Check GTD/allowlist stage
  console.log(chalk.bold.white("\nChecking GTD stage..."));
  const provider = new JsonRpcProvider(rpcUrls[0], undefined, { staticNetwork: true });
  const target = await resolveSeaDropTargetCheck(rpcUrls[0], contract);
  if (target) {
    try {
      const { fetchAllowListDrop } = await import("./seadrop");
      const gtdDrop = await fetchAllowListDrop(rpcUrls[0], contract, target.address);
      if (gtdDrop && !isZeroDropCheck(gtdDrop)) {
        console.log(chalk.bold.green("\n✓ GTD / Allowlist Stage"));
        const status = stageStatus(gtdDrop);
        const startsAt = new Date(gtdDrop.startTime * 1000);
        const endsAt = new Date(gtdDrop.endTime * 1000);
        const statusText =
          status === "live"
            ? chalk.green("LIVE")
            : status === "not-started"
              ? chalk.yellow(`NOT STARTED — opens in ${formatRemaining(startsAt.getTime() - Date.now())}`)
              : chalk.red("ENDED");
        console.log(chalk.gray(`  Status:       ${statusText}`));
        console.log(chalk.gray(`  Price:        ${formatEther(gtdDrop.mintPrice)}`));
        console.log(chalk.gray(`  Max per wallet: ${gtdDrop.maxTotalMintableByWallet}`));
        console.log(chalk.gray(`  Window:       ${toIST(startsAt)} → ${toIST(endsAt)} IST`));
        console.log(chalk.gray(`  Merkle root:  ${gtdDrop.merkleRoot}`));
      } else {
        console.log(chalk.yellow("\n✗ No GTD/allowlist stage found"));
      }
    } catch {
      console.log(chalk.yellow("\n✗ Could not read GTD stage"));
    }
  } else {
    console.log(chalk.yellow("\n✗ No GTD/allowlist stage found"));
  }
}

// Helper for inspectDrop
async function resolveSeaDropTargetCheck(rpcUrl: string, nftContract: string): Promise<{ address: string } | null> {
  const { resolveSeaDropTarget } = await import("./seadrop");
  return resolveSeaDropTarget(rpcUrl, nftContract);
}

function isZeroDropCheck(drop: any): boolean {
  return Number(drop.startTime) === 0 && Number(drop.endTime) === 0;
}

// ── Steps ───────────────────────────────────────────────────────────────

async function promptKeys(): Promise<string[]> {
  console.log(chalk.bold.white("Private keys"));
  console.log(chalk.gray("  Paste one key per line — typing is hidden. Blank line when done."));
  console.log(chalk.gray("  Each key is confirmed by its wallet address. Nothing is saved to disk."));

  const keys: string[] = [];
  const seen = new Set<string>();

  for (;;) {
    const raw = await askHidden(chalk.gray(`  › key ${keys.length + 1}: `));
    if (!raw) {
      if (keys.length === 0) {
        console.log(chalk.red("  ✗ Need at least one key."));
        continue;
      }
      break;
    }

    const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
    let wallet: Wallet;
    try {
      wallet = new Wallet(normalized);
    } catch {
      console.log(chalk.red("  ✗ Not a valid private key — try again."));
      continue;
    }

    if (seen.has(wallet.address.toLowerCase())) {
      console.log(chalk.yellow(`  ⚠ Duplicate of ${shortAddr(wallet.address)} — skipped.`));
      continue;
    }
    seen.add(wallet.address.toLowerCase());
    keys.push(normalized);
    console.log(chalk.green(`  ✓ [W${keys.length - 1}] ${wallet.address}`));
  }

  console.log(chalk.gray(`  ${keys.length} wallet(s) loaded.`));
  return keys;
}

async function promptQuantity(walletCount: number): Promise<number> {
  console.log(chalk.bold.white("\nQuantity"));
  const qty = await askNumber("NFTs per wallet", 1, { min: 1, max: 100 });
  if (walletCount > 1) {
    console.log(chalk.gray(`  → ${qty} × ${walletCount} wallets = ${qty * walletCount} total`));
  }
  return Math.floor(qty);
}

async function promptTarget(
  chainKey: string
): Promise<{ contract: string; label: string; chainKey: string }> {
  console.log(chalk.bold.white("\nNFT target"));
  console.log(chalk.gray("  Paste the OpenSea link (collection or item), a slug, or the contract address."));

  let activeChain = chainKey;

  for (;;) {
    const raw = await askText("NFT link");
    if (!raw) {
      console.log(chalk.red("  ✗ Paste a link, slug, or address."));
      continue;
    }

    let parsed;
    try {
      parsed = parseNftLink(raw);
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}`));
      continue;
    }

    if (parsed.chainHint && parsed.chainHint !== activeChain && resolveChain(parsed.chainHint)) {
      const hinted = resolveChain(parsed.chainHint)!;
      console.log(
        chalk.yellow(`  ⚠ This link points at ${hinted.name}, but you selected ${resolveChain(activeChain)!.name}.`)
      );
      if (await askYesNo(`Switch to ${hinted.name}?`, true)) {
        activeChain = hinted.key;
        console.log(chalk.green(`  ✓ Chain switched to ${hinted.name}`));
      }
    }

    if (parsed.kind === "address") {
      const normalized = normalizeAddress(parsed.value);
      if (!normalized) {
        console.log(chalk.red(`  ✗ "${parsed.value}" is not a 20-byte address.`));
        continue;
      }
      if (normalized.checksumWarning) {
        console.log(chalk.yellow("  ⚠ Mixed-case address whose EIP-55 checksum doesn't match — likely a typo."));
        if (!(await askYesNo("Use it anyway?", false))) continue;
      }
      console.log(chalk.green(`  ✓ Contract ${normalized.address}`));
      return { contract: normalized.address, label: shortAddr(normalized.address), chainKey: activeChain };
    }

    const apiKey = (process.env.OPENSEA_API_KEY || "").trim();

    try {
      console.log(chalk.gray(`  Resolving slug "${parsed.value}"${apiKey ? "" : " (no API key — may be refused)"}...`));
      const info = await resolveSlug(parsed.value, apiKey || undefined, activeChain);
      const resolved = normalizeAddress(info.contractAddress);
      if (!resolved) {
        console.log(chalk.red(`  ✗ Unusable address returned: ${info.contractAddress}`));
        continue;
      }
      console.log(chalk.green(`  ✓ ${info.name} → ${resolved.address}`));
      if (info.chain && resolveChain(info.chain) && info.chain !== activeChain) {
        console.log(chalk.yellow(`  ⚠ Listed on "${info.chain}", not "${activeChain}".`));
        if (await askYesNo(`Switch to ${resolveChain(info.chain)!.name}?`, true)) {
          activeChain = resolveChain(info.chain)!.key;
        }
      }
      return { contract: resolved.address, label: info.name || parsed.value, chainKey: activeChain };
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}`));
      console.log(
        chalk.gray("    Paste the contract address (0x…) instead — that always works, no key needed.")
      );
    }
  }
}

async function promptRpc(profile: ChainProfile): Promise<string[]> {
  console.log(chalk.bold.white("\nRPC endpoints"));
  console.log(chalk.gray("  A private RPC (Alchemy / QuickNode / Infura) is what wins a contested mint."));
  if (profile.rpc.alchemyHost) {
    console.log(chalk.gray(`  Paste a full URL, or just your Alchemy key → https://${profile.rpc.alchemyHost}/v2/<key>`));
  }
  console.log(chalk.gray("  Comma-separate several to blast to all of them."));

  const fromEnv = privateRpcsFromEnv(profile.key);
  if (fromEnv.length > 0) {
    console.log(chalk.gray(`  .env already has: ${fromEnv.map(maskRpc).join(", ")}`));
    console.log(chalk.gray("  Blank = keep the .env value."));
  } else {
    console.log(chalk.yellow(`  Nothing in .env for ${profile.name}. Blank = public nodes only.`));
  }

  for (;;) {
    const raw = await askText(`RPC for ${profile.name}`);
    if (!raw) return fromEnv;

    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const urls: string[] = [];
    let bad = false;
    for (const part of parts) {
      const url = toRpcUrl(part, profile.key);
      if (!url) {
        console.log(chalk.red(`  ✗ "${part}" is not a URL or a usable API key.`));
        bad = true;
        break;
      }
      urls.push(url);
    }
    if (bad || urls.length === 0) continue;

    for (const url of urls) console.log(chalk.green(`  ✓ ${maskRpc(url)}`));
    return urls;
  }
}

async function promptTiming(
  startTime: number,
  status: "not-started" | "live" | "ended"
): Promise<{ targetStart: Date | null; timingLabel: string }> {
  const startsInFuture = status === "not-started";
  const at = new Date(startTime * 1000);

  const choices: { label: string; value: "wait" | "now" | "custom"; hint?: string }[] = [];
  if (startsInFuture) {
    choices.push({
      label: "Wait for the stage (snipe at T-0)",
      value: "wait",
      hint: `${toIST(at)} IST · in ${formatRemaining(at.getTime() - Date.now())} · fires at T-0`,
    });
  } else {
    choices.push({ label: "Fire now", value: "now", hint: "stage is already live" });
  }
  choices.push({ label: "Custom time", value: "custom", hint: "HH:MM, 24-hour IST, today" });

  const pick = await askChoice("When should it fire?", choices, 0);

  if (pick === "wait") return { targetStart: at, timingLabel: `wait for stage — ${toIST(at)} IST` };
  if (pick === "now") return { targetStart: null, timingLabel: "fire immediately" };

  for (;;) {
    const raw = await askText("Time (HH:MM, 24-hour IST)");
    try {
      const custom = istTimeToDate(raw);
      if (custom.getTime() < startTime * 1000) {
        console.log(chalk.bold.red(`  ✗ That is before the stage opens (${toIST(at)} IST) — it will revert.`));
        if (!(await askYesNo("Use it anyway?", false))) continue;
      }
      return { targetStart: custom, timingLabel: `custom — ${toIST(custom)} IST` };
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}`));
    }
  }
}

async function promptMerkleProof(): Promise<string[]> {
  console.log(chalk.gray("  Paste the Merkle proof elements one per line."));
  console.log(chalk.gray("  These are hex strings (0x...) from the collection's allowlist/GTD distribution."));
  console.log(chalk.gray("  Blank line when done."));

  const proof: string[] = [];
  for (;;) {
    const raw = await askText(`  proof[${proof.length}]`);
    if (!raw) {
      if (proof.length === 0) {
        console.log(chalk.yellow("  ⚠ No proof provided. GTD mint may fail without a valid Merkle proof."));
        if (await askYesNo("Continue without proof?", false)) {
          return [];
        }
        continue;
      }
      break;
    }

    if (!/^0x[0-9a-fA-F]{64}$/.test(raw.trim())) {
      console.log(chalk.red("  ✗ Each proof element must be a 32-byte hex string (0x + 64 hex chars)."));
      continue;
    }

    proof.push(raw.trim());
    console.log(chalk.green(`  ✓ Added proof[${proof.length - 1}]`));
  }

  console.log(chalk.gray(`  ${proof.length} proof element(s) loaded.`));
  return proof;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function printDrop(mintPlan: LocalMintPlan, chainProfile: ChainProfile, quantity: number): void {
  const drop = mintPlan.drop;
  const status = stageStatus(drop);
  const startsAt = new Date(drop.startTime * 1000);
  const endsAt = new Date(drop.endTime * 1000);

  const statusText =
    status === "live"
      ? chalk.green("LIVE — open to everyone right now")
      : status === "not-started"
        ? chalk.yellow(`NOT STARTED — opens in ${formatRemaining(startsAt.getTime() - Date.now())}`)
        : chalk.red("ENDED");

  const stageLabel = mintPlan.stageType === "fcfs" ? "FCFS" : mintPlan.stageType === "gtd" ? "GTD" : "Public";

  console.log(chalk.green(`  ✓ Built ${stageLabel} calldata from on-chain SeaDrop — no OpenSea token needed`));
  console.log(chalk.green(`    Stage: ${stageLabel} — ${mintPlan.stageType === "gtd" ? "guaranteed allocation" : "first come, first served"}`));
  console.log(chalk.gray(`    Status:       ${statusText}`));
  console.log(chalk.gray(`    SeaDrop:      ${mintPlan.to} (${mintPlan.seaDropSource})`));
  console.log(chalk.gray(`    Fee recipient: ${mintPlan.feeRecipient}`));
  console.log(
    chalk.gray(
      `    Price:         ${formatEther(drop.mintPrice)} × ${quantity} = ${formatEther(mintPlan.value)} per wallet`
    )
  );
  console.log(chalk.gray(`    Max per wallet: ${drop.maxTotalMintableByWallet || "unlimited"}`));
  console.log(
    chalk.gray(
      `    Window:        ${toIST(startsAt)} → ${toIST(endsAt)} IST`
    )
  );

  if (drop.maxTotalMintableByWallet > 0 && quantity > drop.maxTotalMintableByWallet) {
    console.log(
      chalk.yellow(`  ⚠ This drop allows only ${drop.maxTotalMintableByWallet} per wallet — more will revert.`)
    );
  }
  if (status === "ended") {
    console.log(chalk.yellow(`  ⚠ This ${stageLabel} stage has already ended on-chain.`));
  }
  console.log(chalk.gray(`  Explorer: ${chainProfile.explorer}/address/${mintPlan.to}`));
}

function normalizeAddress(raw: string): { address: string; checksumWarning: boolean } | null {
  const value = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  const body = value.slice(2);
  const mixedCase = /[a-f]/.test(body) && /[A-F]/.test(body);
  return {
    address: getAddress(value.toLowerCase()),
    checksumWarning: mixedCase && !isAddress(value),
  };
}

async function currentBaseFeeGwei(provider: JsonRpcProvider): Promise<number | null> {
  try {
    const fee = await provider.getFeeData();
    const wei = fee.gasPrice ?? fee.maxFeePerGas;
    return wei === null || wei === undefined ? null : Number(wei) / 1e9;
  } catch {
    return null;
  }
}

function gweiToWei(gwei: number): bigint {
  return BigInt(Math.round(gwei * 1e9));
}

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function labelOf(url: string): string {
  return parseRpcEndpoints([url])[0].label;
}

function line(label: string, value: string): void {
  console.log(`  ${chalk.gray(label.padEnd(10))} ${chalk.white(value)}`);
}

function printBanner(): void {
  console.log(
    chalk.bold.cyan(`\n╔═══════════════════════════════════════╗\n║            S I R B O T                 ║\n║   FCFS · Public · GTD · no OpenSea     ║\n╚═══════════════════════════════════════╝`)
  );
  console.log(chalk.gray("  NFT mint sniper for ETH, Base & Robinchain. Ctrl+C to quit.\n"));
}
