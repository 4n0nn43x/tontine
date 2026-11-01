// The contract between a firm and the swarm. A firm is a market maker: for each order it quotes what it
// delivers, from a reference price, a spread and an inventory skew. Its owner's policy (on chain) bounds
// what it can bid; an AI manager may retune its params from its results (manager.ts). Third parties add a
// firm by PR of one file in strategies/, or run one themselves with the SDK (SDK.md).
import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { revealRefusal, type Policy, type Side } from "./rules.ts";

export type OrderView = { id: number; client: string; side: Side; amountIn: bigint; minOut: bigint; referenceOut: bigint | null };

export type FirmCtx = {
  id: number;
  account: string;
  /** Stable treasury and asset inventory in the tender ledgers (base units). */
  stable: bigint;
  asset: bigint;
  fills: number;
  /** Sum of its fills' edges (stable base units). */
  edge: bigint;
  /** "Solvent", "Illiquid", "Liquidating" or "Closed". */
  status?: string;
  policy: Policy;
  /** What it owes its lenders, interest included: cash it must keep. */
  owed?: bigint;
};

/** The market as a firm sees it when quoting. */
export type Market = {
  /** Reference mid, USDC per unit of the asset (the market mid, or the replay). */
  mid: number;
  /** Last clearing price on tender, stable base units per asset unit: the anchor of the owner's band. */
  last: bigint;
  unit: bigint;
};

/** What a manager tunes. */
export type Params = {
  /** Distance from the mid it quotes at. */
  spreadBps: number;
  /** Share of its net asset value it wants to hold in NEAR. */
  targetAssetShare: number;
  /** How hard it leans its quotes toward that target, at most. */
  skewBps: number;
};

/** A firm in liquidation, as a buyer sees it. Its NEAR goes to its shareholders, its cash to its creditors and
 * shareholders: a buyer pays for the firm itself (its record, its customers). `reserve` is the lowest bid. */
export type TargetView = { id: number; account: string; fills: number; edge: bigint; stable: bigint; asset: bigint; reserve: bigint };

/** What a firm publishes about itself on chain (`set_firm_profile`). See SDK.md. */
export type FirmSpec = {
  name: string;
  description: string;
  /** What it trades, e.g. ["NEAR/USDC"]. */
  skills: string[];
  /** The model behind its manager, e.g. "Qwen/Qwen3.8-27B on NEAR AI Cloud". */
  model?: string;
  /** Order sizes it quotes, in USDC. */
  min_budget?: number;
  max_budget?: number;
  url?: string;
};

export interface Strategy {
  name: string;
  /** Published on chain as the firm's profile when present. */
  spec?: FirmSpec;
  author: string;
  /** House firms are labelled as such everywhere (README, dashboard). */
  house: boolean;
  /** Starting params. */
  params: Params;
  /** A manager retunes the params from the firm's results (manager.ts): true for the AI manager (an LLM
   * when NEARAI_API_KEY is set, else the rule), "rule" for the stated rule only, "bandit" for a UCB1 bandit
   * on the spread (banditDecide). */
  managed?: boolean | "rule" | "bandit";
  /** Optional: replace the default quote (output for an order, or null to pass). */
  quote?(order: OrderView, me: FirmCtx, market: Market, params: Params): bigint | null;
  /** Optional: sealed price to buy a firm in liquidation (forward auction), paid from the treasury. */
  takeover?(target: TargetView, me: FirmCtx): bigint | null;
}

/** Fair output at the mid, less the spread, leaning toward the inventory target. */
export function defaultQuote(order: OrderView, me: FirmCtx, market: Market, p: Params): bigint | null {
  const mid = BigInt(Math.round(market.mid * 1e6));
  const assetValue = (me.asset * mid) / market.unit;
  const nav = me.stable + assetValue;
  const share = nav > 0n ? Number(assetValue) / Number(nav) : 0;
  // Holding more NEAR than the target: sell it cheaper (buy orders), buy it dearer (sell orders).
  const lean = Math.max(-1, Math.min(1, (share - p.targetAssetShare) / 0.5)) * p.skewBps;
  const spread = Math.round(order.side === "Buy" ? p.spreadBps - lean : p.spreadBps + lean);
  const gross = order.side === "Buy" ? (order.amountIn * market.unit) / mid : (order.amountIn * mid) / market.unit;
  return (gross * BigInt(10_000 - spread)) / 10_000n;
}

/**
 * The quote a firm will actually commit: its strategy's answer, kept only if the contract would accept it
 * at reveal (reserve, band, inventory, balance). A refused reveal costs the owner's bond.
 */
export function safeQuote(s: Strategy, order: OrderView, me: FirmCtx, market: Market, params: Params): bigint | null {
  if (me.policy.paused) return null;
  let v: bigint | null;
  try {
    v = s.quote ? s.quote(order, me, market, params) : defaultQuote(order, me, market, params);
  } catch {
    return null;
  }
  if (v === null || v <= 0n) return null;
  return revealRefusal(order.side, order.amountIn, order.minOut, v, me, market.last, market.unit) ? null : v;
}

/** What a firm owes, interest to now plus a 1% margin (the contract counts to the block). */
export function owedOf(debts: { principal: string; rate_bps: number; since: number }[], nowMs = Date.now()): bigint {
  let total = 0n;
  for (const d of debts) {
    const p = BigInt(d.principal);
    const secs = BigInt(Math.max(0, Math.floor(nowMs / 1000 - Number(d.since) / 1e9)));
    total += p + (p * BigInt(d.rate_bps) * secs) / (10_000n * 365n * 86_400n);
  }
  return (total * 101n) / 100n;
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "strategies");

/** Load every strategy in strategies/, sorted by file name. */
export async function loadStrategies(): Promise<Strategy[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".ts")).sort();
  const out: Strategy[] = [];
  for (const f of files) {
    const s = (await import(pathToFileURL(path.join(dir, f)).href)).default as Strategy;
    if (!s?.name || !s.params) throw new Error(`strategies/${f}: not a Strategy`);
    out.push(s);
  }
  return out;
}
