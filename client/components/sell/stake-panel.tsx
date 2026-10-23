"use client";

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { KeyRoundIcon, LandmarkIcon, LockOpenIcon, ShieldCheckIcon, UndoIcon } from "lucide-react";
import { fetcher } from "@/lib/api";
import { useStake } from "@/lib/hooks";
import { signTypedDataWithWallet, walletErrorMessage, type TypedDataRequest } from "@/lib/wallet";
import type { StakeClaim, StakePosition } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TxLink, AddrLink } from "@/components/tx-link";
import { clock, usdc } from "@/lib/format";
import { useNow } from "@/lib/clock";

interface StakeEvent {
  id: number;
  ts: string;
  kind: "stake" | "unstake" | "withdraw" | "slash" | "receipt-signer";
  amount: string;
  tx_hash: string | null;
  status: string;
  counterparty: string | null;
  note: string | null;
}

const FIELD =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";
const TILE = "rounded-xl border border-border bg-card/60 px-4 py-3";
const TILE_LABEL = "text-[11px] uppercase tracking-widest text-muted-foreground";

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(data?.error || `request failed (${res.status})`);
  return data as T;
}

const left = (untilMs: number, nowMs: number) => {
  const s = Math.max(0, Math.round((untilMs - nowMs) / 1000));
  return s >= 60 ? `${Math.ceil(s / 60)} min` : `${s} s`;
};

/** Where a claim stands, in words. */
function claimStatus(c: StakeClaim, nowMs: number): { text: string; tone: "bad" | "warn" | "muted" } {
  switch (c.state) {
    case "new":
    case "open":
      return { text: `checking: ${c.signatures.length} of 2 verifier signatures`, tone: "warn" };
    case "proposed":
      if (c.rebuttal && c.vetoDeadline) return { text: `rebutted; verifiers can veto for ${left(c.vetoDeadline * 1000, nowMs)}`, tone: "warn" };
      return { text: c.executeAfter && c.executeAfter > nowMs ? `refund in ${left(c.executeAfter, nowMs)}` : "refund due now", tone: "bad" };
    case "executed":
      return { text: `refunded ${usdc(c.paid)} USDC to the buyer`, tone: "bad" };
    case "vetoed":
      return { text: "vetoed: no refund", tone: "muted" };
    case "expired":
      return { text: "expired before it reached the chain", tone: "muted" };
    case "rejected":
      return { text: "rejected by the verifiers' check", tone: "muted" };
    case "not_slashable":
      return { text: "not slashable (no receipt signer at the time)", tone: "muted" };
    case "no_bond":
      return { text: "closed: no bond left to refund from", tone: "muted" };
  }
}

/** A typed USDC amount in units, or null while it is not a number. */
const toUnits = (amount: string) => (/^\d+(\.\d{1,6})?$/.test(amount.trim()) ? Math.round(Number(amount) * 1_000_000) : null);

/**
 * The seller's bond in SellerStakeV2. Staking, unstaking and the receipt signer are signatures only (no gas); the registry
 * relays them and earns a fee for it. A bond is slashable only with a receipt signer: then 2 of 3 verifiers can refund a
 * buyer who paid for junk.
 */
