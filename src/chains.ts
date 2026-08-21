// Chain registry — everything chain-specific lives here so adding a new
// network is a single entry instead of hunting for hardcoded values.
//
// `key` is the identifier used in three places, and they must match:
//   1. the OpenSea GraphQL `chain` field
//   2. the `--chain` CLI option
//   3. the `CHAIN` env var

export interface ChainProfile {
  key: string;          // --chain value + CHAIN env value
  chainId: number;      // EVM network chain id
  name: string;         // human label
  explorer: string;     // block explorer base URL, NO trailing slash
  nativeSymbol: string;
  rpc: {
    alchemyHost?: string; // Alchemy host for this network
    public: string[];     // public RPC + sequencer endpoints
  };
}

export const CHAINS: ChainProfile[] = [
  {
    key: "ethereum",
    chainId: 1,
    name: "Ethereum",
    explorer: "https://etherscan.io",
    nativeSymbol: "ETH",
    rpc: {
      alchemyHost: "eth-mainnet.g.alchemy.com",
      public: [
        "https://ethereum-rpc.publicnode.com",
        "https://eth.merkle.io",
        "https://cloudflare-eth.com",
      ],
    },
  },
  {
    key: "base",
    chainId: 8453,
    name: "Base",
    explorer: "https://basescan.org",
    nativeSymbol: "ETH",
    rpc: {
      alchemyHost: "base-mainnet.g.alchemy.com",
      public: [
        "https://mainnet.base.org",
        "https://base-rpc.publicnode.com",
        "https://mainnet-sequencer.base.org",
      ],
    },
  },
  {
    key: "robinchain",
    chainId: 4663,
    name: "Robinchain",
    explorer: "https://robinchain.blockscout.com",
    nativeSymbol: "ETH",
    rpc: {
      alchemyHost: "robinchain-mainnet.g.alchemy.com",
      public: [
        "https://rpc.mainnet.chain.robinhood.com",
        "https://sequencer.mainnet.chain.robinhood.com",
      ],
    },
  },
];

const DEFAULT_EXPLORER = "https://basescan.org";

// Resolve a chain by its numeric chainId or by its string key.
export function resolveChain(
  idOrKey: string | number | bigint | null | undefined
): ChainProfile | undefined {
  if (idOrKey === null || idOrKey === undefined) return undefined;
  if (typeof idOrKey === "string") {
    const key = idOrKey.trim().toLowerCase();
    return CHAINS.find((c) => c.key === key);
  }
  const id = Number(idOrKey);
  return CHAINS.find((c) => c.chainId === id);
}

// Build a block-explorer tx URL for whatever chain we're on.
export function explorerTx(
  idOrKey: string | number | bigint | null | undefined,
  txHash: string
): string {
  const profile = resolveChain(idOrKey);
  const base = profile?.explorer ?? DEFAULT_EXPLORER;
  return `${base}/tx/${txHash}`;
}
