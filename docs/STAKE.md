# Seller stake (SellerStakeV2)

Sellers can lock testnet USDC as a bond behind their listings. If a seller is paid and sends back junk, the bond refunds that buyer. No single key can take a bond: a refund needs signatures from 2 of 3 independent verifiers, is capped, and waits out a window in which it can still be vetoed.

- Contract: `contracts/SellerStakeV2.sol` (Base Sepolia, testnet only; signatures, EIP-712 and token calls from OpenZeppelin)
- Contract tests and deploy script: `foundry/`, built with Foundry
- Server: `src/stake/` (relayer, claims worker, receipts, evidence, verifier checks)
- Outside verifier: `scripts/verifier.ts`, run on a schedule by `.github/workflows/verifier.yml`
- Backup jobs: `scripts/keeper.ts` and `scripts/watchdog.ts`, run by `.github/workflows/keeper.yml` and `watchdog.yml`
- UI: the **Stake** card on the Sell tab

[SECURITY-REVIEW.md](SECURITY-REVIEW.md) lists what the security review found and the limits that remain.

## Rules

| Rule | Value |
|---|---|
| Signatures for a slash | 2 of the 3 verifiers |
| Most refunded per paid call | 0.10 USDC (never more than the buyer paid) |
| Who gets the refund | The buyer of that call, directly from the contract |
| Time to file a claim | 1 hour after the payment |
| Wait before the refund executes | 30 minutes, in which 2 verifiers can veto it |
| Unstake cooldown | 2 hours (longer than the claim time plus the wait) |
| Withdraw | Blocked while any claim against the seller is pending |
| New claims | At most 3 per seller in any 30 minutes, vetoed ones included. Others wait for a slot, and expire if none frees before their deadline |
| Gas | Paid by whoever sends the transaction, usually the relayer. It has no powers: it only submits what sellers or verifiers signed |
| Stake fee | 0.02 USDC from each stake, to the sender |
| Slash fee | 0.02 USDC from the bond each time a claim closes on chain, to the sender |

Staking, unstaking and registering a receipt signer are wallet signatures (EIP-712). The seller pays no gas and needs no ETH.

## Fees

The gas of a stake belongs to the seller who staked, and the gas of a claim to the seller who caused it. Fees pay it back in USDC, so the relayer roughly breaks even however many sellers join, and someone trying to run up its bill has to pay for each attempt.

- **The stake fee** is taken out of what the seller signs: staking 0.07 USDC gives a 0.05 bond and a 0.02 fee. It prepays that stake, its unstake and withdraw, and a receipt signer. The smallest stake the relayer accepts is 0.03 USDC.
- **The slash fee** comes out of the bond after the buyer's refund, so the buyer is always paid first. If less than the fee is left, it takes what is left.
- **A veto costs the seller the slash fee too.** A rebutted claim means the seller's receipt never reached the buyer. Without the fee, a seller could hold receipts back and rebut every claim at the relayer's expense. The cost is that a seller can lose 0.02 USDC to a receipt lost in transit, or to a refund a blocked buyer address cannot take.
- **Fees go to `msg.sender`.** A seller who sends its own stake pays itself, so the fee is free for anyone willing to pay their own gas. Anyone who executes a due refund earns the slash fee, so refunds do not depend on this server being up.
- **Fees are fixed at deploy** (`STAKE_FEE`, `SLASH_FEE` in USDC units, capped at 0.10 USDC by the contract). Nobody can raise them later; a new fee needs a new contract.

### What it costs

Measured by `npm run stake:dry-run` against the real USDC contract:

| Path | Gas |
|---|---|
| Stake | 184,861 |
| Receipt signer | 74,446 |
| Unstake | 58,617 |
| Withdraw | 54,170 |
| **Full seller cycle** | **372,094** |
| Propose | 206,552 |
| Execute | 88,889 |
| Veto | 86,645 |
| **One claim** | **about 295,000** |

On Base mainnet on 2026-10-31 gas was 0.006 gwei and ETH $2,240, so a seller cycle cost about $0.005 and a claim about $0.004. L1 data adds under 1% at those prices.

With ETH at that price a 0.02 USDC fee breaks even at about 0.024 gwei for a seller cycle and 0.030 gwei for a claim. A higher ETH price lowers both. Above `RELAY_MAX_GWEI` (0.02) the relayer refuses seller actions with a 503, and a seller can still send its own transaction. Claims, vetoes and refunds never wait, so during a spike they may cost more than their fee.

### What stops gas being wasted

