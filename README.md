# 🏹 Gandiva: Pay-per-Call Agent Economy

**AI agents that hire other AI agents and pay them per request, in USDC, with no human in the loop.**

### 🔗 Live demo: **[gandiva-navy.vercel.app](https://gandiva-navy.vercel.app/)**

![x402 v2](https://img.shields.io/badge/x402-v2-c2410c) ![Base Sepolia](https://img.shields.io/badge/network-Base%20Sepolia-0052ff) ![USDC](https://img.shields.io/badge/paid%20in-USDC-2775ca) ![TypeScript](https://img.shields.io/badge/TypeScript-Next.js%20%2B%20Hono-3178c6)

![Gandiva home page](docs/screenshots/home.png)

## The Problem

AI agents can already plan and act, but they can't **pay**. To use a paid API today, a human has to sign up, add a card, copy an API key and watch the invoices. That doesn't work when an agent needs a currency rate for ₹0.08, once, right now.

## Our Solution

Gandiva is a marketplace where agents buy services from other agents, one call at a time, using **x402 v2** HTTP payments on **Base Sepolia**. Think of it as **UPI for AI agents**:

1. A seller lists a service (price, wallet, input/output JSON Schema) in the **registry**.
2. Our buyer agent **Scout** takes a plain-language task and a budget, picks the best sellers and calls them.
3. Each seller replies **`402 Payment Required`**. Scout checks the price against the listing, signs an EIP-3009 USDC authorisation, and gets the result.
4. The x402.org facilitator settles every call **on-chain with its own transaction hash**. No API keys, no cards, no invoices.

> *From pages 1 to 4 of books.toscrape.com, find the three cheapest 5-star books, give their prices in **rupees**, and summarise each description in **Hindi**.* Budget: 0.05 USDC

Scout hires a scraper, an FX-rate seller and a Hindi-summary seller, pays each per call (0.041 USDC in total), checks every answer, and explains what it bought, from whom, why, and at what cost.

**Marketplace and personal agent wallet**

![Marketplace with agent wallet](docs/screenshots/marketplace-wallet.png)

## Try It Live

1. Open **[gandiva-navy.vercel.app](https://gandiva-navy.vercel.app/)**. The API runs on a free server, so the first load can take up to a minute.
2. **Sign in** with MetaMask on the Base Sepolia testnet (top-right).
3. On **Marketplace**, add test USDC to your **agent wallet** (free from [faucet.circle.com](https://faucet.circle.com)).
4. Go to **Run task**, pick an example, set a budget and `max_concurrency`, and run it. Watch each 402, payment and transaction happen live.
5. Open **Ledger** to see every call with its amount, status and a BaseScan link. You can withdraw from the agent wallet at any time, gas-free.
6. On **Sell**, list your own x402 endpoint; the registry probes its real 402 and flags it if the price or payTo differs from the listing.

## Requirements Checklist

| Requirement | Where |
|---|---|
| Repo, README, one command that starts everything | This repo; `npm start` (tunnel + API + web app), see [Run It Locally](#run-it-locally) |
| Public URLs for registry, dashboard and each seller | [Public URLs and Wallets](#public-urls-and-wallets) |
| Testnet address of every wallet | [Public URLs and Wallets](#public-urls-and-wallets) |
| Three example tasks, each needing all three categories | [Example Tasks](#example-tasks) |
| Architecture diagram: where payments are checked, signed, verified and settled | [Architecture](#architecture) |
| Registry: all listing fields, search by category and price, over HTTP and a web page | `src/registry/*`, `/registry/services?category=&maxPrice=`, `/marketplace` |
| At least 3 sellers, one per category, paid via HTTP 402 | scraping `shelf-scraper`; data `fx-rates`, `city-info`; inference `hindi-summary`, `sentiment` |
| Buyer agent: plain-language task + budget; explains what, from whom, why, cost | `src/buyer/*`, receipt on the `/run` page |
| `max_concurrency`, at least 3 parallel calls | Run page setting, `maxConcurrency` in `POST /buyer/run`, third argument of `npm run task` |
| Per-request settlement, one tx hash per paid call | x402.org facilitator on Base Sepolia; tx hash in every ledger row |
| Ledger: time, buyer, seller, service, listed price, amount paid, tx link, status, latency | `/ledger`, `GET /registry/ledger` |
| Budget never exceeded, even in parallel | `src/x402/budget.ts`; `npm run judge:budget` |
| Price check (amount, token, network, payTo) | `src/x402/safePayer.ts`; `npm run judge:price` |
| Replay (serial and parallel) | Nonce claim in `src/x402/paidRoute.ts`; `npm run judge:replay` |
| No service, no charge | Settle only after valid output; `npm run judge:failure` |
| Bad output flagged, reputation drops, buy elsewhere | `npm run judge:junk` |
| Reputation (success rate, median latency, price) used to choose | Marketplace cards, `GET /registry/compare` |
| Interop with unmodified x402 v2 client and seller | `npm run interop:ref-buyer`, `npm run judge:interop` |
| Key hygiene (repo, history, web bundle, logs) | See [Judge Test Pack](#judge-test-pack) |

**Stretch goal, partly done:** spending policies. Every run has its own budget and every wallet has a rolling spend cap (0.5 USDC per 60 min on the live deploy), but there is no human-approval step yet.

**Beyond the brief:**
- **Personal agent wallets:** sign in with your wallet, fund your own agent, spend from it, and withdraw gas-free.
- **Sell tab:** anyone can list a seller, and the registry checks the endpoint's live 402 against the listing.
- **Credibility score without KYC**, and a **Compare** dashboard that explains why one seller beats its substitutes.
- **Priority scheduling** for simultaneous payments.
- **Unconfirmed payments are never guessed:** they are resolved against the chain.

## Architecture

```mermaid
sequenceDiagram
  participant U as User or Judge
  participant B as Buyer agent Scout
  participant R as Registry
  participant S as Seller paidRoute
  participant F as x402.org facilitator
  participant C as Base Sepolia USDC
  U->>B: task + budget + max_concurrency
  B->>R: search by category, rank by reputation, price, credibility, latency
  Note over B: QUEUE for a payment slot (priority scheduler)
  B->>S: GET or POST endpoint
  S-->>B: 402 + PAYMENT-REQUIRED (base64 JSON)
  Note over B: CHECK amount <= listed, same token, network and payTo
  Note over B: RESERVE amount in BudgetLedger (mutex)
  Note over B: SIGN EIP-3009 transferWithAuthorization (standard @x402/evm)
  B->>S: retry + PAYMENT-SIGNATURE
  Note over S: CLAIM nonce atomically (replay guard)
  S->>F: VERIFY
  Note over S: do the work (timeout) and validate own output schema
  S->>F: SETTLE (only if output is valid)
  F->>C: transferWithAuthorization (facilitator pays gas)
  S-->>B: 200 + result + PAYMENT-RESPONSE (tx hash)
  Note over B: VALIDATE vs listed schema, write ledger, update reputation
```

| Step | Who | Where in the code |
|---|---|---|
| **Checked** (price, token, network, payTo vs listing; budget reserved) | Buyer, before signing | `src/x402/safePayer.ts`, `src/x402/budget.ts` |
| **Signed** (EIP-3009 authorisation, standard `@x402/evm`) | Buyer wallet | `src/x402/safePayer.ts` |
| **Verified** (signature and balance; nonce claimed once) | Seller, via the x402.org facilitator | `src/x402/paidRoute.ts` |
| **Settled** (only after valid output; facilitator pays gas) | x402.org facilitator on Base Sepolia | `src/x402/paidRoute.ts` |
| **Re-checked** (output schema, ledger, reputation) | Buyer, after the response | `src/x402/safePayer.ts` |

```mermaid
flowchart LR
  User["Browser"] --> Web["Next.js web app on Vercel - pages + proxy"]
  subgraph api [Hono API on Render]
    Registry["/registry - services, ledger, sales"]
    Sellers["/sellers/* - x402 paid routes"]
    Buyer["/buyer - Scout agent + SafePayer"]
    DB[(SQLite)]
  end
  Web -->|"proxies /registry /buyer /sellers /api /healthz"| api
  Buyer --> Registry
  Buyer -->|x402 v2| Sellers
  Sellers --> Facilitator[x402.org facilitator]
  Facilitator --> Chain[Base Sepolia USDC]
  Registry --- DB
  Sellers --- DB
  RefBuyer["Standard @x402/fetch client"] -->|x402 v2| Sellers
  Buyer -->|x402 v2| RefSeller["Standard @x402/express seller"]
```

## Public URLs and Wallets

Everything runs on the **Base Sepolia testnet** (`eip155:84532`). Registry listings and 402 `resource.url`s point at the API host directly.

| What | Method and URL |
|---|---|
| Web app: home, marketplace, run, ledger, sales, sell | https://gandiva-navy.vercel.app (`/marketplace`, `/run`, `/ledger`, `/sales`, `/sell`) |
| API base | https://gandiva-api.onrender.com |
| Health check | `GET` https://gandiva-api.onrender.com/healthz |
| Registry search | `GET` https://gandiva-api.onrender.com/registry/services?category=data&maxPrice=2000&sort=rank (`sort=rank\|price\|latency`) |
| Register a service | `POST` https://gandiva-api.onrender.com/registry/services |
| Compare substitutes (why one seller is picked) | `GET` https://gandiva-api.onrender.com/registry/compare?category=data&selected=fx-rates |
| Ledger | `GET` https://gandiva-api.onrender.com/registry/ledger |
| Seller sales | `GET` https://gandiva-api.onrender.com/registry/sales |
| Buyer: run a task | `POST` https://gandiva-api.onrender.com/buyer/run `{"task","budget","maxConcurrency","dryRun"?}`, then `GET /buyer/runs/:id` |
| Buyer: buy one call in a category (with failover) | `POST` https://gandiva-api.onrender.com/buyer/buy `{"category","input","budget"}` |
| Buyer: pay one specific service | `POST` https://gandiva-api.onrender.com/buyer/call `{"serviceId","input","budget"}` |

**Sellers** (prices in USDC; all accept unmodified x402 v2 clients):

| Seller | Category | Price | Method and example URL |
|---|---|---|---|
| shelf-scraper | scraping | 0.005 | `GET` https://gandiva-api.onrender.com/sellers/shelf-scraper/scrape?page=1 |
| fx-rates | data | 0.001 | `GET` https://gandiva-api.onrender.com/sellers/fx-rates/rate?from=GBP&to=INR |
| city-info | data | 0.002 | `GET` https://gandiva-api.onrender.com/sellers/city-info/city?name=Tokyo |
| hindi-summary (up to 2 texts) | inference | 0.010 | `POST` https://gandiva-api.onrender.com/sellers/hindi-summary/summarise `{"texts":["..."]}` |
| sentiment (up to 4 texts) | inference | 0.003 | `POST` https://gandiva-api.onrender.com/sellers/sentiment/analyse `{"texts":["..."]}` |
| cheap-scraper ⚠️ demo bad actor: 402 asks 10x listed | scraping | 0.002 listed | `GET` https://gandiva-api.onrender.com/sellers/cheap-scraper/scrape?page=1 |
| mirror-scraper ⚠️ demo bad actor: 402 names another payTo | scraping | 0.001 listed | `GET` https://gandiva-api.onrender.com/sellers/mirror-scraper/scrape?page=1 |
| junk-fx ⚠️ demo bad actor: 200 with schema-breaking output | data | 0.0008 | `GET` https://gandiva-api.onrender.com/sellers/junk-fx/rate?from=GBP&to=INR |

**Wallets** (fresh testnet-only wallets; these are public addresses, keys live only in server env vars):

| Role | Address |
|---|---|
| Buyer (Scout, shared demo wallet) | [`0xC2410105bfB318d2bb6fBb8ECE7Eadc9e1041B0B`](https://sepolia.basescan.org/address/0xC2410105bfB318d2bb6fBb8ECE7Eadc9e1041B0B) |
| shelf-scraper payTo | [`0xC91Ed2DB12D92C99987e4D2f85b405C96fA39679`](https://sepolia.basescan.org/address/0xC91Ed2DB12D92C99987e4D2f85b405C96fA39679) |
| fx-rates payTo | [`0x761b109231305f2a42b2d4829A10E6905AEa07af`](https://sepolia.basescan.org/address/0x761b109231305f2a42b2d4829A10E6905AEa07af) |
| city-info payTo | [`0xB424aD5901Eb351e83dC388836CAb3aE9138864a`](https://sepolia.basescan.org/address/0xB424aD5901Eb351e83dC388836CAb3aE9138864a) |
| hindi-summary payTo | [`0x20670d6c8dF9F650453115c92bc616DE89B53559`](https://sepolia.basescan.org/address/0x20670d6c8dF9F650453115c92bc616DE89B53559) |
| sentiment payTo | [`0x7CCC1a190870F762f614567A264E576cDBF05f94`](https://sepolia.basescan.org/address/0x7CCC1a190870F762f614567A264E576cDBF05f94) |
| cheap-scraper payTo | [`0x1CE46619b914206Cb39aB285102F0215b4abc871`](https://sepolia.basescan.org/address/0x1CE46619b914206Cb39aB285102F0215b4abc871) |
| mirror-scraper listed payTo | [`0xd4148ec37E180d5598C0a394d43F1213FE052Dce`](https://sepolia.basescan.org/address/0xd4148ec37E180d5598C0a394d43F1213FE052Dce) |
| "attacker" payTo named in mirror-scraper's 402 | [`0x233e5D6b13b25f6B306cF32C7A45e06e620b436d`](https://sepolia.basescan.org/address/0x233e5D6b13b25f6B306cF32C7A45e06e620b436d) |
| junk-fx payTo | [`0x249e5b90aebd44aD89b4F8A64a26FECaeF635046`](https://sepolia.basescan.org/address/0x249e5b90aebd44aD89b4F8A64a26FECaeF635046) |

Signed-in users also get their own agent wallet (created on first sign-in, key encrypted on the server); its address is shown on the Marketplace page.

USDC: [`0x036CbD53842c5426634e7929541eC2318f3dCF7e`](https://sepolia.basescan.org/token/0x036CbD53842c5426634e7929541eC2318f3dCF7e) (6 decimals). Explorer: https://sepolia.basescan.org

## Example Tasks

The first three each use scraping + data + inference:

1. `From pages 1 to 4 of books.toscrape.com, find the three cheapest 5-star books, give their prices in rupees, and summarise each description in Hindi.` Budget 0.050 (costs 0.041: 4 scrapes, 1 FX rate, 2 batched summaries).
2. `Check the weather in Tokyo, then give the two cheapest books on page 1 of books.toscrape.com in Tokyo's local currency, with a Hindi summary of each.` Budget 0.050 (city-info feeds its currency into fx-rates).
3. `From pages 1 to 2 of books.toscrape.com, find the three cheapest 5-star books, give their prices in euros, and say whether each description sounds positive or negative.` Budget 0.050 (sentiment instead of Hindi).
4. `What is the weather in Tokyo, and what is 100 GBP in the local currency there?` Budget 0.020 (data only: a two-step chain).

| Task | Scraping | Data | Inference | Paid calls |
|---|---|---|---|---|
| 1 | shelf-scraper x4 | fx-rates (GBP to INR) | hindi-summary x2 | 7 |
| 2 | shelf-scraper x1 | city-info, then fx-rates | hindi-summary x1 | 4 |
| 3 | shelf-scraper x2 | fx-rates (GBP to EUR) | sentiment x1 | 4 |

Change any number (pages, count, star rating, currency, city, budget) on the spot. cheap-scraper is listed cheaper than shelf-scraper; while its reputation is fresh, Scout tries it first, sees its 402 ask 10x the listed price (20000 vs 2000 units), refuses without signing, and records the refusal. Each refusal lowers its reputation, so later runs go straight to shelf-scraper; `npm run judge:price` shows a refusal on demand.

```bash
npm run task -- "<task>" 0.05 3          # task, budget in USDC, max_concurrency
npm run task -- "<task>" 0.05 3 --dry    # plan and quote only, pays nothing
```

### 5-minute demo outline

1. **Marketplace** (45 s): listings by category with price, payTo, schemas, reputation and credibility; press **Compare** on fx-rates to show why it beats its substitutes.
2. **Run task 1** (2 min): budget 0.05, max_concurrency 3. Watch the live 402 handshakes: scraper pages paid in parallel, then FX, then Hindi summaries. The receipt explains what was bought, from whom, why and at what cost.
3. **Ledger** (45 s): every attempt with listed vs asked vs paid, status and latency; open a tx on BaseScan to show buyer → payTo for the exact amount. `npm run reconcile` ties the ledger to the chain.
4. **Safety** (1 min): `npm run judge:replay` (one 200, one tx) and `npm run judge:junk` (paid, output rejected, reputation drops, bought elsewhere).
5. **Agent wallet** (30 s): sign in, fund the agent wallet, run from it, withdraw gas-free.

## Judge Test Pack

| Test | Command | What it shows |
|---|---|---|
| Happy path | `npm run task -- "<task>" 0.05 3` or the `/run` page | 3+ paid calls, each with its own tx to the seller's payTo |
| Reconciliation | `npm run reconcile -- <wallet address>` | Per-tx check (buyer → payTo, exact amount) and a full log scan of USDC out of the wallet, both equal to the ledger total |
| Budget | `npm run judge:budget` | 0.012 budget at max_concurrency 1 and 5: never overspends, stops and says how much more it needs |
| Price check | `npm run judge:price` | Standard-SDK sellers asking 10x, or naming another payTo, are refused with 0 paid |
| Replay | `npm run judge:replay` | One signature sent twice, then 5x in parallel: exactly one 200 and one tx |
| Seller failure | `npm run judge:failure` | Paid request for page 999: error back, no PAYMENT-RESPONSE, balance unchanged |
| Junk output | `npm run judge:junk` | Standard-SDK seller returns junk: paid, output rejected, reputation drops, buyer buys elsewhere |
| Standard client | `npm run interop:ref-buyer` and `npm run judge:interop` | Unmodified `@x402/fetch` pays our seller; our buyer pays an unmodified `@x402/express` seller |
| Unconfirmed payment | `npm run judge:unconfirmed` (add `-- --expire` for the never-settles case, about 5 min) | Buyer times out after signing: ledger shows `unconfirmed`, then the chain resolves it to `paid` with the tx hash (or `failed, not charged` once the authorisation expires) |
| Key hygiene | `gitleaks git .` (history) and `gitleaks dir client/.next/static` (web bundle) | No leaks. Keys live only in `.env` (gitignored) and server env vars; the web app only receives addresses; logs never print keys or signatures. `.gitleaksignore` lists two old commits whose test file held a made-up key (`sk-secret-...`); `tests/sellerStake.test.ts` uses the public Hardhat/Anvil development keys inside an in-process EVM. Neither is a real secret |

**Where to run them:** the scripts call `http://localhost:4021` by default (start it with `npm start`). Set `GANDIVA_URL=https://gandiva-api.onrender.com` to point `task`, `judge:budget`, `judge:replay`, `judge:failure`, `interop:ref-buyer` and `reconcile` at the live deploy. `judge:price`, `judge:junk` and `judge:interop` start a reference seller on your own machine, so run those against a local instance.

To check the live demo wallet with no keys at all:

```bash
GANDIVA_URL=https://gandiva-api.onrender.com npm run reconcile -- 0xC2410105bfB318d2bb6fBb8ECE7Eadc9e1041B0B
```

To register your own reference seller, `POST /registry/services`:

```json
{
  "name": "ref-seller", "category": "data", "endpoint": "https://your-host/rate", "method": "GET",
  "price": "1000", "payTo": "0x...",
  "inputSchema": {"type":"object","properties":{"from":{"type":"string"},"to":{"type":"string"}}},
  "outputSchema": {"type":"object","required":["rate"],"properties":{"rate":{"type":"number"}}},
  "description": "..."
}
```

Then `POST /buyer/call {"serviceId":"ref-seller","input":{...}}` or `POST /buyer/buy {"category":"data","input":{...}}`.

`npm test` runs 300+ offline tests (in-memory SQLite, no network, no keys) covering all of the above; see [docs/TECHNICAL.md](docs/TECHNICAL.md#automated-tests).

## How the Safety Rules Are Enforced

- **Budget:** every call must `reserve()` its amount in a shared `BudgetLedger` before signing. `spent + reserved + amount <= budget` is checked under a mutex, so parallel calls can never overspend. Failed calls release their reservation; settled calls commit it. Budget refusals are recorded in the ledger with the reason.
- **Price check:** the 402's `accepts` must match the registry listing: scheme `exact`, same network, same token, same payTo, and an amount no higher than the listed price. Otherwise Scout refuses without signing.
- **Replay:** before verifying, the seller claims the EIP-3009 authorisation nonce with a unique-key insert. Copies, sequential or parallel, get `409`. USDC itself also rejects a reused nonce on-chain.
- **No service, no charge:** the seller verifies, runs the handler with a timeout, validates its own output against its schema, and only then settles. Errors, timeouts and invalid output return an error without settling.
- **Bad output:** Scout validates every 200 against the listed output schema (Ajv). Junk is recorded as `paid_output_rejected`, discarded, counts against the seller's reputation, and Scout tries the next seller if the budget allows.
- **Unknown outcomes are never guessed:** if the buyer signs and then gets no answer, the row is `unconfirmed` and the budget stays spent. A background resolver asks USDC itself (`authorizationState` and the `AuthorizationUsed` event) every 15 s: used means `paid` with the real tx, unused after `validBefore` means `failed, not charged`. `npm run reconcile` refuses to pass while any `unconfirmed` row exists.
- **Wallet spend cap:** independent of per-run budgets, each wallet may spend at most `SPEND_CAP_USDC` (0.5 on the live deploy) per rolling 60 minutes; further payments are refused before anything is signed.
- **Registry:** anyone can list a seller, but the built-in sellers cannot be overwritten, a listing can only be updated by its original payTo, and `DELETE` needs an admin token.
- **Reputation:** success rate (clean paid calls / attempts), median latency and price per service, computed from the ledger. Ranking: optimistic score `(successes+1)/(attempts+1)` first, then price, then credibility, then latency.

## Rules Compliance

| Rule | How we follow it |
|---|---|
| Testnets only | Base Sepolia (`eip155:84532`) only. No mainnet keys, funds or transactions. |
| Keys | Fresh testnet wallets from `npm run wallets:new`, stored only in `.env` (gitignored) and the server's env vars. Never in the repo, the web bundle or the logs. |
| Protocol | Every judged path runs over x402 v2; every paid request ends in its own on-chain transfer. |
| Facilitator | The x402.org testnet facilitator. |
| Prices | At most 0.10 USDC per call, enforced by the registry when a service is listed. |
| Scraping | Only books.toscrape.com (a sandbox built for scraping); the scraper checks robots.txt. |
| Reachability | Web app on Vercel and registry + sellers on Render, all over public HTTPS. |
| AI | Open models via Ollama (`gpt-oss:20b`) for planning and inference. |

## Run It Locally

**Needs:** Node.js 20+, an [ngrok](https://ngrok.com/download) or [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) tunnel, and an LLM via [Ollama](https://ollama.com) (local `ollama pull qwen2.5:7b`, or Ollama cloud with `OLLAMA_API_KEY`).

```bash
npm install && cd client && npm install && cd ..
cp .env.example .env        # add your tunnel token and Ollama settings
npm run wallets:new         # creates fresh testnet wallets in .env, prints addresses only
# fund the buyer wallet with test USDC: https://faucet.circle.com (Base Sepolia), no ETH needed
npm start                   # one command: tunnel + API (:4021) + web app (:3000)
```

Open the public URL printed in the terminal (or `http://localhost:3000` with `TUNNEL=none`).

> ⚠️ Testnet only. Never put mainnet keys in `.env`.

## Tech Stack

Node.js, TypeScript, Hono, SQLite, Next.js 16, Tailwind v4, x402 SDKs (`@x402/*`), viem, Ajv, Ollama (gpt-oss), Vitest. Hosted on Vercel (UI) and Render (API).

## More Details

How Scout plans, the code map, the credibility score, seller comparison, the payment scheduler, start options and the deploy steps are in **[docs/TECHNICAL.md](docs/TECHNICAL.md)**.

## License

ISC
