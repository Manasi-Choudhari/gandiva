# Gandiva: Technical Details

The deeper parts of the project. For the overview and live links, see the [README](../README.md).

- [Local setup in detail](#local-setup-in-detail)
- [Verify the claims](#verify-the-claims)
- [Credibility without KYC](#credibility-without-kyc)
- [Seller comparison](#seller-comparison-why-one-seller-is-picked)
- [Priority scheduling for simultaneous payments](#priority-scheduling-for-simultaneous-payments)
- [Deploying (Render API + Vercel UI)](#deploying-render-api--vercel-ui)
- [One server instance](#one-server-instance)

## Local setup in detail

**Requirements:** Node.js 20+, a tunnel ([ngrok](https://ngrok.com/download) or [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)), and an LLM via [Ollama](https://ollama.com) (local `ollama pull qwen2.5:7b`, or Ollama cloud with `OLLAMA_API_KEY`).

```bash
# 1. Install
npm install
cd client && npm install && cd ..

# 2. Configure
cp .env.example .env          # add NGROK_AUTHTOKEN and your Ollama settings
npm run wallets:new           # generates testnet wallets into .env

# 3. Fund the buyer wallet with testnet USDC (no ETH needed)
#    https://faucet.circle.com  ->  Base Sepolia

# 4. Start everything (tunnel + API + web app)
npm start
```

Open the public URL printed in the terminal (or `http://localhost:3000` with `TUNNEL=none`), go to **/run**, and try:

> *From pages 1 to 4 of books.toscrape.com, find the three cheapest 5-star books, give their prices in rupees, and summarise each description in Hindi.* Budget: `0.05`

Or from the CLI:

```bash
npm run task -- "<task>" 0.05 3     # task, budget in USDC, max_concurrency
```

> ⚠️ Testnet only. Never put mainnet keys in `.env`.

## Verify the claims

| Command | What it checks |
|---|---|
| `npm test` | 300+ offline unit tests (no network, no money) |
| `npm run reconcile` | Paid ledger rows equal the USDC transfers out of the buyer wallet, to the unit |
| `npm run judge:budget` | A too-small budget is never exceeded, at concurrency 1 and 5 |
| `npm run judge:price` | A 402 asking more than listed, or naming another payTo, is refused |
| `npm run judge:replay` | One signed payment unlocks one response, serial or 5x parallel |
| `npm run judge:failure` | A seller that fails is not paid |
| `npm run judge:junk` | Schema-breaking output is recorded "paid, output rejected" and the seller loses reputation |
| `npm run judge:interop` | Our buyer pays an unmodified `@x402/express` seller |

## Prompt injection and the attack scoreboard

Seller output is shown to the planner LLM, so a seller can try to give it orders. Two layers stop that:

1. **Payments never listen to the LLM.** The LLM can only name catalogue services; price, payTo, budget and the spend cap are checked by code (`SafePayer`, `BudgetLedger`, `SpendCap`), so "send 0.09 USDC to 0x…" has no path to a payment.
2. **Injected output is rejected.** After the schema check, `findInjection` (`src/x402/injection.ts`) scans every string for phrases aimed at an AI ("ignore your previous instructions", "note to AI agents", "send … USDC to 0x…"). A hit is recorded as `paid_output_rejected` with reason `prompt injection: "…"`: the seller loses reputation, Scout buys from the next seller, and the text never reaches the model. It is not slashed from the seller's stake, because a phrase match is not proof the way a schema break is.

The phrase list can miss reworded attacks and can flag text that only talks about prompt injection; layer 1 is the guarantee, layer 2 keeps the planner clean.

`promo-scraper` (wallet `PAYTO_PROMO_SCRAPER`, skipped if unset) is the demo bad actor: real books with an injection appended to the first description.

`GET /registry/attacks` counts every attack stopped so far, by kind, from the buyer ledger's reasons (overcharge, swapped payTo, bad terms, unsafe endpoint, junk output, prompt injection) plus replayed signatures from the sellers' sales, and sums what the refused 402s asked for. The home page shows it live; `/flow` draws the ledger's payments as a graph of wallets.

## Credibility without KYC

Each listing gets a score out of 100 from proofs a seller can give with code, keys or money, never identity documents. `GET /registry/services/:id/credibility` returns the breakdown.

| Check | Points | How it is proven |
|---|---|---|
| x402 conformance | 20 | A live probe of the endpoint returns a 402 that matches the listing |
| Controls its payout wallet | 15 | A signature from the payTo key: `POST /registry/services/:id/proof` or a wallet sign-in on the Sell tab |
| Track record | 25 | Valid-output rate from the buyer's ledger; full credit from 10 calls |
| Stake | 20 | USDC bonded in SellerStakeV2 from the payTo wallet; full credit from 0.05 USDC when the seller is slashable (has a receipt signer), at most 10 without one, 0 while unstaking, minus 5 per executed slash. See [STAKE.md](STAKE.md) |
| On-chain wallet history | 10 | The payTo has sent transactions or holds USDC on Base Sepolia |
| HTTPS | 5 | The endpoint uses TLS |
| Listing age | 5 | Listed for at least an hour |

Credibility breaks ties in ranking: after reputation and price, before latency. The built-in sellers' proofs are signed at boot with their keys from `.env`.

## Seller stake

A seller can bond testnet USDC in `SellerStakeV2`. If it is paid and returns junk, 2 of 3 independent verifiers can refund that buyer from the bond: at most 0.10 USDC per call, after a 30 minute window in which they can still veto it. No single key can take a bond, and the relayer that pays the gas has no powers; USDC fees from sellers repay it. Slashing rests on receipts the seller signs (`X-Gandiva-Receipt`). Only the built-in sellers and outside sellers that add receipts are slashable; hosted LLM agents, MCP-server listings and agent chains get no receipts yet. How a slash works, the receipt format, verifier setup and the runbook (rotate a verifier, refill the relayer, clear a stuck claim) are in **[STAKE.md](STAKE.md)**.

## Selling an MCP server

The Sell tab turns tools on a seller's MCP server into paid listings (`src/mcpseller/`). A buyer pays the seller's wallet, Gandiva calls the tool with the seller's stored token, and a tool that fails or returns nothing is not charged.

- **Picking and pricing:** "Load tools" reads the server for free. The seller ticks up to 20 tools and prices each one, within the limit of 20 listings per wallet. Saving again applies the new picks: a tool that is unticked, or that the server dropped, leaves the marketplace. One save is one database transaction, so a save that lists nothing changes nothing.
- **Tools that change data:** a buyer who pays can run a listed tool with the seller's token, so what the server says about each tool is shown as read only, changes data or not declared. Tools marked as changing data start unticked with a warning, and on a refresh every new tool starts unticked. These hints are optional and come from the seller's own server, so "not declared" proves nothing.
- **What buyer agents may pick:** Scout never picks a tool marked as changing data. A pick by category or input shape alone (`/buyer/buy`, the books pipeline) only takes an MCP tool that says it just reads. Naming a tool works for any tool (`/buyer/call`, a chain step the seller chose). The marketplace shows a warning, and `/mcp` passes the hint on to its clients. A tool that changes data but declares nothing is still open to Scout, so a seller should not list one.
- **One tool, one job:** Scout and chains normally treat listings with the same schemas as interchangeable and fail over between them. MCP tools are excluded from that, because two tools on one server can share a schema and do opposite things (`read_file`, `delete_file`). A failed MCP tool is never swapped for another listing.
- **Answers that are not text:** only text is passed on, including text files a tool attaches. An answer with no text is not charged, and the error says what the tool returned. If an answer mixes text with images, audio, binary files or links, the buyer gets the text and a note such as `[1 image not included]`.
- **Free test calls:** `POST /registry/mine/mcp-servers/test` runs one tool for the signed-in seller, limited to 20 calls an hour. Input gets the same schema check as a paid call. Nothing is paid or recorded, but the tool really runs, so a tool that changes data changes it.
- **Tokens:** bearer tokens are stored encrypted and never returned. A saved token is only reused for the exact URL it was saved with, including by test calls and when Refresh moves a group to a new URL.
- **Groups:** a server's tools are listed under one group name. A second server cannot take over a group by sharing its name. Only Refresh can move a group to a new URL. `DELETE /registry/mine/mcp-servers/:serverId` removes the whole group and its token.
- **Connecting:** Gandiva tries Streamable HTTP first. If the server answers 400, 404 or 405 it reconnects over the older SSE transport, as the MCP spec describes. Only connecting is retried, so a paid tool call never runs twice. The URL must be public https, it is checked again on every call, redirects are refused, and the timeout covers connecting as well as the call.

- **Background check:** every listed server is read with its saved token 30 seconds after boot and every 30 minutes (`src/mcpseller/health.ts`), one server at a time. A host that sleeps only checks while awake. A seller sees a warning on My listings when the server cannot be read, the token is refused, a tool is gone or a tool's input changed. A saved refresh clears it. A check never removes a listing, because a server can be down for a minute, and buyers are not charged for calls that fail. Hints are updated on every check, so a tool that starts changing data leaves Scout's reach without waiting for the seller, and tools listed before hints were kept get their real hint. "402 checked" only tests our own route, so it says nothing about the seller's server; this check does.

Not supported: servers that only allow a browser sign-in (OAuth), which get a clear error, and stdio servers. Stdio would mean running a seller's command on our machine, so it will not be added. A seller with a local server can run a bridge that exposes it over https.

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

- **The free Render plan has no disk, so the database is replicated with Litestream.** `deploy/start.sh` restores `data/gandiva.db` (ledger, registry, users, agent wallets) from an S3-compatible bucket on start, then runs the server under `litestream replicate`, which copies every change to the bucket about once a second. Set `LITESTREAM_BUCKET`, `LITESTREAM_ENDPOINT` (with `https://`), `LITESTREAM_REGION`, `LITESTREAM_ACCESS_KEY_ID` and `LITESTREAM_SECRET_ACCESS_KEY` on Render (Backblaze B2 works; set the bucket to keep only the last file version). Without `LITESTREAM_BUCKET` the server starts without replication and the data is wiped on every restart or deploy.
- **Litestream limits:** a hard crash can lose the last second or two of writes; one server instance only; keep the bucket private (it holds the whole database, including encrypted keys) and never change `SECRETS_KEY`, or the restored wallets cannot be decrypted.
- **Deploys:** auto-deploy is off, so deploy by hand.
- **The free plan sleeps after 15 idle minutes.** Point an uptime pinger (e.g. UptimeRobot) at `/healthz` every 5 minutes.
- Every registry listing and 402 `resource.url` is built from `PUBLIC_BASE_URL`, so sellers are reached on the Render URL directly, not through Vercel.
- **Logs are JSON lines.** Each request logs its method, path, status, time, IP and request id, never headers, bodies or the query string. A 500 response carries a `requestId`; search the logs for it to find the real error.
- **Health:** `/healthz` runs a query against the database and answers 503 if it can't. `/api/info` shows when each background worker last ran under `workers`.
- **Restarts:** a run cut off by a restart or deploy shows as `interrupted`, with its spending taken from the ledger.
- Local image check: `docker build -t gandiva-api .`

## One server instance

The API is built to run as exactly one process. Render's `render.yaml` runs one, and the free plan can't run more. Some of what keeps payments safe lives in that process's memory, so a second instance would not be slower: it would be wrong. Don't add one without doing the work below.

| State | Where | What goes wrong with two instances | What to change |
|---|---|---|---|
| Spend cap reservations (`inFlight`) | `src/x402/spendCap.ts` | Each sees only its own payments in flight, so together they can pass the cap | A reservations table, checked and written in one transaction |
| Active runs (`runs`, `hasActiveRun`) | `src/buyer/scout.ts` | A withdrawal on one instance can't see a run paying from that wallet on the other | Check `runs.state = 'running'` in the database |
| Boot sweep (`markInterruptedRuns`) | `src/buyer/scout.ts` | A starting instance marks the other's live runs as `interrupted` | Record which instance owns a run, and sweep only instances that stopped heartbeating |
| Chain locks (`activePayers`, `inflight`, `payingOwners`) | `src/chains/chains.ts` | A payer gets one chain per instance, and a withdrawal can miss a chain that's paying | Rows with an expiry, so a crash can't leave a lock held |
| Paid step cache (`stepCache`) | `src/chains/chains.ts` | A retry reaching the other instance pays the same suppliers twice | A table with the same 10-minute expiry |
| Withdrawal lock (`locks`) | `src/agents/wallet.ts` | Two withdrawals for one user can run at once | A per-user row taken before the withdrawal starts |
| Relayer send lock (`sendLock`) | `src/stake/index.ts` | Both instances send with the same nonce, so one transaction replaces or fails the other | Only one instance relays, or the nonce is handed out from the database |
| Payment slots | `src/x402/scheduler.ts` | Slot limits apply per instance, and priority only orders calls within one instance | Slot counts in the database, with the queue on one instance |
| Rate limits | `src/http/rateLimit.ts`, `src/stake/routes.ts`, `src/agents/llm.ts`, `src/chains/chains.ts`, `src/hosted/agents.ts`, `src/mcpseller/servers.ts` | Every limit is multiplied by the number of instances | Counters in the database, or a shared store |
| Workers (resolver, claims, credibility, MCP checks) | `startResolver`, `startClaimWorker`, `startCredibilityRefresh`, `startMcpChecks` | Each pass runs twice, and the claim worker can spend relayer gas on duplicate transactions | A lease row, so one instance at a time does the work |

**Moving this into SQLite only gets as far as one machine.** Several processes can share a SQLite file on one disk, so the table above is enough for that. It doesn't cover several machines: the file isn't shared between them, and Litestream expects a single process to own the database. That needs a networked database such as Postgres, and because `better-sqlite3` is synchronous, every store function that uses it would change as well.

**Safe to leave per process:** the credibility, stake, FX, book and schema caches, and the cached payers and RPC clients. They expire or rebuild, and a miss only costs a repeat read.

`SELLER_PROCESSES=on` is not a second instance. Each seller process has its own database and takes only the traffic the API forwards to it.