- A signature is checked, and every call simulated, before anything is sent.
- A claim is closed as `no_bond` without a transaction when the seller's bond cannot cover more than the claims already on chain.
- A repeat unstake is refused, since the contract would accept it and no fee covers it.
- A receipt signer needs a bond first, and is limited to 3 changes a day per seller. That count lives in the database, so a restart does not reset it.
- The relayer's spending shows in `GET /registry/stake` as `relayer.txs`, `relayer.gasEth` and `relayer.feesUsdc`, from the `relayer_book` table.

## How a slash works

1. **The buyer pays, and the output fails its check.** Scout records `paid_output_rejected` (schema broken, or an error status) and saves an evidence bundle. The bundle holds the payment (payer, payTo, amount, USDC nonce, settlement tx), the request, the promised output schema, the raw response body and the seller's receipt. Its id is `keccak256(canonical(bundle))`, so anyone can re-hash it. Output rejected only for prompt injection is not claimed, because a phrase match is not proof.
2. **A claim is filed** (`src/stake/claims.ts`). Each verifier fetches the evidence and checks it on its own:
   - the bundle matches its hash;
   - the settlement tx shows this exact USDC authorization and transfer;
   - the claim is less than 1 hour old;
   - the seller had a receipt signer at the payment's block;
   - the receipt shows the output is junk.
3. **Kind 1 or kind 2.**
   - **Kind 1:** a valid receipt from the seller covers this payment and body, and the body breaks the signed schema (or the receipt signs an error status). The seller's own signature proves it, so it cannot be rebutted.
   - **Kind 2:** the buyer paid on chain but got no valid receipt back. The seller can rebut it.
4. **Propose.** Once 2 verifiers have signed the same claim message, the relayer calls `proposeSlash`. The claim is now pending on chain for 30 minutes.
5. **Rebut (kind 2 only).** During those 30 minutes the seller can post the receipt and the exact body it sent (Sell tab, **Rebut**, or `POST /registry/stake/claims/:id/rebuttal`). The server checks the rebuttal before storing it. Each verifier checks it again and signs a veto if it holds. Verifiers then get up to 1 hour to veto.
6. **Execute or veto.** With 2 veto signatures, the relayer calls `vetoSlash`. Otherwise, after the wait, it calls `executeSlash`: the contract sends the refund to the buyer, takes the slash fee and emits `Slashed`.

The worker retries every chain call with backoff (30 s doubling, up to 30 min). Before every send it reads the claim's on-chain state, so nothing is sent twice. A veto or execute that landed some other way is adopted, and the worker reads the refund it paid from the `Slashed` event.

A seller with no receipt signer cannot be slashed. Its claims close as `not_slashable`, and its bond only counts toward credibility.

## Credibility points (stake check, out of 20)

| Seller state | Points |
|---|---|
| Nothing staked | 0 |
| Unstaking | 0 (staking again cancels the unstake) |
| Staked, no receipt signer | Up to 10 |
| Staked and slashable | Up to 20, full credit from 0.05 USDC |
| Each executed slash | Minus 5, never below 0 |

Staking from the payTo wallet also counts as proof that the seller controls that wallet.

## Receipts, for sellers running their own server

To be slashable (and earn full stake points), your server must attach a receipt to every paid response, and you register the receipt key on the Sell tab.

**Register only a key your server really signs with.** A paid call that comes back without a valid receipt becomes a kind 2 claim, and you can only rebut it with a receipt from the registered key. A receipt signer cannot be removed, only replaced. Verifiers use the signer that was registered at the block of the payment.

**Header:** `X-Gandiva-Receipt: base64(JSON.stringify({ receipt, signature }))`

**EIP-712 typed data:**

- Domain: `{ name: "Gandiva Receipt", version: "1", chainId: 84532 }` (no `verifyingContract`)
- Type: `Receipt(address payTo,address payer,bytes32 paymentNonce,bytes32 requestHash,bytes32 outputHash,bytes32 schemaHash,uint16 httpStatus)`

| Field | Value |
|---|---|
| `payTo` | Your payout address from the 402 |
| `payer` | The buyer address in the x402 payment authorization |
| `paymentNonce` | The bytes32 nonce of that authorization |
| `requestHash` | `keccak256("<METHOD> <path>?<query>\n<raw request body>")`, method upper-case, host left out (no `?` when there is no query) |
| `outputHash` | `keccak256(<raw response body bytes>)` |
| `schemaHash` | `keccak256(canonical(outputSchema))`; `canonical` is JSON with object keys sorted, no spaces |
| `httpStatus` | The status you return |

