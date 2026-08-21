# SIRBOT — NFT Mint Sniper

A terminal CLI for sniping **FCFS**, **Public**, and **GTD** (Guaranteed Total Distribution) NFT mints on OpenSea SeaDrop, across Ethereum, Base, and Robinchain.

It builds the mint transaction from **on-chain data only** — price, fee recipient and per-wallet limit all come straight from the SeaDrop contract. That means:

- **No OpenSea account, login, or access token.**
- **No API rate limits** to lose a mint to.
- **Faster.** Every transaction is signed and serialised *before* the stage opens, so at the exact start time the only work left is writing bytes to the network.

Multi-wallet: paste as many keys as you like and they all fire in parallel.

---

## Supported Mint Types

| Type | Description |
|---|---|
| **FCFS** | First Come, First Served — the open public sale at the end of every drop |
| **Public** | Standard public mint stage — unsigned, open to anyone |
| **GTD** | Guaranteed Total Distribution — guaranteed allocation for specific wallets |

## Requirements

- **Node.js 18 or newer** — check with `node --version`. Get it from [nodejs.org](https://nodejs.org) if you don't have it.
- A wallet with some ETH on the chain you're minting on.

---

## Step 1 — Install

Run these **one line at a time**, pressing Enter after each:

```bash
git clone https://github.com/SIRIBRAHEEM/sirbot.git
cd sirbot
npm install
npm run build
```

Then confirm the build worked:

```bash
npm start -- --help
```

## Step 2 — Configure (optional but recommended)

```bash
cp .env.example .env
```

Open `.env` and add a private RPC URL for the chain you'll mint on:

```
RPC_URL_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
```

A free [Alchemy](https://alchemy.com) key takes two minutes and is the single biggest factor in whether you win a contested mint. You can also paste it at the prompt instead — the tool works without any `.env` at all, falling back to public nodes.

> **Never put private keys in `.env`.** You paste them into the CLI at run time. They're held in memory for that run only and never written to disk.

## Step 3 — Run it

```bash
npm start
```

The wizard asks you several things:

| Step | What it wants |
|---|---|
| **1. Private keys** | Paste one per line, hidden as you type. Blank line to finish. Each key is confirmed back to you by its wallet address. |
| **2. Chain** | Ethereum, Base, or Robinchain. |
| **3. Mint type** | FCFS, Public, or GTD. |
| **4. Quantity** | How many NFTs **per wallet**. |
| **5. NFT link** | An OpenSea collection link, an item link, a slug, or the raw `0x` contract address. |
| **6. RPC** | Paste a full URL, or just your Alchemy key. Blank uses `.env`, or public nodes. |
| **7. Gas** | Ceiling and tip. The live base fee is shown right above the prompt. |
| **8. Timing** | Wait for the stage to open, or fire now if it's already live. |

Then it shows a summary and asks `Fire?`. **Nothing is sent until you type `y`.**

---

## Supported Chains

| Chain | Chain ID | Explorer |
|---|---|---|
| Ethereum | 1 | etherscan.io |
| Base | 8453 | basescan.org |
| Robinchain | 4663 | robinchain.blockscout.com |

---

## Understanding gas

| Term | What it is | Who sets it |
|---|---|---|
| **Base fee** | The network's price. Burned. | The chain |
| **Priority fee** (tip) | Paid on top, to the block producer | You |
| **Max fee** | The ceiling you'll tolerate | You |

You pay **base fee + tip**. The max fee is only a cap — but before a node accepts your transaction, it checks that your wallet holds `gasLimit × maxFee + mint price`.

---

## What it protects you from

Each of these is checked *before* anything is broadcast:

- **Ceiling below the base fee** — rejected by every node
- **Tip above the ceiling** — invalid under EIP-1559
- **Wallet can't cover the upfront reservation** — refuses to fire
- **Wrong network** — every RPC is checked for its chain ID
- **Quantity above the per-wallet cap** — warned before you fire

---

## Security

- Private keys are pasted at run time, kept in memory, and **never written to disk or transmitted anywhere** except as a locally-signed transaction.
- `.env`, `wallets/` and `*.key` are all git-ignored.
- Use dedicated hot wallets funded with only what you intend to spend.

---

## CLI Flags

```bash
npm start                          run the interactive wizard
npm start -- check <address>       inspect a collection's stage (no keys needed)
npm start -- check <address> --chain base
npm start -- --help                show help message
```

---

## License

MIT
