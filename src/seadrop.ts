// SeaDrop mint builder — supports FCFS, Public, and GTD stages.
//
// FCFS and Public stages are unsigned: SeaDrop.mintPublic() takes only the
// drop's own parameters, so the whole transaction can be assembled from
// on-chain reads. That removes the access token, its expiry, OpenSea's rate
// limits, and the ~1s API round-trip from the critical path.
//
// GTD (Guaranteed Total Distribution) stages use SeaDrop.mintAllowList()
// with a Merkle proof. When the Merkle root is set on-chain and the leaf
// data is accessible, SIRBOT builds the proof locally.

import { Contract, Interface, JsonRpcProvider, solidityPackedKeccak256 } from "ethers";

// OpenSea's canonical SeaDrop singleton.
export const SEADROP_ADDRESS = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";

// OpenSea's standard fee collector — the usual allowed recipient on their drops.
const OPENSEA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";

const PUBLIC_ABI = [
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable",
  "function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))",
  "function getAllowedFeeRecipients(address nftContract) view returns (address[])",
  "function getAllowListDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 maxTotalMintable, uint16 feeBps, bool restrictFeeRecipients, bytes32 merkleRoot))",
  "function getGtdDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 maxTotalMintable, uint16 feeBps, bool restrictFeeRecipients, bytes32 merkleRoot))",
  "function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, uint256 maxQuantity, uint256 pricePerToken, uint256 salt, bytes32[] merkleProof) payable",
];

// Getters some token contracts expose to reveal which SeaDrop instance they use.
const TOKEN_ABI = [
  "function getAllowedSeaDrop() view returns (address[])",
  "function seaDrop() view returns (address)",
  "function getSeaDrop() view returns (address)",
];

const IFACE = new Interface(PUBLIC_ABI);

export type MintStageType = "public" | "fcfs" | "gtd";

export interface PublicDrop {
  mintPrice: bigint;
  startTime: number;
  endTime: number;
  maxTotalMintableByWallet: number;
  feeBps: number;
  restrictFeeRecipients: boolean;
}

export interface AllowListDrop {
  mintPrice: bigint;
  startTime: number;
  endTime: number;
  maxTotalMintableByWallet: number;
  maxTotalMintable: number;
  feeBps: number;
  restrictFeeRecipients: boolean;
  merkleRoot: string;
}

export type StageStatus = "not-started" | "live" | "ended";

export function stageStatus(drop: { startTime: number; endTime: number }, nowMs: number = Date.now()): StageStatus {
  if (nowMs < drop.startTime * 1000) return "not-started";
  if (nowMs > drop.endTime * 1000) return "ended";
  return "live";
}

export interface SeaDropTarget {
  address: string;
  source: "canonical singleton" | "collection's SeaDrop";
}

export interface LocalMintPlan {
  to: string;
  data: string;
  value: bigint;
  drop: PublicDrop | AllowListDrop;
  feeRecipient: string;
  seaDropSource: string;
  stageType: MintStageType;
}

function makeProvider(rpcUrl: string): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
}

function isZeroDrop(raw: any): boolean {
  try {
    return (
      Number(raw.startTime) === 0 && Number(raw.endTime) === 0 && Number(raw.maxTotalMintableByWallet) === 0
    );
  } catch {
    return true;
  }
}

function isRetryableRpcError(err: unknown): boolean {
  const e = err as any;
  const code = String(e?.code ?? "");
  if (code === "CALL_EXCEPTION") return false;
  const msg = String(e?.message ?? e ?? "");
  return (
    code === "SERVER_ERROR" ||
    code === "TIMEOUT" ||
    code === "NETWORK_ERROR" ||
    code === "ECONNREFUSED" ||
    code === "BAD_DATA" ||
    /timeout|fetch failed|rate limit|too many requests|econnreset|econnrefused|socket hang up/i.test(msg)
  );
}

