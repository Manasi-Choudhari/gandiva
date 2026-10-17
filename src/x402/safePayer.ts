import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { fromUnits, NETWORK } from "../config.js";
import { addLedger, type LedgerEntry, type LedgerStatus, type Service } from "../registry/store.js";
import { slashForJunk } from "../stake/index.js";
import type { BudgetLedger } from "./budget.js";
import { endpointBlockedReason } from "./endpointGuard.js";
import { validate } from "./schema.js";
import { spendCap as sharedCap, type CapReservation, type SpendCap } from "./spendCap.js";

export interface CallResult {
  status: LedgerStatus;
  ok: boolean;
  data?: any;
  txHash?: string;
  asked?: bigint;
  paid: bigint;
  reason?: string;
  latencyMs: number;
  ledgerId: number;
}

type Check = { ok: true; accept: PaymentRequirements } | { ok: false; reason: string };

/** Price check: only sign a 402 whose terms match the registry listing exactly (or ask for less). */
export function checkAgainstListing(service: Service, pr: PaymentRequired): Check {
  if (!pr || typeof pr !== "object") return { ok: false, reason: "402 body is not a payment request" };
  if (pr.x402Version !== 2) return { ok: false, reason: `unsupported x402Version ${pr.x402Version}` };
  if (pr.accepts !== undefined && !Array.isArray(pr.accepts)) return { ok: false, reason: "402 accepts is not a list" };
  const accepts = pr.accepts ?? [];
  if (!accepts.length) return { ok: false, reason: "402 lists no payment options" };
  const listed = BigInt(service.price);
  const problems: string[] = [];
  for (const a of accepts) {
    // A seller controls this JSON: anything malformed is a refusal, never an exception.
    const missing = !a || typeof a !== "object" ? ["the option itself"] : (["scheme", "network", "asset", "payTo", "amount"] as const).filter((k) => typeof a[k] !== "string");
    if (missing.length) {
      problems.push(`payment option is missing ${missing.join(", ")}`);
      continue;
    }
    const p: string[] = [];
    if (a.scheme !== "exact") p.push(`scheme ${a.scheme} is not "exact"`);
    if (a.network !== service.network) p.push(`network ${a.network} differs from listed ${service.network}`);
    if (a.asset.toLowerCase() !== service.asset.toLowerCase()) p.push(`token ${a.asset} differs from listed ${service.asset}`);
    if (a.payTo.toLowerCase() !== service.payTo.toLowerCase()) p.push(`payTo ${a.payTo} differs from listed ${service.payTo}`);
    const amount = /^\d+$/.test(a.amount) ? BigInt(a.amount) : -1n;
    if (amount < 0n) p.push(`amount ${a.amount} is not a valid integer`);
    else if (amount > listed) {
      const ratio = Number(amount) / Number(listed);
      p.push(`asked ${amount} units, ${ratio >= 2 ? ratio.toFixed(ratio % 1 ? 1 : 0) + "x" : "more than"} the listed ${listed}`);
    }
    if (!(a.maxTimeoutSeconds > 0 && a.maxTimeoutSeconds <= 3600)) p.push(`unreasonable maxTimeoutSeconds ${a.maxTimeoutSeconds}`);
    if (!p.length) return { ok: true, accept: a };
    problems.push(p.join(", "));
  }
  return { ok: false, reason: problems[0] };
}

export function buildRequest(service: Pick<Service, "endpoint" | "method">, input: Record<string, unknown>) {
  if (service.method === "GET") {
    const url = new URL(service.endpoint);
    for (const [k, v] of Object.entries(input ?? {})) url.searchParams.set(k, String(v));
    return { url: url.toString(), init: { method: "GET", headers: {} as Record<string, string> } };
  }
  return {
    url: service.endpoint,
    init: { method: service.method, headers: { "Content-Type": "application/json" } as Record<string, string>, body: JSON.stringify(input ?? {}) },
  };
}

async function readBody(res: Response) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Buyer-side x402 v2 payer: 402 -> price check -> budget reservation -> sign (standard SDK) -> retry -> schema check -> ledger. */
/**
 * Live progress of one paid call, reported for UIs: requesting = first request sent; quoted = a 402 arrived and passed the
 * listing, budget and cap checks; settling = the payment is signed and sent, and the seller is working and settling on chain.
 */
export type CallPhase = "requesting" | "quoted" | "settling";
export type OnCallPhase = (phase: CallPhase, asked?: bigint) => void;

export class SafePayer {
  readonly account: PrivateKeyAccount;
  private client: x402Client;
  private withdrawalClient: x402Client;

