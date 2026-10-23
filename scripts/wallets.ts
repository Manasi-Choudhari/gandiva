import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Creates fresh TESTNET wallets in .env (gitignored). Existing values are kept. Only addresses are printed.
const ENV = ".env";
let text = existsSync(ENV) ? readFileSync(ENV, "utf8") : readFileSync(".env.example", "utf8");

const get = (k: string) => text.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
const set = (k: string, v: string) => {
  text = new RegExp(`^${k}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : `${text.trimEnd()}\n${k}=${v}\n`;
};

const rows: [string, string][] = [];

if (!get("BUYER_PRIVATE_KEY")) set("BUYER_PRIVATE_KEY", generatePrivateKey());
rows.push(["buyer (Scout)", privateKeyToAccount(get("BUYER_PRIVATE_KEY") as `0x${string}`).address]);

const sellers = ["SHELF_SCRAPER", "CHEAP_SCRAPER", "FX_RATES", "HINDI_SUMMARY", "CITY_INFO", "SENTIMENT", "JUNK_FX", "MIRROR_SCRAPER", "ATTACKER", "PROMO_SCRAPER"];
for (const s of sellers) {
  // Seller keys are stored only so the testnet USDC they earn can be moved later; the server never loads them.
  if (!get(`SELLER_KEY_${s}`)) set(`SELLER_KEY_${s}`, generatePrivateKey());
  const addr = privateKeyToAccount(get(`SELLER_KEY_${s}`) as `0x${string}`).address;
  set(`PAYTO_${s}`, addr);
  rows.push([s.toLowerCase().replace(/_/g, "-"), addr]);
}

// The agent-chain seller pays other sellers, so its key is loaded by the server (unlike the receive-only seller keys above).
if (!get("TRAVEL_BRIEF_KEY")) set("TRAVEL_BRIEF_KEY", generatePrivateKey());
const briefAddr = privateKeyToAccount(get("TRAVEL_BRIEF_KEY") as `0x${string}`).address;
set("PAYTO_TRAVEL_BRIEF", briefAddr);
rows.push(["travel-brief", briefAddr]);

// The stake relayer pays the gas for stakes, claims and refunds; it has no other powers. It takes
// over the old arbiter key, so the ETH already on that address keeps working.
if (!get("RELAYER_PRIVATE_KEY")) set("RELAYER_PRIVATE_KEY", get("ARBITER_PRIVATE_KEY") || generatePrivateKey());
const relayerAddr = privateKeyToAccount(get("RELAYER_PRIVATE_KEY") as `0x${string}`).address;
rows.push(["stake relayer", relayerAddr]);

// Two of the three SellerStakeV2 verifiers, so a local server plus `npm run verifier` can pass a claim. In production each
// verifier key lives on its own host (Render, GitHub Actions, your machine).
for (const [k, label] of [["SERVER_VERIFIER_KEY", "server verifier"], ["VERIFIER_KEY", "local verifier"]] as const) {
  if (!get(k)) set(k, generatePrivateKey());
  rows.push([label, privateKeyToAccount(get(k) as `0x${string}`).address]);
}

// Signs the receipts the built-in sellers attach to paid responses (evidence for stake claims). Holds no money.
if (!get("RECEIPT_SIGNER_KEY")) set("RECEIPT_SIGNER_KEY", generatePrivateKey());
rows.push(["receipt signer", privateKeyToAccount(get("RECEIPT_SIGNER_KEY") as `0x${string}`).address]);

writeFileSync(ENV, text);
console.log("Testnet wallets (Base Sepolia). Keys are in .env, which is gitignored.\n");
for (const [name, addr] of rows) console.log(`  ${name.padEnd(16)} ${addr}`);
console.log(`\nFund the buyer with testnet USDC: https://faucet.circle.com  (network: Base Sepolia, address: ${rows[0][1]})`);
console.log("No ETH is needed: the x402 facilitator pays gas for EIP-3009 transfers.");
console.log(`The travel-brief seller hires other sellers and pays them first, so it also needs a little USDC float: ${briefAddr}`);
console.log(`The stake relayer pays gas for SellerStakeV2, so it needs a little Base Sepolia ETH (about 0.01): ${relayerAddr}`);
