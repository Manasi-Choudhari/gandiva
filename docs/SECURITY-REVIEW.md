# Security review

Gandiva runs on the Base Sepolia testnet, and no real money is at stake. It is built as if there were, and this page records how that was checked: what was reviewed, what turned up, and what stays open.

**This is a self-review, not an audit.** Nobody independent has looked at this code. It is unaudited, testnet-only, and should not be used with real funds.

## Scope

- `contracts/SellerStakeV2.sol`: every external function, by asking what 1 or 2 stolen keys could do with it
- The money paths on the server: agent wallets and withdrawals, spend caps, run budgets, the x402 buyer and seller code, the relayer, and the claim worker
- The GitHub workflows that hold keys

The threat model for the rest of the system is in [SECURITY.md](../SECURITY.md).

## How it was checked

These ran on the author's machine. CI is set up to repeat them, except the deliberate bugs, and its contract job has not run yet.

| Check | Result |
|---|---|
| Foundry unit, fuzz and invariant tests, including a real-USDC fork | 52 of 52 |
| Deliberate bugs put into the contract, one at a time | Every one caught by a test |
| Slither | 0 findings after triage; it cannot analyse OpenZeppelin's reentrancy guard internals |
| Aderyn | Not yet seen running (report only in CI) |
| Full rehearsal on a local copy of the chain, ending in a stolen-key drill | Passing |
| Node tests | All passing |

## What it found

All of these were found before the contract was deployed, and all are fixed. The High and Medium ones each have a test that fails without the fix.

| Severity | Problem | Fix |
|---|---|---|
| High | **Propose-and-veto loop.** A veto takes a fee from the bond and pays the sender, and it closed the claim at once. 2 stolen keys could repeat propose and veto in a single block and empty a bond with no 30 minute wait. This came in with the fee design. | Each seller has 3 claim slots, and a slot is held for its full 30 minutes even if the claim is vetoed |
| High | **No limit on open claims.** A claim's cap is per claim, and the contract cannot tell a real payment from a made-up one, so 2 stolen keys could open any number of claims and take a whole bond after one window. | The same slots: at most 3 claims per seller in any 30 minutes, so at most 0.36 USDC |
| Medium | **Seller chooses the signing method.** A seller's 402 could ask for Permit2 instead of EIP-3009. The ledger, spend cap and chain resolver all track the EIP-3009 nonce, so such a payment could slip past them. Its extensions could also ask the x402 library to sign a token approval. | Anything but EIP-3009 is refused before signing, and seller extensions are dropped |
| Medium | **Budget overrun through a false failure.** A seller could answer "failed, not charged" while keeping the signed payment, then settle it. The run's budget had already been given back, so one seller could spend a run past its budget, up to the wallet's spend cap. | The money stays reserved after signing unless the outcome is proven. A retry may run out of budget sooner, and that is accepted, because a budget should be a hard limit |
| Medium | **Log search too wide.** When an outsider executed a refund, the server asked the public RPC for 2,000 blocks of logs at once, which it refuses above 200. A local chain has no such limit, so the rehearsal could not show this; it was found by reading similar code and confirmed against the real RPC. | Uses the repository's existing tested chunk size |
| Low | **Other tokens in a listing.** Budgets and caps count USDC units, so another token's amount would mean nothing to them. | Only USDC is paid |
| Low | **Install scripts in jobs that hold keys.** A compromised package could run during install. | `npm ci --ignore-scripts` in those jobs |
| Low | **Relayer totals read every row** on a public route. | Totalled in SQL |

Reviewing the review also found weak tests, which matter as much as bugs:

- A hostile-token test re-entered on every transfer, so it passed for the wrong reason and would not have noticed a missing guard on `vetoSlash`. A deliberate bug exposed this. The token now attacks once.
- The rehearsal signed with the real clock while its chain had been moved hours ahead, so passing depended on a 2 second margin. It now uses the chain's clock.

## Decisions worth explaining

**No pause switch.** A pause is one more power that a stolen key could abuse. A veto stops any single claim, rotation replaces a stolen key, and the claim limit bounds the worst case. Sellers can leave after the cooldown, unless a claim is open against them.

**Fees are fixed at deploy.** Most fee systems follow live gas prices through a price feed. A fixed fee is simpler, and nobody can raise it, but a lasting change in gas prices means a new contract. Above the gas ceiling the relayer pauses seller actions rather than run at a loss, and refunds keep going.

**A veto charges the seller.** Without that, a seller could hold back receipts and rebut every claim at the relayer's expense. The cost is that an innocent seller can lose 0.02 USDC to a lost receipt.

## What stays open

| Limit | Why it stays |
|---|---|
| No independent audit | Paid audits are out of scope for a free-tier project. This is the largest gap before any real use |
| One person holds all 3 verifier keys | They run in 3 separate places with separate keys, but they are not independent of each other. Render and GitHub run 2 of them, so those 2 accounts together are enough for a theft |
| 2 stolen verifier keys cost up to 0.36 USDC per seller every 30 minutes, and can block withdrawals | The contract cannot check payments itself, and the honest verifier cannot act alone |
| Hot keys sit in server environment variables | Hardware or cloud key management is paid. Balances are kept small, and each key has a replacement runbook |
| Agent wallets are custodial | The server holds each user's agent key, encrypted, and `SECRETS_KEY` plus a database copy would open them |
| The shared demo wallet can be spent by anyone when `BUYER_TOKEN` is unset | It is a demo: it is kept unfunded, and a spend cap limits it |
| Evidence bundles are public | A rejected paid call's request and response are published so anyone can re-check a claim. They should not hold private data |
| One server, on a free tier | Rate limits and spend reservations live in memory. Scheduled jobs can run late, and GitHub stops them after 60 days of no activity |
| Fees were measured once | Gas prices move. The watchdog alerts if fees stop covering the relayer's gas |

## What has only run locally

Until the contract is deployed, none of this has run on the real network: the fees, the keeper, the watchdog, or the emergency workflow. The emergency workflow has not run at all, though its input filter was tested against attack strings. A real x402 payment into a claim has never been made on the fee version of the contract.