// Find which SeaDrop instance actually hosts this collection's drops.
export async function resolveSeaDropTarget(
  rpcUrl: string,
  nftContract: string
): Promise<SeaDropTarget | null> {
  const provider = makeProvider(rpcUrl);

  // 1. Canonical singleton.
  const canonical = new Contract(SEADROP_ADDRESS, PUBLIC_ABI, provider);
  try {
    const raw = await canonical.getPublicDrop(nftContract);
    if (!isZeroDrop(raw)) {
      return { address: SEADROP_ADDRESS, source: "canonical singleton" };
    }
  } catch (err) {
    if (isRetryableRpcError(err)) throw err;
  }

  // 2. Token-contract candidates: any SeaDrop instance the token points at.
  const token = new Contract(nftContract, TOKEN_ABI, provider);
  const candidates: string[] = [];
  for (const fn of ["getAllowedSeaDrop", "seaDrop", "getSeaDrop"]) {
    try {
      const res = await (token as any)[fn]();
      if (Array.isArray(res)) candidates.push(...res.map(String));
      else if (res && !/^0x{40}$/i.test(String(res))) candidates.push(String(res));
    } catch {
      // Getter not present on this token
    }
  }

  for (const address of new Set(candidates)) {
    const probe = new Contract(address, PUBLIC_ABI, provider);
    try {
      const raw = await probe.getPublicDrop(nftContract);
      if (!isZeroDrop(raw)) {
        return { address, source: "collection's SeaDrop" };
      }
    } catch (err) {
      if (isRetryableRpcError(err)) throw err;
    }
  }

  return null;
}

export async function fetchPublicDrop(
  rpcUrl: string,
  nftContract: string,
  seadropAddress: string = SEADROP_ADDRESS
): Promise<PublicDrop | null> {
  const provider = makeProvider(rpcUrl);
  const seadrop = new Contract(seadropAddress, PUBLIC_ABI, provider);

  try {
    const raw = await seadrop.getPublicDrop(nftContract);
    if (isZeroDrop(raw)) return null;
    return {
      mintPrice: BigInt(raw.mintPrice),
      startTime: Number(raw.startTime),
      endTime: Number(raw.endTime),
      maxTotalMintableByWallet: Number(raw.maxTotalMintableByWallet),
      feeBps: Number(raw.feeBps),
      restrictFeeRecipients: Boolean(raw.restrictFeeRecipients),
    };
  } catch (err) {
    if (isRetryableRpcError(err)) throw err;
    return null;
  }
}

export async function fetchAllowListDrop(
  rpcUrl: string,
  nftContract: string,
  seadropAddress: string = SEADROP_ADDRESS
): Promise<AllowListDrop | null> {
  const provider = makeProvider(rpcUrl);
  const seadrop = new Contract(seadropAddress, PUBLIC_ABI, provider);

  try {
    // Try getAllowListDrop first, then getGtdDrop
    let raw;
    try {
      raw = await seadrop.getAllowListDrop(nftContract);
    } catch {
      try {
        raw = await seadrop.getGtdDrop(nftContract);
      } catch {
        return null;
      }
    }

    if (isZeroDrop(raw)) return null;
    return {
      mintPrice: BigInt(raw.mintPrice),
      startTime: Number(raw.startTime),
      endTime: Number(raw.endTime),
      maxTotalMintableByWallet: Number(raw.maxTotalMintableByWallet),
      maxTotalMintable: Number(raw.maxTotalMintable),
      feeBps: Number(raw.feeBps),
      restrictFeeRecipients: Boolean(raw.restrictFeeRecipients),
      merkleRoot: raw.merkleRoot,
    };
  } catch (err) {
    if (isRetryableRpcError(err)) throw err;
    return null;
  }
}