export function StakePanel({ wallet }: { wallet: string }) {
  const { data: overview } = useStake();
  const { data: pos, mutate } = useSWR<StakePosition & { slashedCount: number; slashed: string }>(`/registry/stake/${wallet}`, fetcher, { refreshInterval: 10000 });
  const { data: events, mutate: mutateEvents } = useSWR<{ events: StakeEvent[] }>(`/registry/stake/events?seller=${wallet}`, fetcher, { refreshInterval: 10000 });
  const { data: claims, mutate: mutateClaims } = useSWR<{ claims: StakeClaim[] }>(`/registry/stake/claims?seller=${wallet}`, fetcher, { refreshInterval: 10000 });
  const [amount, setAmount] = useState("0.07"); // 0.05 bond (full stake points) + the 0.02 fee
  const [signer, setSigner] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const nowMs = useNow(5000);

  if (!overview) return null;
  if (!overview.enabled) {
    return <p className="text-sm text-muted-foreground">Staking is not switched on for this server yet (the SellerStakeV2 contract has not been deployed).</p>;
  }

  const now = nowMs / 1000;
  const unlocking = Boolean(pos?.unlockAt);
  const unlocked = unlocking && now >= (pos?.unlockAt ?? 0);
  const refresh = () => Promise.all([mutate(), mutateEvents(), mutateClaims()]);
  const validSigner = /^0x[0-9a-fA-F]{40}$/.test(signer.trim());
  const stakeFee = Number(overview.stakeFee ?? 0);
  const slashFee = Number(overview.slashFee ?? 0);
  const minStake = Number(overview.minStake ?? 0);
  const units = toUnits(amount);
  const enough = units !== null && units >= minStake;

  async function run(label: string, fn: () => Promise<{ txHash: string }>) {
    setBusy(label);
    try {
      const r = await fn();
      toast.success(`${label} confirmed`, { description: `tx ${r.txHash.slice(0, 10)}…` });
      await refresh();
      return true;
    } catch (err) {
      const msg = walletErrorMessage(err);
      if (msg) toast.error(`${label} failed`, { description: msg });
      return false;
    } finally {
      setBusy(null);
    }
  }

  const stake = () =>
    run("Stake", async () => {
      const typed = await post<TypedDataRequest & { message: Record<string, string> }>("/registry/stake/prepare", { seller: wallet, amount });
      const { signature } = await signTypedDataWithWallet(typed);
      return post("/registry/stake", { ...typed.message, signature });
    });

  const unstake = () =>
    run("Unstake request", async () => {
      const typed = await post<TypedDataRequest & { message: { deadline: string } }>("/registry/stake/unstake/prepare", { seller: wallet });
      const { signature } = await signTypedDataWithWallet(typed);
      return post("/registry/stake/unstake", { seller: wallet, deadline: typed.message.deadline, signature });
    });

  const withdraw = () => run("Withdraw", () => post("/registry/stake/withdraw", { seller: wallet }));

  const registerSigner = async () => {
    const address = signer.trim();
    const ok = await run("Receipt signer", async () => {
      const typed = await post<TypedDataRequest & { message: { deadline: string } }>("/registry/stake/receipt-signer/prepare", { seller: wallet, signer: address });
      const { signature } = await signTypedDataWithWallet(typed);
      return post("/registry/stake/receipt-signer", { seller: wallet, signer: address, deadline: typed.message.deadline, signature });
    });
    if (ok) setSigner("");
  };

  const recent = claims?.claims.slice(0, 8) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Lock USDC behind your listings. Buyers rank staked sellers as more credible. If you are paid and return output that breaks your own schema, 2 of 3
        independent verifiers can refund that buyer from your bond: at most 0.10 USDC per call, after a 30 min wait in which they can still veto it. Staking
        is a signature in your wallet: no gas, the registry relays it for a {usdc(overview.stakeFee)} USDC fee taken from each stake, which also covers your
        unstake and withdraw. Each claim that reaches the chain takes {usdc(overview.slashFee)} USDC more from your bond, even if it is vetoed, after any
        refund to the buyer. Unstaking has a {Math.round((overview.cooldownSeconds ?? 0) / 60)} min cooldown so a bond can&apos;t be pulled ahead of a refund.
      </p>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {pos ? (
          pos.slashable ? (
            <Badge className="border-ok/40 bg-ok/10 text-ok">
              <ShieldCheckIcon /> Slashable
            </Badge>
          ) : (
            <Badge variant="outline" className="border-warn/40 bg-warn/10 text-warn">
              Credibility only
            </Badge>
          )
        ) : null}
        <span className="text-xs text-muted-foreground">
          {pos?.slashable
            ? "your bond backs every paid call, so it earns full stake points (up to 20)"
            : "no receipt signer yet: nobody can slash this bond, so it earns at most 10 of 20 stake points"}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className={TILE}>
          <div className={TILE_LABEL}>your bond</div>
          <div className="mt-1 font-mono text-xl">{pos ? usdc(pos.staked) : "…"} USDC</div>
          <div className="text-xs text-muted-foreground">
            {unlocking ? (unlocked ? "unlocked, ready to withdraw" : `unstaking, unlocks ${new Date((pos?.unlockAt ?? 0) * 1000).toLocaleTimeString()}`) : "locked"}
          </div>
          {unlocking ? <div className="mt-1 text-xs text-warn">Stake points are 0 while unstaking. Staking again cancels it.</div> : null}
        </div>
        <div className={TILE}>
          <div className={TILE_LABEL}>refunded to buyers</div>
          <div className="mt-1 font-mono text-xl">{pos ? usdc(pos.slashed) : "…"} USDC</div>
          <div className="text-xs text-muted-foreground">{pos?.slashedCount ?? 0} junk call(s), 5 stake points each</div>
        </div>
        <div className={TILE}>
          <div className={TILE_LABEL}>contract</div>
          <div className="mt-1 font-mono text-sm">{overview.contract ? <AddrLink address={overview.contract} /> : "…"}</div>
          <div className="text-xs text-muted-foreground">all sellers: {overview.totalStakedUsdc} USDC</div>
          <div className="mt-2 text-[11px] text-muted-foreground">verifiers (2 of 3 must sign)</div>
          <ul className="font-mono text-xs">
            {(overview.verifiers ?? []).map((v) => (
              <li key={v}>
                <AddrLink address={v} />
              </li>
            ))}
          </ul>
          {overview.relayer ? (
            <div className={"mt-2 text-xs " + (overview.relayer.low ? "text-warn" : "text-muted-foreground")}>
              relayer <AddrLink address={overview.relayer.address} />: {Number(overview.relayer.eth).toFixed(4)} ETH
              {overview.relayer.low ? " (low: stakes and refunds stall when it runs out)" : ""}
              <div>
                {overview.relayer.txs} transactions: {Number(overview.relayer.gasEth).toFixed(6)} ETH of gas, {overview.relayer.feesUsdc} USDC of fees
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="stake-amount">Amount (USDC)</Label>
          <Input id="stake-amount" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-32 font-mono" inputMode="decimal" />
        </div>
        <Button onClick={stake} disabled={Boolean(busy) || !enough}>
          <LandmarkIcon /> {busy === "Stake" ? "Sign in your wallet…" : "Stake"}
        </Button>
        <Button variant="outline" onClick={unstake} disabled={Boolean(busy) || !pos || pos.staked === "0" || unlocking}>
          <UndoIcon /> {busy === "Unstake request" ? "Sign in your wallet…" : "Request unstake"}
        </Button>
        <Button variant="outline" onClick={withdraw} disabled={Boolean(busy) || !unlocked}>
          <LockOpenIcon /> Withdraw
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {enough
          ? `${usdc(String(units! - stakeFee))} USDC goes to your bond and ${usdc(String(stakeFee))} USDC is the fee. `
          : `The smallest stake is ${usdc(String(minStake))} USDC, fee included. `}
        A later claim takes up to {usdc(String(slashFee))} USDC from the bond on top of any refund. Your wallet needs the USDC itself (Base Sepolia,
        faucet.circle.com). It does not need ETH.
      </p>

      <div className="flex flex-col gap-2 rounded-xl border border-border px-4 py-3">
        <div className="text-sm font-medium">Receipt signer</div>
        <p className="text-xs text-muted-foreground">
          {pos?.receiptSigner ? (
            <>
              Your server signs receipts with <AddrLink address={pos.receiptSigner} />. Registering another key replaces it; it cannot be removed.
            </>
          ) : (
            "None yet. Your server signs an X-Gandiva-Receipt for each paid call with this key, so verifiers can tell junk from a buyer's false claim."
          )}
        </p>
        <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          Register only a key your server really signs receipts with. A paid call that comes back without a valid receipt becomes a claim, and you can only
          rebut it with a receipt from this key.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="receipt-signer">Signer address</Label>
            <Input id="receipt-signer" value={signer} onChange={(e) => setSigner(e.target.value)} placeholder="0x…" className="font-mono" spellCheck={false} />
          </div>
          <Button variant="outline" onClick={registerSigner} disabled={Boolean(busy) || !validSigner}>
            <KeyRoundIcon /> {busy === "Receipt signer" ? "Sign in your wallet…" : pos?.receiptSigner ? "Replace signer" : "Register signer"}
          </Button>
        </div>
      </div>

      {recent.length ? (
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium">Claims against you</div>
          <ul className="flex flex-col gap-2">
            {recent.map((c) => {
              const st = claimStatus(c, nowMs);
              const rebuttable = c.kind === 2 && !c.rebuttal && (c.state === "open" || (c.state === "proposed" && (c.executeAfter ?? 0) > nowMs));
              return (
                <li key={c.id} className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2 font-mono text-[11px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">#{c.id}</span>
                    <span className="text-muted-foreground">{clock(new Date(c.createdAt).toISOString())}</span>
                    <span>{c.kind === 1 ? "broken output (your receipt)" : c.kind === 2 ? "no valid receipt" : "unchecked"}</span>
                    {c.amount ? <span>{usdc(c.amount)} USDC</span> : null}
                    <span className={st.tone === "bad" ? "text-bad" : st.tone === "warn" ? "text-warn" : "text-muted-foreground"}>{st.text}</span>
                    {c.proposeTx ? (
                      <span className="text-muted-foreground">
                        proposed <TxLink hash={c.proposeTx} />
                      </span>
                    ) : null}
                    {c.closeTx ? (
                      <span className="text-muted-foreground">
                        {c.state === "vetoed" ? "vetoed" : "refunded"} <TxLink hash={c.closeTx} />
                      </span>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground">
                    buyer <AddrLink address={c.buyer} />
                  </div>
                  {rebuttable ? <RebutForm claim={c} onDone={refresh} /> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {events?.events.length ? (
        <ul className="flex flex-col gap-1 font-mono text-[11px]">
          {events.events.slice(0, 8).map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">{clock(e.ts)}</span>
              <span className={e.kind === "slash" ? "text-bad" : "text-foreground"}>{e.kind}</span>
              {e.amount !== "0" ? <span>{usdc(e.amount)} USDC</span> : null}
              {e.kind === "slash" && e.counterparty ? (
                <span className="text-muted-foreground">
                  refunded to <AddrLink address={e.counterparty} />
                </span>
              ) : null}
              {e.kind === "receipt-signer" && e.counterparty ? (
                <span className="text-muted-foreground">
                  now <AddrLink address={e.counterparty} />
                </span>
              ) : null}
              <span className="text-muted-foreground">{e.status}</span>
              {e.tx_hash ? <TxLink hash={e.tx_hash} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A kind 2 claim says no valid receipt came back. The seller answers with the receipt and the exact body it sent. */
function RebutForm({ claim, onDone }: { claim: StakeClaim; onDone: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [receipt, setReceipt] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <Button variant="outline" size="sm" className="w-fit font-sans" onClick={() => setOpen(true)}>
        Rebut
      </Button>
    );
  }

  const submit = async () => {
    setBusy(true);
    try {
      await post(`/registry/stake/claims/${claim.id}/rebuttal`, { receipt: receipt.trim(), body });
      toast.success("Rebuttal accepted", { description: "The claim is dropped, or the verifiers can veto it before the slash window ends." });
      setOpen(false);
      await onDone();
    } catch (err) {
      toast.error("Rebuttal refused", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1 flex flex-col gap-2 font-sans">
      <p className="text-xs text-muted-foreground">Paste the X-Gandiva-Receipt header your server sent for this call, and the response body exactly as sent.</p>
      <Label htmlFor={`rebut-receipt-${claim.id}`} className="text-xs">
        Receipt header
      </Label>
      <textarea id={`rebut-receipt-${claim.id}`} rows={2} spellCheck={false} className={FIELD + " resize-y font-mono text-xs"} value={receipt} onChange={(e) => setReceipt(e.target.value)} />
      <Label htmlFor={`rebut-body-${claim.id}`} className="text-xs">
        Response body
      </Label>
      <textarea id={`rebut-body-${claim.id}`} rows={5} spellCheck={false} className={FIELD + " resize-y font-mono text-xs"} value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={busy || !receipt.trim() || !body}>
          {busy ? "Checking…" : "Send rebuttal"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
