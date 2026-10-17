import { db } from "../db.js";

/** Where one input field of a step comes from: the buyer's request, a fixed value, or an earlier step's output. */
export type Source = { from: "buyer"; field: string } | { from: "fixed"; value: unknown } | { from: "step"; step: number; field: string };

export interface ChainStep {
  serviceId: string;
  input: Record<string, Source>;
  /** canonical([category, inputSchema, outputSchema]) of the chosen seller when the chain was saved: any verified seller with the same key can stand in. */
  key: string;
}

export interface Chain {
  serviceId: string;
  /** Signed-in wallet that owns the listing (lower case); its agent wallet pays the steps and receives the earnings. */
  owner: string;
  steps: ChainStep[];
  /** Most this chain may spend on its steps for one request, in USDC units. */
  subBudget: bigint;
}

const rowToChain = (r: any): Chain => ({ serviceId: r.service_id, owner: r.owner, steps: JSON.parse(r.steps_json), subBudget: BigInt(r.sub_budget) });

export const getChain = (serviceId: string): Chain | undefined => {
  const r = db.prepare("SELECT * FROM chain_sellers WHERE service_id = ?").get(serviceId);
  return r ? rowToChain(r) : undefined;
};

/** Chains are never hired by other chains (or by travel-brief), so a chain is always one level deep. */
export const isChainService = (serviceId: string): boolean => Boolean(db.prepare("SELECT 1 FROM chain_sellers WHERE service_id = ?").get(serviceId));

export const listChainsByOwner = (wallet: string): Chain[] =>
  db.prepare("SELECT * FROM chain_sellers WHERE owner = ? ORDER BY created_at DESC").all(wallet.toLowerCase()).map(rowToChain);

export function upsertChain(c: Chain) {
  db.prepare(
    `INSERT INTO chain_sellers (service_id, owner, steps_json, sub_budget) VALUES (?,?,?,?)
     ON CONFLICT(service_id) DO UPDATE SET steps_json=excluded.steps_json, sub_budget=excluded.sub_budget`,
  ).run(c.serviceId, c.owner.toLowerCase(), JSON.stringify(c.steps), c.subBudget.toString());
}
