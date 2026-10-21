export type Category = "data" | "inference" | "scraping";

export type LedgerStatus =
  | "paid"
  | "paid_output_rejected"
  | "refused"
  | "failed_not_charged"
  | "unconfirmed";

export interface Reputation {
  attempts: number;
  successes: number;
  successRate: number;
  medianLatencyMs: number | null;
  score: number;
  isNew: boolean;
}

export interface Service {
  id: string;
  name: string;
  category: Category;
  endpoint: string;
  method: "GET" | "POST";
  price: string;
  network: string;
  asset: string;
  payTo: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  description: string;
  owner: string;
  /** What probing the endpoint's real 402 found: verified = matches the listing, mismatch = contradicts it, unchecked = could not tell. */
  verification: "verified" | "mismatch" | "unchecked";
  verificationNote: string;
  verifiedAt: string | null;
  reputation: Reputation;
  /** Summary of the no-KYC credibility checks; null until the server has scored the listing. */
  credibility?: { score: number; level: CredibilityLevel } | null;
  /** Set when this listing is an agent chain: the sellers it hires and pays to do the job. */
  chain?: { hires: string[] } | null;
  /** What the listing is: a chain (hires and pays other sellers), an AI agent (hosted LLM seller) or a data API (everything else). */
  kind?: Kind;
}

export type Kind = "chain" | "agent" | "data";

export type CredibilityLevel = "high" | "medium" | "low" | "unproven";

export interface CredibilityCheck {
  id: "protocol" | "ownership" | "track_record" | "stake" | "wallet_history" | "transport" | "tenure";
  label: string;
  status: "pass" | "partial" | "fail" | "unknown";
  points: number;
  max: number;
  detail: string;
}

export interface Credibility {
  score: number;
  level: CredibilityLevel;
  checks: CredibilityCheck[];
  computedAt: string;
}

export interface StakePosition {
  staked: string;
  stakedUsdc: string;
  unlockAt: number;
  /** Key that signs the seller's receipts; null = none registered. */
  receiptSigner: string | null;
  /** A receipt signer is registered, so 2 of 3 verifiers can slash the bond for junk. */
  slashable: boolean;
}

export type CompareMetric = "reputation" | "successRate" | "cheapness" | "speed" | "credibility" | "stake";

export interface CompareCandidate {
  rank: number;
  id: string;
  name: string;
  owner: string;
  payTo: string;
  price: string;
  priceUsdc: string;
  verification: Service["verification"];
  verificationNote: string;
  reputation: Reputation;
  credibility: Credibility | null;
  stake: StakePosition;
  history: { ts: string; status: LedgerStatus; latencyMs: number }[];
  metrics: Record<CompareMetric, number>;
}

export interface CompareResponse {
  category: Category;
  scope: string;
  otherInCategory: number;
  rules: string[];
  candidates: CompareCandidate[];
  decisions: { ahead: string; behind: string; rule: "verification" | "reputation" | "price" | "credibility" | "latency" | "tie"; detail: string }[];
  selection: { id: string; rank: number; verdict: string } | null;
}

export interface StakeOverview {
  enabled: boolean;
  contract?: string;
  /** Pays the gas for every relayed call; it has no powers over the bonds. */
  relayer?: { address: string; eth: string; low: boolean };
  verifiers?: string[];
  claims?: { open: number; oldestOpenMinutes: number | null };
  cooldownSeconds?: number;
  totalStakedUsdc?: string;
  minStake?: string;
  explorer?: string;
  sellers: (StakePosition & { payTo: string; slashedCount: number; slashed: string })[];
}

/** A junk-output claim against a seller's bond. Kind 1 rests on the seller's own receipt; kind 2 (no valid receipt) can be rebutted. */
export interface StakeClaim {
  id: number;
  ledgerId: number;
  evidence: string;
  seller: string;
  buyer: string;
  state: "new" | "open" | "proposed" | "executed" | "vetoed" | "expired" | "rejected" | "not_slashable";
  kind: 1 | 2 | null;
  amount: string | null;
  claimId: string | null;
  /** Unix ms when the refund can execute (proposed claims). */
  executeAfter: number | null;
  signatures: string[];
  rebuttal: { receipt: string; body: string } | null;
  /** Unix seconds until which verifiers can veto after a rebuttal. */
  vetoDeadline: number | null;
  vetoSignatures: string[];
  paid: string | null;
  proposeTx: string | null;
  closeTx: string | null;
  lastError: string | null;
  createdAt: number;
  closedAt: number | null;
}

