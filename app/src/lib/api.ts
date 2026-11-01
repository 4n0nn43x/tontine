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
  /** The market reference when the order was posted: the mid less the client tolerance. */
  reference_out: string | null;
  /** Tender's last clearing price when posted (USDC base units per unit of the asset). */
  price: string;
  auction: number;
  status: "Open" | "Filled" | "Refunded";
  firm: number | null;
  /** What the client received: the second best quote (`auctionState.price`) less Tontine's surplus share. */
  out: string | null;
  auctionState: AuctionState;
};

export type MarketSource = { name: string; mid: number };

export type AppState = {
  firms: FirmState[];
  orders: OrderState[];
  totalOrders: number;
  /** USDC base units per unit of the asset. */
  lastPrice: string;
  /** The market mid (median of the venues in `sources`), or the replay when they are unreachable. */
  reference: { mid: number; source: "market" | "replay"; sources?: MarketSource[]; at: number };
  params: Record<string, Params>;
  chainTime: string;
  updatedAt: number;
};

export type MarketSymbol = "NEAR" | "ETH" | "SOL";
/** The markets, NEAR first (the server deploys one tender each). */
export const SYMBOLS: MarketSymbol[] = ["NEAR", "ETH", "SOL"];

/** One market: a tender trading an asset against USDC. */
export type Market = {
  symbol: MarketSymbol;
  tender: string;
  /** The asset's token contract (the wallet balance) and its intents.near token id. */
  ft: string;
  assetToken: string;
  decimals: number;
  color: string;
  /** What the faucet gives of the asset, in whole tokens. */
  faucet: number;
  tenderConfig: any;
  firms: Config["firms"];
};

export type Config = {
  /** Every market, NEAR first. The fields below are the NEAR market's. */
  markets: Market[];
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
  templates: { index: number; name: string; llm?: boolean }[];
  /** What a hosted firm pays for each LLM decision of its manager (USDC base units). */
  inferenceCost?: string;
};

