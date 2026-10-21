# Security Policy

Gandiva runs on the Base Sepolia **testnet**. Its USDC has no real value, but the code is written to handle payments safely, so payment-logic bugs are taken as seriously as they would be with real money.

## Reporting a vulnerability

Report privately through [GitHub's private vulnerability reporting](https://github.com/ChinmayNakwa/gandiva/security/advisories/new). Please don't open a public issue for a security problem.

Include what the problem is, how to reproduce it, and what an attacker gains. Gandiva has one maintainer and no paid bounty; expect a first reply within about a week.

**Testing rules:** run the project locally for anything heavy (`README.md` has the setup). Against the live site, don't run load or denial-of-service tests, don't scan for hosts, and don't touch wallets or data that aren't yours.

**In scope:** the API in `src/`, the UI in `client/`, `contracts/SellerStakeV2.sol`, and the deployment files.
**Out of scope:** the sellers that misbehave on purpose (`cheap-scraper`, `mirror-scraper`, `junk-fx`, `promo-scraper`), which exist to show the buyer's defences working, and bugs in third-party services.

## Threat model

### What is worth protecting

| Asset | Where it lives | If it leaks |
|---|---|---|
| Hot wallet keys (`BUYER_PRIVATE_KEY`, `RELAYER_PRIVATE_KEY`, `SERVER_VERIFIER_KEY`, `RECEIPT_SIGNER_KEY`) | Server environment | That wallet's funds, or one of the signatures it provides |
| `SECRETS_KEY` | Server environment | Decrypts every stored secret, once combined with a copy of the database |
| Agent wallet keys and sellers' API keys | SQLite, AES-256-GCM encrypted | Useless without `SECRETS_KEY` |
| Sessions | SQLite, only a SHA-256 hash of the token, 7-day expiry | A stolen cookie acts as that user until it expires or they log out |
| Database backups | Private S3-compatible bucket (Litestream) | The whole database, with secrets still encrypted |

### Trust boundaries

```
browser -> Vercel UI proxy -> Render API -> sellers (third-party, untrusted)
                                         -> x402 facilitator, Base Sepolia RPC
                                         -> LLM (its output is untrusted)
```

- **Browser to API:** anyone can call the API directly. Sign-in is a wallet signature; signed-in writes must come from the site's own origin.
- **Vercel to Render:** the proxy names the visitor's IP behind a shared `PROXY_SECRET`. Without that secret, the header is ignored.
- **API to sellers:** a seller's 402 must match its registry listing (price, token, network, payTo) before anything is signed. Seller endpoints are checked against private-network addresses, and every seller response is treated as hostile input.
- **LLM to payments:** the LLM can't direct a payment. Output that gives orders to an AI is rejected before the planner reads it.

`README.md` ("Payment Safety") lists the protections on the buyer's side.

## Known limits

- **Testnet only, unaudited.** `SellerStakeV2.sol` has had no third-party audit. Don't use this code or contract with real funds, and never put mainnet keys in `.env`.
- **One server instance.** The spend cap's in-flight reservations and the rate limit counters live in memory, so they only hold while a single instance runs.
- **Work happens before settlement.** A seller validates its own output and then settles. A buyer whose payment fails at settlement has had that seller's work done for nothing, though no output is returned and no money moves.
- **Hot keys sit in the server environment.** There is no hardware or cloud key management; the deployment uses free tiers.
- **The UI's content security policy allows inline scripts,** because Next.js needs them without nonces. It is defence in depth, not a complete XSS stop.
- **Anonymous runs are readable by id.** Runs started without signing in have short ids that also appear in the public ledger. Signed-in users' runs are private to them.
- **Backups can lag.** A hard crash can lose the last second or two of writes, including recent ledger entries.
