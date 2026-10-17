"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useAuth } from "@/components/auth/auth-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { withdrawFromAgent } from "@/lib/api";
import { toUnits } from "@/lib/format";
import { useAgentWallet, useInfo } from "@/lib/hooks";
import { fundAgentWallet, walletErrorMessage } from "@/lib/wallet";
import { PlannerLlmForm } from "./planner-llm-form";
import { SpendCapBar } from "./spend-cap-bar";

type Notice = { tone: "ok" | "bad" | "info"; text: string; href?: string | null };

const TONE = {
  ok: "border-ok/40 bg-ok/10 text-ok",
  bad: "border-bad/40 bg-bad/10 text-bad",
  info: "border-info/40 bg-info/10 text-info",
};

/** The signed-in user's own agent wallet: where the Scout's money comes from. Signed out, runs use the shared demo wallet. */
export function AgentWalletCard() {
  const { address, loading, busy, signIn } = useAuth();
  const { data: info } = useInfo();
  const { data: agent, error, mutate } = useAgentWallet(Boolean(address));
  const [amount, setAmount] = useState("0.1");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [working, setWorking] = useState<"fund" | "withdraw" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [copied, setCopied] = useState(false);

  if (!address) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Your agent wallet</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3 text-sm text-muted-foreground">
          <p>
            Sign in to give your buyer agent its own wallet. You put in a little test USDC, the agent spends only that, and you can take the rest back. Signed out, runs use the shared demo wallet.
          </p>
          {info ? (
            <div className="w-full max-w-md">
              <SpendCapBar cap={info.spendCap} label="Shared demo wallet limit" />
            </div>
          ) : null}
          {!loading ? (
            <Button size="sm" onClick={signIn} disabled={busy}>
              {busy ? "Check your wallet…" : "Connect wallet"}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  const balance = agent?.balance ? Number(agent.balance) : 0;

  async function fund() {
    if (!agent) return;
    const units = toUnits(amount);
    if (!units || Number(units) === 0) return setNotice({ tone: "bad", text: "Enter an amount like 0.1 (USDC)." });
    setWorking("fund");
    setNotice(null);
    try {
      await fundAgentWallet({ agent: agent.address, usdc: agent.asset, units }, (hash) =>
        setNotice({ tone: "info", text: "Sent. Waiting for the network to confirm…", href: `https://sepolia.basescan.org/tx/${hash}` }),
      );
      await mutate();
      setNotice({ tone: "ok", text: `${amount} USDC arrived in your agent wallet.` });
    } catch (e) {
      const msg = walletErrorMessage(e);
      setNotice(msg ? { tone: "bad", text: msg } : null);
    } finally {
      setWorking(null);
    }
  }

  async function withdraw(all: boolean) {
    const units = all ? "all" : toUnits(withdrawAmount);
    if (!units || units === "0") return setNotice({ tone: "bad", text: "Enter an amount like 0.05 (USDC) to withdraw." });
    if (!all && Number(units) > Math.round(balance)) return setNotice({ tone: "bad", text: "Your agent wallet holds less than that." });
    if (all && !window.confirm("Send everything in your agent wallet back to your own wallet?")) return;
    setWorking("withdraw");
    setNotice(null);
    try {
      const w = await withdrawFromAgent(units);
      await mutate();
      setNotice({ tone: "ok", text: `${w.amount_usdc} USDC is on its way back to your wallet.`, href: w.explorer });
    } catch (e) {
      setNotice({ tone: "bad", text: e instanceof Error ? e.message : "Withdrawal failed." });
    } finally {
      setWorking(null);
    }
  }

  async function copy() {
    if (!agent) return;
    try {
      await navigator.clipboard.writeText(agent.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your agent wallet</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? (
          <p className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error instanceof Error ? error.message : "Could not load your agent wallet."}</p>
        ) : !agent ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Runs you start while signed in pay from this wallet</span>
                <div className="flex items-center gap-2">
                  <a href={agent.explorer} target="_blank" rel="noreferrer" className="break-all font-mono text-xs text-primary underline-offset-4 hover:underline">
                    {agent.address}
                  </a>
                  <Button type="button" variant="ghost" size="icon-sm" onClick={copy} aria-label="Copy address">
                    {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                  </Button>
                </div>
                <div className="mt-1 max-w-md">
                  <SpendCapBar cap={agent.spendCap} label="Spend limit" />
                </div>
              </div>
              <div className="flex flex-col items-start sm:items-end">
                <span className="text-xs text-muted-foreground">Balance</span>
                <span className="font-mono text-2xl text-primary">
                  {agent.balanceUsdc ?? "?"} <span className="text-xs text-muted-foreground">USDC</span>
                </span>
                {agent.balanceError ? <span className="text-[11px] text-warn">{agent.balanceError}</span> : null}
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fund-amount" className="text-xs text-muted-foreground">
                  Add funds (USDC)
                </Label>
                <Input id="fund-amount" inputMode="decimal" className="w-28 font-mono" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <Button onClick={fund} disabled={working !== null}>
                {working === "fund" ? "Confirm in your wallet…" : "Send from my wallet"}
              </Button>
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="withdraw-amount" className="text-xs text-muted-foreground">
                  Withdraw (USDC)
                </Label>
                <Input id="withdraw-amount" inputMode="decimal" placeholder="0.05" className="w-28 font-mono" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} />
              </div>
              <Button variant="outline" onClick={() => withdraw(false)} disabled={working !== null || balance === 0 || !withdrawAmount.trim()}>
                {working === "withdraw" ? "Withdrawing…" : "Withdraw"}
              </Button>
              <Button variant="outline" onClick={() => withdraw(true)} disabled={working !== null || balance === 0}>
                Withdraw all
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              Adding funds is a normal USDC transfer from your wallet; it needs a little Base Sepolia ETH for gas. Test USDC: faucet.circle.com. Withdrawing needs no gas and always goes back to the wallet you signed in with.
            </p>

            {notice ? (
              <p className={"rounded-lg border px-3 py-2 text-sm " + TONE[notice.tone]}>
                {notice.text}{" "}
                {notice.href ? (
                  <a href={notice.href} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                    view transaction
                  </a>
                ) : null}
              </p>
            ) : null}

            {agent.withdrawals.length ? (
              <div className="text-xs text-muted-foreground">
                Recent withdrawals:{" "}
                {agent.withdrawals.slice(0, 3).map((w) => (
                  <span key={w.id} className="mr-3 font-mono">
                    {w.amount_usdc} USDC {w.status}
                    {w.explorer ? (
                      <>
                        {" "}
                        <a href={w.explorer} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
                          tx
                        </a>
                      </>
                    ) : null}
                  </span>
                ))}
              </div>
            ) : null}

            <PlannerLlmForm current={agent.plannerLlm} onChanged={() => void mutate()} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
