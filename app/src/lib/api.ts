// Client for the Tontine server API (ts/src/server.ts).

export type ChainEvent = {
  id: number;
  height: number;
  time: number;
  txHash: string;
  signer: string;
  contract: string;
  standard: string;
  event: string;
  data: any;
};

export type Holding = { account: string; shares: number; debt: string };

export type FirmState = {
  id: number;
  account: string;
  owner: string;
  status: "Solvent" | "Illiquid" | "Liquidating" | "Closed";
  acc_per_share: string;
  holdings: Holding[];
  debts: { lender: string; principal: string; rate_bps: number; since: number }[];
  loan_terms: { rate_bps: number; cap: string } | null;
  epochs_below_floor: number;
  liquidation_auction: number | null;
  delivered: number;
  rejected: number;
  slashed: string;
  revenue: string;
  dividends: string;
  takeovers: number;
  owner_synced: boolean;
  open_jobs: number;
  /** JSON published by the owner with set_firm_profile: name, description, skills, model... */
  profile: string | null;
  treasury: string;
  ownerBond: string;
  strategy: { name: string; author: string; house: boolean } | null;
};

export type Bid = { firm_id: number; owner: string; hash: string; revealed: string | null };

export type AuctionState = {
  kind: { Job?: number; Liquidation?: number };
  reverse: boolean;
  reserve: string;
  commit_end: number | string;
  reveal_end: number | string;
  bids: Bid[];
  settled: boolean;
  winner: number | null;
  price: string | null;
};

export type JobState = {
  id: number;
  client: string;
  budget: string;
  brief: string;
  auction: number;
  status: "Bidding" | "Assigned" | "Delivered" | "Paid" | "Rejected" | "Cancelled" | "Disputed";
  deliver_secs: number;
  deadline: number | string | null;
  result: string | null;
  attestation: string | null;
  winner_owner: string | null;
  criteria: string;
  verify: "Judge" | { Optimistic: { review_secs: number } };
  review_end: number | string | null;
  auctionState: AuctionState;
};

export type Dispute = {
  panel: { firm_id: number; owner: string; hash: string | null; vote: boolean | null }[];
  commit_end: number | string;
  reveal_end: number | string;
  resolved: boolean;
};

export type AppState = { firms: FirmState[]; jobs: JobState[]; totalJobs: number; chainTime: string; updatedAt: number };

export type Config = {
  network: string;
  networkLabel: string;
  rpc: string;
  tender: string;
  usdc: string;
  intents: string;
  token: string;
  judge: string;
  houseClient: string;
  tenderConfig: any;
  firms: { id: number; account: string; owner: string; strategy: string; author: string; house: boolean }[];
  templates: { index: number; name: string }[];
};

export type Stats = {
  jobs: number;
  paid: number;
  rejected: number;
  cancelled: number;
  volume: string;
  dividends: string;
  slashed: string;
  liquidations: number;
  takeovers: number;
  bids: number;
  deposits: string;
  firms: number;
  totalJobs: number;
};

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as any).error ?? `${path}: ${r.status}`);
  return j as T;
}

let configPromise: Promise<Config> | null = null;
export const getConfig = () => (configPromise ??= get<Config>("/api/config").catch((e) => {
  configPromise = null;
  throw e;
}));
export const getState = () => get<AppState>("/api/state");
export const getStats = () => get<Stats>("/api/stats");
export const getEvents = (limit = 100) => get<ChainEvent[]>(`/api/events?limit=${limit}`);
export const getThesis = () => get<{ result: any; predictions: any; predictionsSha256: string | null }>("/api/thesis");
export const createDemoAccount = (publicKey: string) => post<{ accountId: string }>("/api/account", { publicKey });
export const faucet = (accountId: string) => post<{ usdc: string }>("/api/faucet", { accountId });

/** Live chain events (server-sent events). Returns an unsubscribe function. */
export function subscribeEvents(onEvent: (e: ChainEvent) => void): () => void {
  const es = new EventSource("/api/stream");
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch {
      /* ignore malformed lines */
    }
  };
  return () => es.close();
}

/** Ask the devnet server to run an agent for a firm you are about to create: returns its public keys. */
export async function requestAgent(name: string, strategy: number): Promise<string[]> {
  const r = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, strategy }) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `agent request failed (${r.status})`);
  return body.agentKeys;
}

export type FirmSpec = { name?: string; description?: string; skills?: string[]; model?: string; min_budget?: number; max_budget?: number; url?: string };

/** The firm's published spec, or null when it has none (or it does not parse). */
export function specOf(f: { profile: string | null } | undefined): FirmSpec | null {
  try {
    return f?.profile ? (JSON.parse(f.profile) as FirmSpec) : null;
  } catch {
    return null;
  }
}
