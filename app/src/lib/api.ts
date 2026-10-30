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

export type Side = "Buy" | "Sell";

/** The owner's limits on its firm's agent, enforced by tender on every revealed quote. */
export type Policy = { max_asset_bps: number; band_bps: number; paused: boolean };

/** What a firm's quotes are computed from (ts/src/strategy.ts); a manager may retune them. */
export type Params = { spreadBps: number; targetAssetShare: number; skewBps: number };

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
  policy: Policy;
  fills: number;
  /** USDC notional of the orders it filled. */
  volume: string;
  /** Sum of its fills' edges, signed, USDC base units. */
  edge: string;
  slashed: string;
  dividends: string;
  takeovers: number;
  escrow: string;
  escrow_asset: string;
  owner_synced: boolean;
  /** JSON published by the owner with set_firm_profile: name, description, skills, model... */
  profile: string | null;
  /** USDC cash in tender (base units). */
  treasury: string;
  /** wNEAR inventory in tender (yocto). */
  inventory: string;
  /** Cash plus NEAR at the last clearing price (USDC base units). */
  nav: string;
  ownerBond: string;
  strategy: { name: string; author: string; house: boolean } | null;
};

export type Bid = { firm_id: number; owner: string; hash: string; revealed: string | null };

export type AuctionState = {
  kind: { Order?: number; Liquidation?: number };
  reserve: string;
  commit_end: number | string;
  reveal_end: number | string;
  bids: Bid[];
  settled: boolean;
  winner: number | null;
  price: string | null;
};

export type OrderState = {
  id: number;
  client: string;
  side: Side;
  /** Escrowed: USDC for a buy, wNEAR for a sell. */
  amount_in: string;
  min_out: string;
  /** What NEAR Intents 1Click quoted when the order was posted. */
  reference_out: string | null;
  /** Tender's last clearing price when posted (USDC base units per NEAR). */
  price: string;
  auction: number;
  status: "Open" | "Filled" | "Refunded";
  firm: number | null;
  out: string | null;
  auctionState: AuctionState;
};

export type AppState = {
  firms: FirmState[];
  orders: OrderState[];
  totalOrders: number;
  /** USDC base units per NEAR. */
  lastPrice: string;
  reference: { mid: number; source: "1click" | "replay"; at: number };
  params: Record<string, Params>;
  chainTime: string;
  updatedAt: number;
};

export type Config = {
  network: string;
  networkLabel: string;
  rpc: string;
  tender: string;
  usdc: string;
  wnear: string;
  intents: string;
  /** intents.near token ids of USDC and wNEAR. */
  token: string;
  assetToken: string;
  houseClient: string;
  tenderConfig: any;
  firms: { id: number; account: string; owner: string; strategy: string; author: string; house: boolean; managed: boolean }[];
  templates: { index: number; name: string }[];
};

export type Stats = {
  orders: number;
  fills: number;
  refunded: number;
  volume: string;
  edge: string;
  /** Sum over fills of the bp better than the 1Click reference. */
  improvementBps: number;
  slashed: string;
  liquidations: number;
  takeovers: number;
  bids: number;
  deposits: string;
  dividends: string;
  firms: number;
  totalOrders: number;
};

/** An AI manager's receipt: the params it changed and why. */
export type Decision = { firm: string; at: number; source: "near-ai-cloud" | "rule"; before: Params; after: Params; reason: string; chatId?: string; model?: string };

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
export const faucet = (accountId: string) => post<{ usdc: string; wnear: string }>("/api/faucet", { accountId });
export const getDecisions = () => get<Decision[]>("/api/decisions");
/** What NEAR Intents 1Click gives for `amount` (base units of what you pay): the order's minimum. */
export const getQuote = (side: Side, amount: bigint) => get<{ out: string; mid: number; source: "1click" | "replay" }>(`/api/quote?side=${side}&amount=${amount}`);

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

/** A firm's display name: its published spec, else its house strategy, else its id. */
export const nameOf = (f: { id: number; profile: string | null; strategy?: { name: string } | null } | undefined, id = f?.id) => specOf(f)?.name ?? f?.strategy?.name ?? `Firm #${id}`;

/** The firm's published spec, or null when it has none (or it does not parse). */
export function specOf(f: { profile: string | null } | undefined): FirmSpec | null {
  try {
    return f?.profile ? (JSON.parse(f.profile) as FirmSpec) : null;
  } catch {
    return null;
  }
}