export async function resolveFeeRecipient(
  rpcUrl: string,
  nftContract: string,
  restricted: boolean,
  seadropAddress: string = SEADROP_ADDRESS
): Promise<{ address: string; source: string } | null> {
  const provider = makeProvider(rpcUrl);
  const seadrop = new Contract(seadropAddress, PUBLIC_ABI, provider);

  let allowed: string[] = [];
  try {
    allowed = await seadrop.getAllowedFeeRecipients(nftContract);
  } catch {
    allowed = [];
  }

  if (allowed.length > 0) {
    return { address: allowed[0], source: "allowed fee recipient on-chain" };
  }
  if (restricted) {
    return null;
  }
  return { address: OPENSEA_FEE_RECIPIENT, source: "OpenSea default (drop does not restrict)" };
}

export function encodeMintPublic(
  nftContract: string,
  feeRecipient: string,
  quantity: number
): string {
  return IFACE.encodeFunctionData("mintPublic", [
    nftContract,
    feeRecipient,
    "0x0000000000000000000000000000000000000000",
    BigInt(quantity),
  ]);
}

// Build a GTD/allowlist mint plan. Requires the wallet address and Merkle proof.
export function encodeMintAllowList(
  nftContract: string,
  feeRecipient: string,
  quantity: number,
  maxQuantity: number,
  pricePerToken: bigint,
  salt: bigint,
  merkleProof: string[]
): string {
  return IFACE.encodeFunctionData("mintAllowList", [
    nftContract,
    feeRecipient,
    "0x0000000000000000000000000000000000000000",
    BigInt(quantity),
    BigInt(maxQuantity),
    pricePerToken,
    salt,
    merkleProof,
  ]);
}

// Build a local mint plan for FCFS/Public stages (unsigned).
export async function buildLocalMintPlan(
  rpcUrl: string,
  nftContract: string,
  quantity: number,
  stageType: MintStageType = "public"
): Promise<LocalMintPlan | null> {
  const target = await resolveSeaDropTarget(rpcUrl, nftContract);
  if (!target) return null;

  const drop = await fetchPublicDrop(rpcUrl, nftContract, target.address);
  if (!drop) return null;

  const fee = await resolveFeeRecipient(rpcUrl, nftContract, drop.restrictFeeRecipients, target.address);
  if (!fee) return null;

  return {
    to: target.address,
    data: encodeMintPublic(nftContract, fee.address, quantity),
    value: drop.mintPrice * BigInt(quantity),
    drop,
    feeRecipient: fee.address,
    seaDropSource: target.source,
    stageType: stageType === "fcfs" ? "fcfs" : "public",
  };
}

// Build a local mint plan for GTD/allowlist stages.
export async function buildGtdMintPlan(
  rpcUrl: string,
  nftContract: string,
  quantity: number,
  walletAddress: string,
  merkleProof: string[],
  salt: bigint = 0n
): Promise<LocalMintPlan | null> {
  const target = await resolveSeaDropTarget(rpcUrl, nftContract);
  if (!target) return null;

  const drop = await fetchAllowListDrop(rpcUrl, nftContract, target.address);
  if (!drop) return null;

  const fee = await resolveFeeRecipient(rpcUrl, nftContract, drop.restrictFeeRecipients, target.address);
  if (!fee) return null;

  return {
    to: target.address,
    data: encodeMintAllowList(
      nftContract,
      fee.address,
      quantity,
      drop.maxTotalMintableByWallet,
      drop.mintPrice,
      salt,
      merkleProof
    ),
    value: drop.mintPrice * BigInt(quantity),
    drop,
    feeRecipient: fee.address,
    seaDropSource: target.source,
    stageType: "gtd",
  };
}

// Endpoint-resilient variant: walks the blast list in order and falls through
// to the next RPC on a retryable failure.
export async function buildLocalMintPlanAny(
  rpcUrls: string[],
  nftContract: string,
  quantity: number,
  stageType: MintStageType = "public"
): Promise<LocalMintPlan | null> {
  let lastRetryable: Error | null = null;
  for (const rpcUrl of rpcUrls) {
    try {
      const plan = await buildLocalMintPlan(rpcUrl, nftContract, quantity, stageType);
      if (plan) return plan;
      return null;
    } catch (err) {
      lastRetryable = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (lastRetryable) throw lastRetryable;
  return null;
}