export type PriorityFactor = "retry" | "waited" | "progress" | "reliability" | "smallness";

export interface QueueStatus {
  weights: Record<PriorityFactor, number>;
  perWallet: number;
  perSeller: number;
  maxWaitMs: number;
  busy: { wallets: Record<string, number>; sellers: Record<string, number> };
  queue: { position: number; label: string; wallet: string; priority: number; factors: Record<PriorityFactor, number>; waitedMs: number }[];
  contention: {
    ts: string;
    wallet: string;
    winner: { label: string; priority: number; factors: Record<PriorityFactor, number> };
    waiting: { label: string; priority: number; factors: Record<PriorityFactor, number> }[];
    reason: string;
  }[];
}

export interface LedgerEntry {
  id: number;
  ts: string;
  run_id: string | null;
  buyer: string;
  seller: string;
  service_id: string | null;
  service_name: string;
  endpoint: string;
  listed: string;
  asked: string | null;
  paid: string;
  tx_hash: string | null;
  status: LedgerStatus;
  reason: string | null;
  latency_ms: number;
  explorer: string | null;
  listed_usdc: string;
  asked_usdc: string | null;
  paid_usdc: string;
}

export interface Sale {
  id: number;
  ts: string;
  seller: string;
  payer: string | null;
  amount: string;
  tx_hash: string | null;
  status: string;
  reason: string | null;
  latency_ms: number;
  explorer: string | null;
  amount_usdc: string;
}

export interface Purchase {
  step: string;
  service: string;
  serviceId: string;
  category: Category;
  seller: string;
  why: string;
  status: string;
  listed: string;
  asked?: string;
  paid: string;
  txHash?: string;
  explorer?: string;
  reason?: string;
  latencyMs: number;
}

/** requesting = first request sent; quoted = a 402 passed the checks; settling = signed, seller working and settling on chain. */
export type CallPhase = "requesting" | "quoted" | "settling";

/** A paid call happening right now. It leaves `Run.inflight` when its Purchase is recorded. */
export interface InflightCall {
  id: number;
  step: string;
  service: string;
  serviceId: string;
  phase: CallPhase;
  asked?: string;
  /** Present while the call waits for a slot in the priority scheduler. */
  queue?: { priority: number; position: number; waitedMs: number; factors: Record<PriorityFactor, number> };
  startedAt: string;
  phaseAt: string;
}

export interface RunResultBook {
  title: string;
  rating: number;
  price_gbp: number;
  url: string;
  summary_hi: string | null;
  [priceKey: string]: unknown;
}

export interface RunResult {
  currency: string;
  fxRate: number | null;
  fxDate: string | null;
  pagesScraped: number[];
  pagesMissing: number[];
  books: RunResultBook[];
}

/** Result of an agent run: a written answer plus named outputs the agent chose to hand back. */
export interface AgentResult {
  answer: string;
  outputs: Record<string, unknown>;
  turns?: number;
  dryRun?: boolean;
}

export interface QuoteLine {
  turn: number;
  as: string;
  service: string;
  category: Category;
  estimate: string;
  purpose?: string;
  skipped?: boolean;
}

export interface Quote {
  lines: QuoteLine[];
  total: string;
  byCategory: Partial<Record<Category, string>>;
  note: string;
}

export const isAgentResult = (r: RunResult | AgentResult): r is AgentResult =>
  typeof (r as AgentResult).answer === "string" && "outputs" in r;

export type RunStateName =
  | "running"
  | "completed"
  | "partial"
  | "needs_more_budget"
  | "failed"
  | "interrupted";