Sign after the payment settles, over the exact bytes you send. `src/stake/receipt.ts` (`signReceipt`) is the reference implementation, and `src/x402/paidRoute.ts` shows where it is called.

**Not covered yet:** hosted LLM agents, MCP-server listings and agent chains get no receipts, so they cannot be slashed. Staking still counts toward their credibility, at most 10 of 20 points.

## Setting up

1. **Keys:** `npm run wallets:new` creates the missing keys in `.env`:
   - `RELAYER_PRIVATE_KEY`: pays gas and earns the fees. Send it about 0.01 Base Sepolia ETH.
   - `RECEIPT_SIGNER_KEY`: signs the built-in sellers' receipts. Holds no money.
   - `SERVER_VERIFIER_KEY` and `VERIFIER_KEY`: two verifier keys for local testing.

   In production, give each of the 3 verifiers its own fresh key, created on its own host. If one machine holds 2 verifier keys, that machine alone can pass a slash.
2. **Deploy (spends testnet ETH):** the deployer needs a key only for this one transaction and has no powers afterwards. Keep it in Foundry's encrypted keystore, not in `.env`:
   ```
   cast wallet new
   cast wallet import gandiva-deployer --interactive
   ```
   Send that address a little Base Sepolia ETH. Set `VERIFIER_ADDRESSES` to the 3 verifier addresses (comma-separated), then:
   ```
   forge script foundry/script/DeploySellerStakeV2.s.sol --rpc-url https://sepolia.base.org --account gandiva-deployer --broadcast
   ```
   The script refuses every chain except Base Sepolia. The fees default to 0.02 USDC and cannot change after this step, so check them against current gas first. Put the address it prints in `STAKE_CONTRACT`, and commit the record it writes under `foundry/broadcast/`.
