import "dotenv/config";
import type { Network } from "@x402/core/types";

export const NETWORK: Network = "eip155:84532";
export const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const USDC_DECIMALS = 6;
export const USDC_EIP712 = { name: "USDC", version: "2" } as const;
export const EXPLORER_TX = "https://sepolia.basescan.org/tx/";
export const MAX_PRICE_UNITS = 100_000n; // 0.10 USDC, the per-call cap from the rules

const env = (key: string, fallback = "") => (process.env[key] ?? fallback).trim();

export const config = {
  port: Number(env("PORT", "4021")),
  get publicBaseUrl() {
    return env("PUBLIC_BASE_URL") || `http://localhost:${this.port}`;
  },
  // May listings point at private/loopback addresses? "auto" = only while this registry itself runs on localhost.
  get allowPrivateEndpoints() {
    const v = env("ALLOW_PRIVATE_ENDPOINTS", "auto").toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
    const host = new URL(this.publicBaseUrl).hostname;
    return host === "localhost" || host.startsWith("127.") || host === "[::1]";
  },
  // The UI's own addresses: a wallet sign-in message naming any other site is refused, so a phishing page cannot reuse one.
  get siteOrigins() {
    return env("SITE_ORIGINS", "http://localhost:3000,http://localhost:3001,https://gandiva-navy.vercel.app")
      .split(",")
      .map((o) => o.trim().replace(/\/$/, ""))
      .filter(Boolean);
  },
  // Shared with the UI's proxy (client/proxy.ts) so its visitor-IP header can be trusted; unset = never trusted.
  get proxySecret() {
    return env("PROXY_SECRET");
  },
  facilitatorUrl: env("FACILITATOR_URL", "https://x402.org/facilitator"),
  rpcUrl: env("BASE_SEPOLIA_RPC", "https://sepolia.base.org"),
  buyerPrivateKey: env("BUYER_PRIVATE_KEY") as `0x${string}` | "",
  buyerToken: env("BUYER_TOKEN"),
  adminToken: env("ADMIN_TOKEN"),
  // 64 hex characters (32 bytes). Encrypts secrets stored in the database: sellers' API keys and per-user agent wallet keys.
  secretsKey: env("SECRETS_KEY"),
  // Wallet-wide spend cap across all runs; SPEND_CAP_USDC=0 turns it off.
  spendCap: {
    limit: toUnits(env("SPEND_CAP_USDC", "0.5")),
    windowMs: Number(env("SPEND_CAP_WINDOW_MIN", "60")) * 60_000,
  },
  // Reputation: a call's weight halves every REPUTATION_HALF_LIFE_HOURS; fewer than REPUTATION_NEW_ATTEMPTS calls = "new".
  reputation: {
    halfLifeMs: Number(env("REPUTATION_HALF_LIFE_HOURS", "6")) * 3_600_000,
    newAttempts: Number(env("REPUTATION_NEW_ATTEMPTS", "3")),
  },
  // SELLER_PROCESSES=on runs every built-in seller as its own process (own port, own SQLite file) behind the same public URLs.
  sellerProcesses: env("SELLER_PROCESSES", "off").toLowerCase() === "on",
  sellerBasePort: Number(env("SELLER_BASE_PORT", "4100")),
  seedAdversarial: env("SEED_ADVERSARIAL", "true") !== "false",
  ollama: {
    host: env("OLLAMA_HOST", "http://127.0.0.1:11434").replace(/\/$/, ""),
    model: env("OLLAMA_MODEL", "qwen2.5:7b"),
    apiKey: env("OLLAMA_API_KEY"),
  },
  payTo: {
    shelfScraper: env("PAYTO_SHELF_SCRAPER"),
    cheapScraper: env("PAYTO_CHEAP_SCRAPER"),
    fxRates: env("PAYTO_FX_RATES"),
    hindiSummary: env("PAYTO_HINDI_SUMMARY"),
    cityInfo: env("PAYTO_CITY_INFO"),
    sentiment: env("PAYTO_SENTIMENT"),
    junkFx: env("PAYTO_JUNK_FX"),
    mirrorScraper: env("PAYTO_MIRROR_SCRAPER"),
    promoScraper: env("PAYTO_PROMO_SCRAPER"),
    attacker: env("PAYTO_ATTACKER"),
    travelBrief: env("PAYTO_TRAVEL_BRIEF"),
  },
  // The agent-chain seller pays the sellers it hires from this wallet (testnet only).
  travelBriefKey: env("TRAVEL_BRIEF_KEY") as `0x${string}` | "",
  // SellerStakeV2: sellers stake USDC; a slash needs 2 of 3 verifier signatures, is capped at 0.10 USDC and waits 30 min.
  stake: {
    contract: env("STAKE_CONTRACT") as `0x${string}` | "",
    // Pays the gas for relayed stakes, claims and refunds. It has no powers over bonds; keep ~0.01 Base Sepolia ETH on it.
    relayerKey: env("RELAYER_PRIVATE_KEY") as `0x${string}` | "",
    // Above this gas price the relayer stops sending seller actions. A full seller cycle (372k gas) uses up its 0.02 USDC fee
    // at about 0.024 gwei with ETH at $2,240, see docs/STAKE.md. Refunds still go.
    relayMaxGwei: env("RELAY_MAX_GWEI", "0.02"),
    // This server's own verifier, one of the three; the other two run elsewhere (scripts/verifier.ts).
    verifierKey: env("SERVER_VERIFIER_KEY") as `0x${string}` | "",
    // Signs the X-Gandiva-Receipt the built-in sellers attach to paid responses (evidence for stake claims). Holds no money.
    receiptSignerKey: env("RECEIPT_SIGNER_KEY") as `0x${string}` | "",
  },
};

// A function declaration (not a const) so `config` above can use it while the module is still evaluating.
export function toUnits(usdc: number | string): bigint {
  const [whole, frac = ""] = String(usdc).split(".");
  return BigInt(whole || "0") * 10n ** BigInt(USDC_DECIMALS) + BigInt((frac + "000000").slice(0, USDC_DECIMALS) || "0");
}

export const fromUnits = (units: bigint | string | number): string => {
  const u = BigInt(units);
  const whole = u / 10n ** BigInt(USDC_DECIMALS);
  const frac = (u % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, "0");
  return `${whole}.${frac}`;
};
