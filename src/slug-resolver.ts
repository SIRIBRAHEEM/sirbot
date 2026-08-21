// Turn an OpenSea collection slug into a contract address.
//
// The API key is optional. OpenSea's public collections endpoint often answers
// unauthenticated, so we always attempt the lookup.

interface CollectionInfo {
  name: string;
  contractAddress: string;
  chain: string;
}

export async function resolveSlug(
  slug: string,
  apiKey?: string,
  preferredChain?: string
): Promise<CollectionInfo> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

  const res = await fetch(`https://api.opensea.io/api/v2/collections/${slug}`, { headers });

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      apiKey
        ? `OpenSea rejected the API key (${res.status}) — check OPENSEA_API_KEY.`
        : `OpenSea refused the lookup (${res.status}) — the slug may be misspelled, or it wants an API key.`
    );
  }
  if (res.status === 404) {
    throw new Error(`No OpenSea collection called "${slug}".`);
  }
  if (res.status === 429) {
    throw new Error("OpenSea rate-limited the lookup — retry shortly.");
  }
  if (!res.ok) {
    throw new Error(`Could not resolve "${slug}": ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as any;

  const contracts = json.contracts;
  if (!contracts || contracts.length === 0) {
    throw new Error(`No contracts listed for "${slug}".`);
  }

  // Prefer the contract on the chain we're actually minting on
  const wanted = preferredChain?.trim().toLowerCase();
  const picked =
    (wanted && contracts.find((c: any) => c.chain?.toLowerCase() === wanted)) || contracts[0];

  return {
    name: json.name || slug,
    contractAddress: picked.address,
    chain: picked.chain,
  };
}

// A slug is anything that isn't a raw contract address.
export function isSlug(input: string): boolean {
  return !input.startsWith("0x");
}