export type Stats = {
  orders: number;
  fills: number;
  refunded: number;
  volume: string;
  edge: string;
  /** Sum over fills of the bp the client received over its market reference. */
  improvementBps: number;
  /** Tontine's revenue: order fees plus surplus shares, in USDC base units. */
  revenue: string;
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
export type Decision = { firm: string; at: number; source: "near-ai-cloud" | "anthropic" | "bandit" | "rule"; before: Params; after: Params; reason: string; chatId?: string; model?: string };

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
/** One market's state (NEAR by default). */
export const getState = (market: string = "NEAR") => get<AppState>(`/api/state?market=${market}`);
/** Totals across every market. */
export const getStats = () => get<Stats>("/api/stats");
/** The testnet showcase (ts/src/showcase.ts): the same contracts on NEAR testnet, or `enabled: false`. */
export type TestnetOrder = { id: number; side: Side; amountIn: string; out: string | null; status: string; postTx: string; settleTx: string; at: number };
export type Testnet =
  | { enabled: false }
  | {
      enabled: true;
      network: "testnet";
      explorer: string;
      status: "waiting-funds" | "setting-up" | "running" | "error";
      message: string;
      master: string;
      balance: number | null;
      need: number;
      contracts: { intents: string; usdc: string; wnear: string; tender: string } | null;
      firms: { id: number; name: string; account: string }[];
      orders: TestnetOrder[];
      evm: { firm: string; signer: string; path: string; address: string; recovered: string; ok: boolean; nearTx: string; payloadHash: string; signedTxHash: string; at: number } | null;
      evmError: string | null;
    };
export const getTestnet = () => get<Testnet>("/api/testnet");
export const getEvents = (limit = 100) => get<ChainEvent[]>(`/api/events?limit=${limit}`);
export const getThesis = () => get<{ result: any; predictions: any; predictionsSha256: string | null }>("/api/thesis");
export const createDemoAccount = (publicKey: string) => post<{ accountId: string }>("/api/account", { publicKey });
/** Test tokens into the trading balance; for a wallet of another chain, 100 USDC in NEAR Intents (a simulated deposit). */
export const faucet = (accountId: string) => post<Record<string, string>>("/api/faucet", { accountId });
/** A signed NEAR Intents payload (ts/src/relay.ts `SignedIntent`) the server relays with `execute_intents`, paying the gas. */
export type SignedIntent =
  | { standard: "erc191" | "tip191"; payload: string; signature: string }
  | { standard: "raw_ed25519" | "sep53"; payload: string; public_key: string; signature: string }
  | { standard: "webauthn"; payload: string; public_key: string; signature: string; client_data_json: string; authenticator_data: string }
  | { standard: "ton_connect"; address: string; domain: string; timestamp: number; payload: { type: "text"; text: string }; public_key: string; signature: string };
export const relayIntent = (signed: SignedIntent) => post<{ txHash: string; orderId: number; events: { standard: string; event: string; data: any[] }[] }>("/api/relay", { signed });
export const getDecisions = () => get<Decision[]>("/api/decisions");
export type Quote = { out: string; mid: number; source: "market" | "replay"; sources: MarketSource[] };
/** The market reference for `amount` (base units of what you pay): the order's default minimum. */
export const getQuote = (side: Side, amount: bigint, market: string = "NEAR") => get<Quote>(`/api/quote?side=${side}&amount=${amount}&market=${market}`);

export type Candle = { time: number; open: number; high: number; low: number; close: number };
/** Candles (unix seconds): Binance <asset>/USDT, Coinbase <asset>/USD if Binance fails, the replay offline. */
export const getCandles = (interval: string, limit: number, market: string = "NEAR") =>
  get<{ source: "binance" | "coinbase" | "replay"; candles: Candle[] }>(`/api/candles?interval=${interval}&limit=${limit}&market=${market}`);

/** The market a tender, or one of its firm accounts (`wN.<tender>`), belongs to. */
export const marketOf = (c: Config | null | undefined, contract: string) => c?.markets.find((m) => contract === m.tender || contract.endsWith(`.${m.tender}`));
/** A market by symbol, NEAR when unknown. */
export const marketBySymbol = (c: Config | null | undefined, symbol: string | null | undefined) => c?.markets.find((m) => m.symbol === symbol) ?? c?.markets[0];

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

// ------------------------------------------------------------------ AI layer: regime, mandates, shadow quotes, log, due diligence

export type RegimeLevel = "calm" | "alert" | "storm";
/** The market regime from the server's guard (volatility and the news). */
export type RegimeState = { level: RegimeLevel; since: number; reasons: string[]; source: "llm" | "keywords" | "volatility" | "forced" };
/** /api/state carries the market's regime. */
export const regimeOf = (s: AppState | null | undefined) => (s as (AppState & { regime?: RegimeState }) | null | undefined)?.regime ?? null;
/** Orders a firm's mandate kept it out of in a storm (each firm of /api/state). */
export const weatheredOf = (f: FirmState) => (f as FirmState & { weathered?: number }).weathered ?? 0;
/** Whether a manager decision carries its LLM's TEE signature. */
export const signedOf = (d: Decision) => !!(d as Decision & { signature?: unknown }).signature;
/** The hash-chained decision log of a UTC day, with its Merkle root. */
export const logUrl = (at: number) => `/api/log?day=${new Date(at).toISOString().slice(0, 10)}`;

export type MandateAction = { pause?: boolean; spreadMinBps?: number; spreadMaxBps?: number; targetAssetShare?: number; maxOrderUsd?: number };
export type MandateRule = {
  when: { kind: "price_move"; windowMin: number; belowPct?: number; abovePct?: number } | { kind: "inventory_share"; above?: number; below?: number } | { kind: "cash_vs_floor"; belowRatio: number } | { kind: "regime"; atLeast: "alert" | "storm" };
  then: MandateAction;
  note: string;
};
/** A firm's mandate: its text, its compiled rules (then the house regime defaults), which hold now and their overlay. */
export type MandateView = {
  text: string;
  source: "llm" | "pattern" | "none";
  dropped: string[];
  compiledAt: number | null;
  signed: boolean;
  regime: RegimeLevel;
  rules: MandateRule[];
  active: number[];
  overlay: MandateAction & { pause: boolean };
};
/** Null for a firm this devnet does not run. */
export const getMandate = (market: string, firmId: number) => get<MandateView | null>(`/api/mandate?market=${market}&firmId=${firmId}`);
/** Compiles the mandate the owner published in its firm's profile. */
export const postMandate = (market: string, firmId: number, text: string) => post<MandateView>("/api/mandate", { market, firmId, text });

export type ArmStats = { auctions: number; wins: number; delivered: string; edge: string };
/** Shadow quotes: the firm's actual bids against the stated rule's and its fixed starting params', same auctions. */
export type ShadowView = { manager: "llm" | "rule" | "bandit" | "none"; arms: Record<"actual" | "rule" | "fixed", ArmStats> };
/** Null for a firm this devnet does not run. */
export const getShadow = (market: string, firmId: number) => get<ShadowView | null>(`/api/shadow?market=${market}&firmId=${firmId}`);

export type DueDiligence = {
  score: number;
  grade: "A" | "B" | "C" | "D" | "E";
  components: { key: string; label: string; weight: number; value: number | null; points: number }[];
  text: string;
  source: "llm" | "template";
  chatId?: string;
  signature?: unknown;
  rejected?: string;
  at: number;
};
export const getReport = (market: string, firmId: number) => get<DueDiligence>(`/api/report?market=${market}&firmId=${firmId}`);