3. **Server (verifier 1):** on Render, set `STAKE_CONTRACT`, `RELAYER_PRIVATE_KEY`, `RECEIPT_SIGNER_KEY` and `SERVER_VERIFIER_KEY`, then deploy. Without `RELAYER_PRIVATE_KEY` staking stays off.
4. **GitHub Actions (verifier 2, and the backup jobs):** in Settings, Secrets and variables, Actions:
   - secret `VERIFIER_KEY`;
   - secret `KEEPER_KEY`, a fresh wallet with about 0.002 Base Sepolia ETH on it;
   - variable `GANDIVA_URL` (the API's public URL);
   - variable `STAKE_CONTRACT`;
   - variable `BUYER_ADDRESS` (optional: the shared buyer, for the daily ledger check).

   This repository is a fork, and GitHub keeps scheduled workflows off in a fork until you turn them on. In the Actions tab, enable workflows, then enable `stake verifier`, `stake keeper` and `watchdog`. Set the variables last, because `STAKE_CONTRACT` is what starts the jobs.

   | Workflow | Runs | Does |
   |---|---|---|
   | `stake verifier` | Every 5 minutes | Re-checks open claims and signs the ones the evidence supports |
   | `stake keeper` | Every 30 minutes | Executes refunds that are overdue, from the chain alone, and earns their fee |
   | `watchdog` | Hourly, plus a daily ledger check | Fails, which sends a GitHub email, if something is wrong |
   | `stake emergency` | By hand only | Signs or sends a veto or rotation with the keys held here |

   Scheduled runs can start late. GitHub also stops them after 60 days with no activity in the repository, so push something before that, or enable them again in the Actions tab. The watchdog's email goes to whoever last changed its schedule.
5. **Verifier 3, a sealed backup:** this key signs only in an emergency, and nothing runs it day to day. Render and GitHub provide the 2 signatures that normal refunds need. Create it on your machine, and keep it out of `.env`:
   ```
   cast wallet new
   cast wallet import gandiva-verifier-3 --interactive
   ```
   The encrypted file is `~/.foundry/keystores/gandiva-verifier-3`. Keep a copy of it, and its password, somewhere safe away from this machine. To use the key, open a new PowerShell window, then close that window when you are done:
   ```powershell
   $env:VERIFIER_KEY = ((cast wallet decrypt-keystore gandiva-verifier-3) -split ' ')[-1]
   ```
6. **Seed the built-in sellers:** `npm run stake:seed`, with the server running, stakes part of each built-in seller's earnings and then registers `RECEIPT_SIGNER_KEY` for it. Each seller needs at least 0.03 USDC. **It spends testnet USDC:** the bonds, plus 0.02 USDC per seller that goes to your relayer.

## Testing the contract

None of these spend anything. `forge` and `anvil` come from [Foundry](https://getfoundry.sh); run `git submodule update --init` once to get `lib/`. Leave out `--recursive`: nothing here uses OpenZeppelin's own nested libraries, and their long paths can fail on Windows.

| Command | What it checks |
|---|---|
| `forge test` | Every contract rule, fuzzing, and invariants: random call sequences against a plain model, so that the bonds always add up, no claim pays twice and no refund passes the cap |
| `$env:FORK_RPC="https://sepolia.base.org"; forge test` | The same, plus a bond's whole life against the real USDC contract on a local copy of the chain |
| `npm run stake:dry-run` | The deploy script, relayer, claim worker, HTTP routes and outside verifier together on a local copy of the chain: both claim kinds, a veto, a rotation, a refund executed by an outsider, a held withdrawal, a claim on an empty bond, the final balances and the gas of each call. It ends with a drill: 2 stolen verifier keys with the API down, and the backup job paying what is due from the chain alone |
| `npm run stake:compile` | Rebuilds `contracts/SellerStakeV2.json`. Run it after changing the contract; CI fails if the file is stale |

CI runs all of these, plus Slither and Aderyn. The contract has not had a paid audit, so it stays on testnet.

## API

| Route | What it does |
|---|---|
| `GET /registry/stake` | Contract, fees, relayer ETH and book, verifiers, open claims, every listed seller's bond |
| `GET /registry/stake/:address` | One seller's bond, unlock time, receipt signer, `slashable`, slashes |
| `GET /registry/stake/events?seller=` | Stake, unstake, withdraw, receipt-signer and slash events |
| `GET /registry/stake/claims?state=&seller=` | Claims (`state=active` = new, open or proposed) |
| `GET /registry/stake/evidence/:hash` | The evidence bundle exactly as stored |
| `POST /registry/stake/claims/:id/signature` | A verifier's `{ type: "claim" \| "veto", signature }` |
| `POST /registry/stake/claims/:id/rebuttal` | The seller's `{ receipt, body }` for a kind 2 claim |
| `POST /registry/stake/receipt-signer/prepare`, `POST /registry/stake/receipt-signer` | Register a receipt signer (typed data to sign, then the signed result) |

Relayed POSTs are rate-limited per IP and per address.

## Runbook

Start here if the watchdog emails you, or if you think a key has leaked.

| What happened | What it can do | What to do |
|---|---|---|
| The API is down | Nothing is lost. Due refunds still go out through `stake keeper` | Fix the API. The worker adopts what the keeper did |
| A verifier host is down | New refunds wait, and may expire after 1 hour | Fix it, or sign with the sealed key: [Use the sealed key](#use-the-sealed-key) |
| Relayer key stolen | Takes its ETH and collected fees. It cannot touch a bond | [Replace a wallet key](#replace-a-wallet-key) |
| Keeper key stolen | Takes its ETH and fees. It cannot touch a bond | [Replace a wallet key](#replace-a-wallet-key) |
| Receipt signer key stolen | Forges receipts for the built-in sellers | Generate a new key, set it on Render, and run `npm run stake:seed` to register it |
| 1 verifier key stolen | Nothing alone: a slash needs 2 | [Rotate a verifier](#rotate-a-verifier) today |
| 2 verifier keys stolen | Takes up to 0.36 USDC per seller every 30 minutes, and can block every veto and rotation | [Two verifier keys stolen](#two-verifier-keys-stolen) |
| A refund keeps failing | The keeper and watchdog both report it, and the seller cannot withdraw | [A stuck claim](#a-stuck-claim) |

### Use the sealed key

1. Unseal it in a new PowerShell window, as in Setting up, step 5.
2. Set `GANDIVA_URL` and `STAKE_CONTRACT` in the same window.
3. To sign what is open: `npm run verifier -- --once`. For a veto or rotation, use the steps below.
4. Close the window, which clears the key.

### Run a step with the key held on GitHub

A GitHub secret cannot be read back, so its key signs through a workflow. In the Actions tab, open `stake emergency`, then **Run workflow**. Choose an action, and paste the same arguments you would give after `sign` or `send`, separated by spaces. Its log prints the signature. A `-send` action pays gas from the keeper's wallet, so it works with the API down.

### Replace a wallet key

1. Create a new wallet, and send it a little Base Sepolia ETH.
2. Relayer: set `RELAYER_PRIVATE_KEY` on Render, then Manual Deploy. Keeper: change the `KEEPER_KEY` secret on GitHub.
3. If the old key is only exposed, not yet used, move its ETH and USDC to safety first.

No contract change is needed, because neither key has any power over bonds.

### Rotate a verifier

Do this when a verifier key is lost or leaked, or a host moves. 2 of the current 3 verifiers sign the new set; the 3 addresses must be different. With a key stolen, sign with the 2 that are safe: the GitHub key through `stake emergency`, the sealed key on your machine, and Render's by copying its value from the dashboard into a new PowerShell window.

1. On the first verifier's host, with `VERIFIER_KEY` set to its key:
   ```
   npm run stake:rotate -- sign <v1> <v2> <v3>
   ```
   It prints a signature and the exact command for the second verifier, including the deadline (24 h ahead).
2. On the second verifier's host, run that printed command.
3. Where `RELAYER_PRIVATE_KEY` is set, or with the `rotate-send` action of `stake emergency`:
   ```
   npm run stake:rotate -- send <v1> <v2> <v3> <deadline> <sig1> <sig2>
   ```
4. Give the new verifier's key to its host only (Render env, the GitHub secret, or the sealed keystore), and update the `VERIFIER_ADDRESSES` note in `.env`. The server reads the new set within 60 s.

Signatures are safe to share; keys are not. A rotation signed before another rotation is refused.

### Two verifier keys stolen

The contract cannot be saved from this, because whoever holds 2 keys holds the majority: the honest verifier cannot veto or rotate alone. What the limits do is give you time.

1. Tell sellers to press **Request unstake** now. Their bonds lose at most 0.36 USDC every 30 minutes while they wait.
2. Deploy a new contract with new keys, and point `STAKE_CONTRACT` at it.
3. Sellers withdraw from the old contract once their cooldown ends. If the thief keeps claims open to block a withdrawal, that seller's bond stays locked until the bond runs out or the thief stops.

For this reason, run the verifiers on accounts that do not fall to the same stolen password: Render and GitHub should have different passwords and two-factor authentication.

### Refill the relayer

The Stake card and `GET /registry/stake` warn when the relayer holds less than 0.002 ETH. Send Base Sepolia ETH to the relayer address shown there. Until it is refilled, stakes and claims fail and the worker keeps retrying. Nothing is lost.

Fees arrive as USDC, but gas is paid in ETH, so refilling stays a manual job: swap the USDC for ETH, or move it to a safer wallet. The relayer is a hot wallet, so sweep its USDC out now and then. Compare `relayer.gasEth` with `relayer.feesUsdc` to see whether the fees still cover it.

### A stuck claim

**Symptom:** a claim stays `proposed` past its execute time, its `lastError` repeats a revert from `executeSlash`, and the seller cannot withdraw. The server logs `[claims] N open, oldest M min` every 10 minutes. The usual cause is a refund to a buyer that USDC refuses (a blacklisted address).

**Fix:** veto it by hand, so the claim closes and the bond is free again.

1. Find the claim's `claimId` (0x…) in `GET /registry/stake/claims?state=proposed`.
2. On the first verifier's host, with `VERIFIER_KEY` set, or with the `veto-sign` action of `stake emergency`:
   ```
   npm run stake:veto -- sign <claimId>
   ```
3. On the second verifier's host, run the command it printed (same claim id and deadline).
4. Where `RELAYER_PRIVATE_KEY` is set, or with the `veto-send` action of `stake emergency`:
   ```
   npm run stake:veto -- send <claimId> <deadline> <sig1> <sig2>
   ```
5. Within a minute the worker sees the veto on chain and marks the claim `vetoed`. The buyer was not refunded from the bond, so settle with them another way if needed.

## Trade-offs

- Refunds take about 30 minutes plus polling, not seconds.
- A slash takes 2 transactions (propose, then execute).
- 2 verifier processes have to keep running, and scheduled GitHub Actions runs can be late. With the third key sealed, one of them being down holds refunds up until it returns or someone unseals the key.
- Sellers without receipts cannot be slashed.
- A bond smaller than a refund and its fee leaves the relayer short, once, because the buyer is paid first and the bond ends at zero.
- The contract cannot tell a real payment from a made-up one, so 2 stolen verifier keys could take up to 0.36 USDC per seller every 30 minutes (3 claims, each at most 0.10 plus the 0.02 fee). With 2 keys stolen the third verifier cannot veto or rotate alone. See the runbook.
- A seller with many junk calls at once refunds them 3 per window, and claims still waiting at their 1 hour deadline expire unpaid.
- On mainnet the x402.org facilitator is not available. Coinbase's costs nothing for 1,000 transactions a month, then $0.001 each, on the sales this server settles itself. That is separate from these fees.
