# Gandiva: Technical Details

The deeper parts of the project. For the overview and live links, see the [README](../README.md).

- [How Scout works](#how-scout-works)
- [Code map](#code-map)
- [Start options](#start-options)
- [Automated tests](#automated-tests)
- [Credibility without KYC](#credibility-without-kyc)
- [Seller comparison](#seller-comparison-why-one-seller-is-picked)
- [Priority scheduling for simultaneous payments](#priority-scheduling-for-simultaneous-payments)
- [Deploying (Render API + Vercel UI)](#deploying-render-api--vercel-ui)

## How Scout works

- **The LLM plans, code enforces.** Each turn the LLM sees the task, the budget left and a catalogue of services (sellers with the same category and schemas are shown as one interchangeable group). It answers with JSON: paid `calls`, free local `tools` (`select` to filter, sort, limit and compute fields, `calc` for arithmetic) or a `final` answer. Steps can use earlier results by reference (`$p1.books[0:2].description`), so long texts are never copied through the model, and steps inside one turn run in dependency order.
- **Before any money moves**, every call is checked against the service's listed input schema; an invalid plan gets one repair message. Cost is estimated against the remaining budget, and calls that do not fit are skipped and reported (state `needs_more_budget`). Payments go through the safety layer (price check, budget reservations, wallet spend cap, unconfirmed handling).
- **Failover.** A seller that refuses, returns junk or fails is skipped for the rest of the run, and the next one in the group is tried.
- **Dry run.** `dryRun` plans, validates and quotes with sample data and pays nothing (`npm run task -- "<task>" 0.05 3 --dry`).
- **Fallback.** If the LLM is down, or the plan stays invalid and nothing was bought, book-price tasks fall back to a built-in pipeline; any other task ends as `failed` with the reason. `SCOUT_MODE=legacy|agent|auto` (or `mode` in the API, `--legacy` on the CLI) forces a mode.

## Code map

| Concern | File |
|---|---|
| Seller-side x402 (nonce claim, verify, work, self-check, settle) | `src/x402/paidRoute.ts` |
| Buyer-side x402 (price check, reservation, sign, schema check, ledger) | `src/x402/safePayer.ts` |
| Budget reservations | `src/x402/budget.ts` |
| Wallet spend cap | `src/x402/spendCap.ts` |
| Unconfirmed-payment resolver | `src/x402/chain.ts`, `src/x402/resolver.ts` |
| Priority scheduler for simultaneous payments | `src/x402/scheduler.ts` |
| Registry, ledger, reputation, compare | `src/registry/store.ts`, `src/registry/routes.ts` |
| Live 402 probe of listings | `src/registry/probe.ts` |
| Credibility score (no KYC) | `src/registry/credibility.ts` |
| Sellers | `src/sellers/index.ts`, `src/sellers/books.ts`, `src/sellers/fx.ts` |
| Buyer agent (planner, catalogue, failover, receipt) | `src/buyer/agent.ts`, `src/buyer/plan.ts`, `src/buyer/catalogue.ts`, `src/buyer/scout.ts` |
| Personal agent wallets | `src/agents/wallet.ts` |
| API app (Hono) | `src/server.ts` |
| Web app (Next.js 16, Tailwind v4) | `client/` |
| API proxy rewrites | `client/next.config.ts` |
| One-command start (tunnel + API + web) | `scripts/start.ts` |

## Start options

Two processes run behind one public URL:

| Process | Port | Env var | Role |
|---|---|---|---|
| Next.js web app (`client/`) | 3000 | `WEB_PORT` | Public front door and tunnel target. Serves the pages and proxies `/registry`, `/buyer`, `/sellers`, `/api` and `/healthz` to the API. |
| Hono API (`src/server.ts`) | 4021 | `PORT` (or `API_PORT`) | Registry, sellers, buyer agent, ledger. |

- `npm start` opens a tunnel to port 3000 (`TUNNEL=auto` tries cloudflared, then ngrok; `TUNNEL=ngrok|cloudflared` picks one; ngrok needs `NGROK_AUTHTOKEN`). It starts both processes with that public URL, so every registry listing and 402 `resource.url` is publicly reachable.
- If `PUBLIC_BASE_URL` is set, it skips the tunnel and uses that. With `TUNNEL=none` everything runs on `http://localhost:3000`.
- `WEB_MODE=prod` (default) builds the web app once and serves the production build; `WEB_MODE=dev` runs `next dev` with hot reload.
- The x402 headers (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`) and status codes pass through the Next.js proxy unchanged; the proxy waits up to 120 s, longer than the buyer's 90 s paid-call timeout.
- Without a tunnel: `npm run dev:all` (API and web app with reload), or `npm run dev:api` and `npm run dev:web` separately.
- The CLI scripts (`npm run task`, the judge pack, `reconcile`) talk to `http://localhost:4021`; set `GANDIVA_URL=<url>` to aim them elsewhere.

## Automated tests

`npm test` runs 300+ offline tests in 30 files (in-memory SQLite, no network, no keys): price-check mismatches, budget under 50 parallel reservations, the seller replay guard (serial and 5x parallel), the unconfirmed-payment paths, the chain resolver, the wallet spend cap, registry rules, the DB migration, schema validation, the task parser, the priority scheduler and the ranking explanation. `npm run check:chain` is a read-only check of the chain lookup against real Base Sepolia transactions.

## Credibility without KYC

Each listing gets a score out of 100 from proofs a seller can give with code, keys or money, never identity documents. `GET /registry/services/:id/credibility` returns the breakdown.

| Check | Points | How it is proven |
|---|---|---|
| x402 conformance | 20 | A live probe of the endpoint returns a 402 that matches the listing |
| Controls its payout wallet | 15 | A signature from the payTo key: `POST /registry/services/:id/proof` or a wallet sign-in on the Sell tab |
| Track record | 25 | Valid-output rate from the buyer's ledger; full credit from 10 calls |
| Stake | 20 | Reserved for USDC bonded behind a listing; staking is not enabled on the live deploy, so this scores 0 there |
| On-chain wallet history | 10 | The payTo has sent transactions or holds USDC on Base Sepolia |
| HTTPS | 5 | The endpoint uses TLS |
| Listing age | 5 | Listed for at least an hour |

Credibility breaks ties in ranking: after reputation and price, before latency. The built-in sellers' proofs are signed at boot with their keys from `.env`.

## Seller comparison: why one seller is picked

On the Marketplace, **Compare** on any card opens a dashboard of the sellers the buyer treats as substitutes for that job (same input and output schema). It shows:

- the ranking ladder, with the rule that decided each step (402 check, reputation, price, credibility or latency);
- a radar chart of every parameter (reputation, success rate, cheapness, speed, credibility, stake);
- per-parameter bars across all candidates;
- the last calls to each seller (latency and outcome);
- the selected seller's credibility checks.

The API is `GET /registry/compare?category=data&selected=fx-rates`. The explanation code follows `rankCompare` step by step, and a unit test keeps the two in sync.

## Priority scheduling for simultaneous payments

All paid calls go through one scheduler (`src/x402/scheduler.ts`):

- **Limits:** at most 5 run at once per paying wallet (`PAY_SLOTS_PER_WALLET`) and 4 per seller (`PAY_SLOTS_PER_SELLER`).
- **Choosing who goes next:** when more calls want to start, the highest priority goes first. Priority is a weighted sum:
  - 0.30 for a settlement retry (money is already in motion);
  - 0.25 for time waited (ageing, so nothing starves);
  - 0.20 for run progress (the share of its budget already spent);
  - 0.15 for the seller's reputation;
  - 0.10 for a smaller payment.
- **Ties and waiting:** equal priority keeps arrival order, and no call waits more than 30 s.
- **Where to see it:** the Run page shows queued calls and recent contention decisions, and `GET /buyer/queue` returns the same data.
- **Budgets:** these rules decide the order of payments. The guarantee that spending never passes the budget still comes from the per-run budget reservations.

## Deploying (Render API + Vercel UI)

The API (registry, sellers, buyer, ledger) is one Docker service; the Next.js UI is a separate Vercel project that proxies to it.

1. **Render**: New > Blueprint, pick this repo (`render.yaml`). Fill the secret env vars (see `.env.example`: `BUYER_PRIVATE_KEY`, `SECRETS_KEY`, `PAYTO_*`, `OLLAMA_API_KEY`, `ADMIN_TOKEN`, `BUYER_TOKEN`). Set `PUBLIC_BASE_URL` to the service's own URL (e.g. `https://gandiva-api.onrender.com`) and redeploy once it is known.
2. **Vercel**: import the repo, set the root directory to `client/`, and set `API_URL` to the Render URL. Nothing else is needed; the client reads no other env vars.
3. **Check**: `<render-url>/healthz`, `<render-url>/registry/services`, then sign in and run a task from the Vercel URL.

Things to know:

- **The free Render plan has no disk.** `data/gandiva.db` (ledger, registry, users, agent wallets) is wiped on every restart or deploy. Deploy by hand (auto-deploy is off), never mid-judging, and use a freshly funded buyer wallet for a run you want to reconcile.
- **The free plan sleeps after 15 idle minutes.** Point an uptime pinger (e.g. UptimeRobot) at `/healthz` every 5 minutes.
- Every registry listing and 402 `resource.url` is built from `PUBLIC_BASE_URL`, so sellers are reached on the Render URL directly, not through Vercel.
- Local image check: `docker build -t gandiva-api .`
