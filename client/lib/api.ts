import type {
  Info,
  LedgerResponse,
  Run,
  SalesResponse,
  ChainQuote,
  ChainStepForm,
  ChainTestResult,
  Service,
  ServicesResponse,
} from "./types";

async function get<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!res.ok) {
    throw new Error(data?.error || `request failed (${res.status})`);
  }
  return data as T;
}

export const fetcher = <T>(url: string): Promise<T> => get<T>(url);

export const getInfo = () => get<Info>("/api/info");

export interface ServiceQuery {
  category?: string;
  maxPrice?: string;
  sort?: string;
}

export function servicesUrl(q: ServiceQuery = {}): string {
  const params = new URLSearchParams();
  if (q.category) params.set("category", q.category);
  if (q.maxPrice) params.set("maxPrice", q.maxPrice);
  if (q.sort) params.set("sort", q.sort);
  const qs = params.toString();
  return `/registry/services${qs ? `?${qs}` : ""}`;
}

export const getServices = (q: ServiceQuery = {}) =>
  get<ServicesResponse>(servicesUrl(q));

export const getLedger = (runId?: string) =>
  get<LedgerResponse>(`/registry/ledger${runId ? `?runId=${runId}` : ""}`);

export interface ListingForm {
  id?: string;
  name: string;
  category: string;
  endpoint: string;
  method: "GET" | "POST";
  /** USDC smallest units (6 decimals). */
  price: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string; issues?: { path: (string | number)[]; message: string }[] }) | null;
  if (!res.ok) {
    const detail = data?.issues?.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(detail || data?.error || `request failed (${res.status})`);
  }
  return data as T;
}

export interface AgentForm {
  id?: string;
  name: string;
  description: string;
  /** USDC smallest units (6 decimals). */
  price: string;
  host: string;
  model: string;
  systemPrompt: string;
  /** Leave out to keep the stored key when editing. */
  apiKey?: string;
}

export const saveAgent = (form: AgentForm) => send<Service & { hasKey: boolean }>("POST", "/registry/mine/llm-agents", form);
export const testAgent = (form: Omit<AgentForm, "name" | "description" | "price"> & { text: string }) =>
  send<{ answer: string; model: string; ms: number }>("POST", "/registry/mine/llm-agents/test", form);

export interface ChainForm {
  id?: string;
  name: string;
  description: string;
  /** USDC smallest units (6 decimals). */
  price: string;
  /** Most one request may spend on its steps, in USDC smallest units. */
  subBudget: string;
  steps: ChainStepForm[];
}

export const saveChain = (form: ChainForm) => send<Service>("POST", "/registry/mine/chains", form);
export const quoteChain = (form: Omit<ChainForm, "name" | "description">) => send<ChainQuote>("POST", "/registry/mine/chains/quote", form);
/** Spends real testnet USDC from the agent wallet: the hired sellers are paid for real. */
export const testChain = (form: Omit<ChainForm, "name" | "description"> & { input: Record<string, unknown> }) =>
  send<ChainTestResult>("POST", "/registry/mine/chains/test", form);

export const withdrawFromAgent = (amount: string) =>
  send<{ amount_usdc: string; tx_hash: string; explorer: string | null }>("POST", "/agent/withdraw", { amount });

/** Saves (after one tiny check call) the signed-in user's own Ollama settings for Scout's planning. Leave apiKey out to keep the stored one. */
export const savePlannerLlm = (form: { host?: string; model?: string; apiKey?: string }) =>
  send<{ host: string; model: string; hasKey: boolean }>("PUT", "/agent/llm", form);
export const clearPlannerLlm = () => send<{ ok: true }>("DELETE", "/agent/llm");

export const saveListing = (form: ListingForm) => send<Service>("POST", "/registry/mine/services", form);
export const deleteListing = (id: string) => send<{ ok: true }>("DELETE", `/registry/mine/services/${encodeURIComponent(id)}`);

export const getSales = () => get<SalesResponse>("/registry/sales");

export const getRun = (id: string) => get<Run>(`/buyer/runs/${id}`);

export const getRuns = () =>
  get<{ runs: (Pick<Run, "id" | "task" | "state" | "startedAt" | "spent" | "budget">)[] }>(
    "/buyer/runs",
  );

export function startRun(body: {
  task: string;
  budget: string;
  maxConcurrency: number;
  dryRun?: boolean;
  token?: string;
}) {
  return get<{ runId: string }>("/buyer/run", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(body.token ? { "x-buyer-token": body.token } : {}),
    },
    body: JSON.stringify({
      task: body.task,
      budget: body.budget,
      maxConcurrency: body.maxConcurrency,
      dryRun: body.dryRun === true,
    }),
  });
}