export interface Run {
  id: string;
  task: string;
  budget: string;
  maxConcurrency: number;
  state: RunStateName;
  log: string[];
  planner?: string;
  /** agent = the LLM planned the run; legacy = built-in books pipeline (fallback). */
  mode?: "agent" | "legacy";
  dryRun?: boolean;
  quote?: Quote;
  purchases: Purchase[];
  inflight?: InflightCall[];
  result?: RunResult | AgentResult | null;
  explanation?: string;
  spent?: string;
  remaining?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface SellerInfo {
  id: string;
  payTo: string;
  endpoint: string;
  adversarial: boolean;
}

export interface Info {
  network: string;
  asset: string;
  facilitator: string;
  publicBaseUrl: string;
  buyer: string | null;
  sellers: SellerInfo[];
  llm: { host: string; model: string; available: boolean };
  buyerTokenRequired: boolean;
  /** Cap of the shared demo wallet (signed-in users get their own, see AgentWalletInfo). */
  spendCap: { enabled: boolean; limitUsdc: string; windowMinutes: number; usedUsdc: string; remainingUsdc: string };
}

export interface ServicesResponse {
  services: Service[];
}

export interface LedgerResponse {
  totalPaid: string;
  totalPaidUsdc: string;
  unconfirmedCount?: number;
  entries: LedgerEntry[];
}

export interface SalesResponse {
  sales: Sale[];
}

export type AttackKind = "overcharge" | "wrong_payto" | "bad_terms" | "unsafe_endpoint" | "junk_output" | "prompt_injection" | "replay";

/** /registry/attacks: every attack the buyer stopped, by kind. */
export interface AttackSummary {
  attacks: { kind: AttackKind; label: string; count: number; lastAt: string | null }[];
  total: number;
  notPaidUnits: string;
  notPaidUsdc: string;
}

/** Settings of a Sell-tab LLM agent. The API key itself is never sent to the browser. */
/** The parts of a JSON Schema the Sell tab reads. */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  [key: string]: unknown;
}

/** Where one input field of a chain step comes from. */
export type ChainSource = { from: "buyer"; field: string } | { from: "fixed"; value: unknown } | { from: "step"; step: number; field: string; fallback?: unknown };

/** When to leave a step out: looks at a buyer field or an earlier step's output. */
export interface ChainSkipIf {
  when: { from: "buyer"; field: string } | { from: "step"; step: number; field: string };
  test: "empty" | "not_empty" | "equals";
  value?: unknown;
}

export interface ChainStepForm {
  serviceId: string;
  input: Record<string, ChainSource>;
  skipIf?: ChainSkipIf;
}

/** What one chain has earned and spent, over its last 500 runs. Amounts are USDC smallest units. */
export interface ChainStats {
  /** Buyer requests that were paid. */
  calls: number;
  /** Buyer requests that failed (the buyer was not charged). */
  failures: number;
  revenue: string;
  /** Paid to suppliers, failed and test runs included. */
  cost: string;
  profit: string;
  recent: { ts: string; kind: "sale" | "test"; outcome: "ok" | "failed"; cost: string; earned: string; stepsPaid: number; stepsCached: number; error: string | null }[];
}

/** What the Sell tab gets back about one of the wallet's agent chains. */
export interface ChainInfo {
  steps: ChainStepForm[];
  /** USDC smallest units. */
  subBudget: string;
  hires: string[];
  stats: ChainStats;
}

export interface ChainQuote {
  steps: { serviceId: string; name: string; category: Category; price: string; skippable: boolean }[];
  /** All amounts in USDC smallest units. */
  cost: string;
  /** What a call costs when every skippable step is skipped. */
  minCost: string;
  subBudget: string;
  price: string;
  margin: string;
  category: Category;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  agentWallet: { address: string; balance: string | null; enough: boolean | null };
}

export interface ChainTestResult {
  output: {
    result: unknown;
    steps: { service: string; output: unknown }[];
    hired: { service: string; category: string; status: string; paid: string; tx_hash?: string }[];
    cost_units: string;
  };
  ms: number;
}

export interface AgentInfo {
  host: string;
  model: string;
  systemPrompt: string;
  hasKey: boolean;
}

export interface AgentWalletInfo {
  user: string;
  address: string;
  network: string;
  asset: string;
  /** USDC smallest units; null when the chain could not be read. */
  balance: string | null;
  balanceUsdc: string | null;
  balanceError: string | null;
  spendCap: { enabled: boolean; limitUsdc: string; windowMinutes: number; usedUsdc: string; remainingUsdc: string };
  explorer: string;
  /** The user's own Ollama settings for planning (never the key). null = their runs plan on the server's key. */
  plannerLlm: { host: string; model: string; hasKey: boolean } | null;
  withdrawals: { id: number; ts: string; amount_usdc: string; status: "settled" | "failed" | "unknown"; tx_hash: string | null; explorer: string | null; reason: string | null }[];
}

/** What the Sell tab may know about one MCP-tool listing. The token itself never leaves the server. */
export interface McpInfo {
  serverId: string;
  url: string;
  tool: string;
  hasToken: boolean;
}

export interface McpToolsLoaded {
  url: string;
  /** The listing group name this server gets when the seller gives none. */
  name: string;
  hasToken: boolean;
  tools: { name: string; description: string; usable: boolean }[];
}

export interface McpSaved {
  serverId: string;
  name: string;
  url: string;
  listed: Service[];
  skipped: { tool: string; reason: string }[];
  removed: string[];
  hasToken: boolean;
}
