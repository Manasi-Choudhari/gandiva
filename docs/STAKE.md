# Seller stake (SellerStakeV2)

Sellers can lock testnet USDC as a bond behind their listings. If a seller is paid and sends back junk, the bond refunds that buyer. No single key can take a bond: a refund needs signatures from 2 of 3 independent verifiers, is capped, and waits out a window in which it can still be vetoed.

- Contract: `contracts/SellerStakeV2.sol` (Base Sepolia, testnet only; signatures, EIP-712 and token calls from OpenZeppelin)
- Contract tests and deploy script: `foundry/`, built with Foundry
- Server: `src/stake/` (relayer, claims worker, receipts, evidence, verifier checks)
- Outside verifier: `scripts/verifier.ts`, run on a schedule by `.github/workflows/verifier.yml`
- UI: the **Stake** card on the Sell tab

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
| Gas | Paid by the relayer. The relayer has no powers: it only submits what sellers or verifiers signed |

Staking, unstaking and registering a receipt signer are wallet signatures (EIP-712). The seller pays no gas and needs no ETH.

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
6. **Execute or veto.** With 2 veto signatures, the relayer calls `vetoSlash`. Otherwise, after the wait, it calls `executeSlash`: the contract sends the refund to the buyer and emits `Slashed`.

The worker retries every chain call with backoff (30 s doubling, up to 30 min). Before every send it reads the claim's on-chain state, so nothing is sent twice. A veto or execute that landed some other way is adopted.

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
   - `RELAYER_PRIVATE_KEY`: pays gas. Send it about 0.01 Base Sepolia ETH.
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
   The script refuses every chain except Base Sepolia. Put the address it prints in `STAKE_CONTRACT`, and commit the record it writes under `foundry/broadcast/`.
3. **Server (verifier 1):** on Render, set `STAKE_CONTRACT`, `RELAYER_PRIVATE_KEY`, `RECEIPT_SIGNER_KEY` and `SERVER_VERIFIER_KEY`, then deploy. Without `RELAYER_PRIVATE_KEY` staking stays off.
4. **GitHub Actions (verifier 2):** in Settings, Secrets and variables, Actions:
   - secret `VERIFIER_KEY`;
   - variable `GANDIVA_URL` (the API's public URL);
   - variable `STAKE_CONTRACT`.

   The workflow runs every 5 minutes, and is skipped while `STAKE_CONTRACT` is empty. Scheduled runs can start late.
5. **Your machine (verifier 3):** `npm run verifier` checks every 60 s, or `npm run verifier -- --once` runs one pass. Set `VERIFIER_KEY`, `STAKE_CONTRACT` and `GANDIVA_URL`.
6. **Seed the built-in sellers:** `npm run stake:seed`, with the server running, registers `RECEIPT_SIGNER_KEY` for each built-in seller and stakes part of its earnings. **It spends testnet USDC.**

## Testing the contract

None of these spend anything. `forge` and `anvil` come from [Foundry](https://getfoundry.sh); clone with `--recurse-submodules`, or run `git submodule update --init`, to get `lib/`.

| Command | What it checks |
|---|---|
| `forge test` | Every contract rule, fuzzing, and invariants: random call sequences against a plain model, so that the bonds always add up, no claim pays twice and no refund passes the cap |
| `$env:FORK_RPC="https://sepolia.base.org"; forge test` | The same, plus a bond's whole life against the real USDC contract on a local copy of the chain |
| `npm run stake:dry-run` | The deploy script, relayer, claim worker, HTTP routes and outside verifier together on a local copy of the chain: both claim kinds, a veto, a rotation, a held withdrawal, and the final balances |
| `npm run stake:compile` | Rebuilds `contracts/SellerStakeV2.json`. Run it after changing the contract; CI fails if the file is stale |

CI runs all of these, plus Slither and Aderyn. The contract has not had a paid audit, so it stays on testnet.

## API

| Route | What it does |
|---|---|
| `GET /registry/stake` | Contract, relayer ETH, verifiers, open claims, every listed seller's bond |
| `GET /registry/stake/:address` | One seller's bond, unlock time, receipt signer, `slashable`, slashes |
| `GET /registry/stake/events?seller=` | Stake, unstake, withdraw, receipt-signer and slash events |
| `GET /registry/stake/claims?state=&seller=` | Claims (`state=active` = new, open or proposed) |
| `GET /registry/stake/evidence/:hash` | The evidence bundle exactly as stored |
| `POST /registry/stake/claims/:id/signature` | A verifier's `{ type: "claim" \| "veto", signature }` |
| `POST /registry/stake/claims/:id/rebuttal` | The seller's `{ receipt, body }` for a kind 2 claim |
| `POST /registry/stake/receipt-signer/prepare`, `POST /registry/stake/receipt-signer` | Register a receipt signer (typed data to sign, then the signed result) |

Relayed POSTs are rate-limited per IP and per address.

## Runbook

### Rotate a verifier

Do this when a verifier key is lost or leaked, or a host moves. 2 of the current 3 verifiers sign the new set; the 3 addresses must be different.

1. On the first verifier's host, with `VERIFIER_KEY` set to its key:
   ```
   npm run stake:rotate -- sign <v1> <v2> <v3>
   ```
   It prints a signature and the exact command for the second verifier, including the deadline (24 h ahead).
2. On the second verifier's host, run that printed command.
3. Where `RELAYER_PRIVATE_KEY` is set:
   ```
   npm run stake:rotate -- send <v1> <v2> <v3> <deadline> <sig1> <sig2>
   ```
4. Give the new verifier's key to its host only (Render env, the GitHub secret, or your machine), and update the `VERIFIER_ADDRESSES` note in `.env`. The server reads the new set within 60 s.

Signatures are safe to share; keys are not. A rotation signed before another rotation is refused.

### Refill the relayer

The Stake card and `GET /registry/stake` warn when the relayer holds less than 0.002 ETH. Send Base Sepolia ETH to the relayer address shown there. Until it is refilled, stakes and claims fail and the worker keeps retrying. Nothing is lost.

### A stuck claim

**Symptom:** a claim stays `proposed` past its execute time, its `lastError` repeats a revert from `executeSlash`, and the seller cannot withdraw. The server logs `[claims] N open, oldest M min` every 10 minutes. The usual cause is a refund to a buyer that USDC refuses (a blacklisted address).

**Fix:** veto it by hand, so the claim closes and the bond is free again.

1. Find the claim's `claimId` (0x…) in `GET /registry/stake/claims?state=proposed`.
2. On the first verifier's host, with `VERIFIER_KEY` set:
   ```
   npm run stake:veto -- sign <claimId>
   ```
3. On the second verifier's host, run the command it printed (same claim id and deadline).
4. Where `RELAYER_PRIVATE_KEY` is set:
   ```
   npm run stake:veto -- send <claimId> <deadline> <sig1> <sig2>
   ```
5. Within a minute the worker sees the veto on chain and marks the claim `vetoed`. The buyer was not refunded from the bond, so settle with them another way if needed.

## Trade-offs

- Refunds take about 30 minutes plus polling, not seconds.
- A slash takes 2 transactions (propose, then execute).
- 3 verifier processes have to keep running, and scheduled GitHub Actions runs can be late.
- Sellers without receipts cannot be slashed.