  /** `cap` is the spend cap this wallet answers to; the default is the shared demo wallet's. */
  constructor(
    privateKey: `0x${string}`,
    readonly cap: SpendCap = sharedCap,
  ) {
    this.account = privateKeyToAccount(privateKey);
    this.client = new x402Client();
    registerExactEvmScheme(this.client, { signer: this.account, networks: [NETWORK] });
    // Purchases keep the x402 library's default cap per payment. A withdrawal is built by our own code and always pays the
    // signed-in owner, so only it may exceed that cap.
    this.withdrawalClient = new x402Client().setSpendControls({ maxAmountPerPayment: false });
    registerExactEvmScheme(this.withdrawalClient, { signer: this.account, networks: [NETWORK] });
  }

  get address() {
    return this.account.address;
  }

  /** Signs a payment for the given 402 terms with this wallet (no network call, nothing is moved until someone settles it). */
  sign(pr: PaymentRequired) {
    return this.client.createPaymentPayload(pr);
  }

  /** Like sign(), for paying the owner back out of the wallet: the library's per-payment cap does not apply. */
  signWithdrawal(pr: PaymentRequired) {
    return this.withdrawalClient.createPaymentPayload(pr);
  }

  async call(
    service: Service,
    input: Record<string, unknown>,
    ctx: { budget: BudgetLedger; runId?: string; timeoutMs?: number; onPhase?: OnCallPhase },
  ): Promise<CallResult> {
    const started = Date.now();
    // Progress reporting is best-effort and must never change what the call does.
    const phase: OnCallPhase = (p, asked) => {
      try {
        ctx.onPhase?.(p, asked);
      } catch {}
    };
    const timeoutMs = ctx.timeoutMs ?? 90_000;
    const base = { runId: ctx.runId, buyer: this.address, seller: service.payTo, serviceId: service.id, serviceName: service.name, endpoint: service.endpoint, listed: service.price };
    let auth: LedgerEntry["auth"] = null;
    let capHold: CapReservation | null = null;
    const finish = (r: Omit<CallResult, "latencyMs" | "ledgerId" | "ok">): CallResult => {
      const latencyMs = Date.now() - started;
      try {
        const row = addLedger({ ...base, asked: r.asked?.toString() ?? null, paid: r.paid.toString(), txHash: r.txHash ?? null, status: r.status, reason: r.reason ?? null, latencyMs, auth });
        // Proven seller fault after taking the money (broke its own schema, or charged for an error): refund from its stake.
        // A lost response body is not proof, since the fault may be on our side of the network.
        if (r.status === "paid_output_rejected" && /^(output breaks listed schema|seller settled but returned)/.test(r.reason ?? "")) {
          void slashForJunk({ ledgerId: row.id, seller: service.payTo, buyer: this.address, paid: r.paid, txHash: r.txHash, service: service.name });
        }
        return { ...r, ok: r.status === "paid", latencyMs, ledgerId: row.id };
      } finally {
        // Only now does the ledger carry this payment, so only now can the wallet cap stop counting it as in flight.
        capHold?.release();
      }
    };

    let url: string;
    let init: RequestInit & { headers: Record<string, string> };
    try {
      ({ url, init } = buildRequest(service, input));
    } catch (err: any) {
      return finish({ status: "refused", paid: 0n, reason: `bad endpoint: ${err?.message ?? err}` });
    }
    // Checked again on every call: a listing's DNS can be changed after it was accepted.
    const blocked = await endpointBlockedReason(url);
    if (blocked) return finish({ status: "refused", paid: 0n, reason: `endpoint guard: ${blocked}` });
    phase("requesting");
    let first: Response;
    try {
      // Never follow redirects: a public endpoint could bounce us to an internal address.
      first = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch (err: any) {
      return finish({ status: "failed_not_charged", paid: 0n, reason: `unreachable: ${err?.message ?? err}` });
    }

    if (first.status !== 402) {
      const body = await readBody(first);
      if (first.ok) return finish({ status: "failed_not_charged", paid: 0n, data: body, reason: "seller did not ask for payment (expected 402)" });
      return finish({ status: "failed_not_charged", paid: 0n, reason: `seller returned ${first.status} before payment: ${JSON.stringify(body).slice(0, 200)}` });
    }

    const header = first.headers.get("PAYMENT-REQUIRED");
    let pr: PaymentRequired;
    try {
      pr = header ? decodePaymentRequiredHeader(header) : await first.json();
    } catch {
      return finish({ status: "refused", paid: 0n, reason: "402 without a decodable PAYMENT-REQUIRED header" });
    }

    const check = checkAgainstListing(service, pr);
    const firstAmount = Array.isArray(pr?.accepts) ? pr.accepts[0]?.amount : undefined;
    const askedGuess = typeof firstAmount === "string" && /^\d+$/.test(firstAmount) ? BigInt(firstAmount) : undefined;
    if (!check.ok) return finish({ status: "refused", paid: 0n, asked: askedGuess, reason: `price check: ${check.reason}` });
    const asked = BigInt(check.accept.amount);

    const reservation = await ctx.budget.reserve(asked);
    if (!reservation) {
      return finish({
        status: "refused",
        paid: 0n,
        asked,
        reason: `budget: needs ${fromUnits(asked)} USDC but only ${fromUnits(ctx.budget.remaining)} of ${fromUnits(ctx.budget.budget)} is left`,
      });
    }

    capHold = await this.cap.reserve(asked);
    if (!capHold) {
      reservation.release();
      const s = this.cap.status();
      return finish({ status: "refused", paid: 0n, asked, reason: `spend cap: wallet limit ${s.limitUsdc} USDC per ${s.windowMinutes} min reached (${s.usedUsdc} used); needs ${fromUnits(asked)}` });
    }
    phase("quoted", asked);

    let paidRes: Response;
    let payload: Awaited<ReturnType<x402Client["createPaymentPayload"]>>;
    try {
      payload = await this.client.createPaymentPayload({ ...pr, accepts: [check.accept] });
    } catch (err: any) {
      // Nothing was signed, so nothing can have moved.
      reservation.release();
      return finish({ status: "failed_not_charged", paid: 0n, asked, reason: `could not sign the payment: ${err?.message ?? err}` });
    }
    const a = (payload.payload as any)?.authorization;
    if (a?.from && a?.nonce && a?.validBefore) auth = { from: String(a.from), nonce: String(a.nonce), validBefore: Number(a.validBefore), signedAt: Math.floor(Date.now() / 1000) };
    phase("settling", asked);
    try {
      paidRes = await fetch(url, {
        ...init,
        redirect: "manual",
        headers: { ...init.headers, "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: any) {
      // The signature left our hands and we never saw the answer: the seller may have settled. Keep the money reserved and
      // let the chain decide (resolver); do not claim "not charged" without proof.
      reservation.commit();
      return finish({ status: "unconfirmed", paid: 0n, asked, reason: `no answer after signing, outcome pending chain check: ${err?.message ?? err}` });
    }

    let settle: SettleResponse | undefined;
    const respHeader = paidRes.headers.get("PAYMENT-RESPONSE");
    if (respHeader) {
      try {
        settle = decodePaymentResponseHeader(respHeader);
      } catch {}
    }
    const charged = Boolean(settle?.success);
    let body: any;
    try {
      body = await readBody(paidRes);
    } catch (err: any) {
      // Headers arrived but the body did not (timeout / dropped connection): same ambiguity as a missing answer.
      if (charged) {
        reservation.commit();
        return finish({ status: "paid_output_rejected", paid: asked, asked, txHash: settle!.transaction, reason: `seller settled but the response body was lost: ${err?.message ?? err}` });
      }
      reservation.commit();
      return finish({ status: "unconfirmed", paid: 0n, asked, reason: `response body lost after signing, outcome pending chain check: ${err?.message ?? err}` });
    }

    if (!paidRes.ok) {
      if (charged) {
        reservation.commit();
        return finish({ status: "paid_output_rejected", paid: asked, asked, txHash: settle!.transaction, reason: `seller settled but returned ${paidRes.status}` });
      }
      reservation.release();
      let msg = typeof body === "object" && body?.error ? body.error : JSON.stringify(body).slice(0, 200);
      const again = paidRes.headers.get("PAYMENT-REQUIRED");
      if (again) {
        try {
          msg = decodePaymentRequiredHeader(again).error ?? msg;
        } catch {}
      }
      // A 402 to a signed request means the payment itself was rejected (e.g. buyer balance), not a seller fault.
      if (paidRes.status === 402) return finish({ status: "failed_not_charged", paid: 0n, asked, reason: `payment rejected: ${msg}` });
      return finish({ status: "failed_not_charged", paid: 0n, asked, reason: `seller returned ${paidRes.status}: ${msg}` });
    }

    reservation.commit();
    if (!charged) {
      // A 200 with no (or unsuccessful) PAYMENT-RESPONSE proves nothing about settlement. Never record a payment we cannot
      // show a tx for: park it as unconfirmed (budget stays spent) and let the chain say whether it was paid.
      return finish({ status: "unconfirmed", paid: 0n, asked, data: body, reason: "200 without a successful PAYMENT-RESPONSE; settlement pending chain check" });
    }
    const out = validate(service.outputSchema, body);
    if (!out.ok) {
      return finish({ status: "paid_output_rejected", paid: asked, asked, txHash: settle?.transaction, reason: `output breaks listed schema: ${out.error}` });
    }
    return finish({ status: "paid", paid: asked, asked, data: body, txHash: settle?.transaction });
  }
}
