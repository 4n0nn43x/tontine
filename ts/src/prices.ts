// Reference prices for NEAR, ETH and SOL in USDC.
// Live: the median mid of the Binance, OKX and Coinbase order books (public tickers, no key) and, for NEAR and
// ETH, the price of Rhea Finance's aggregate oracle on NEAR mainnet (a NEAR-native feed). Not 1Click:
// its terms (2026-10-07, §4.1(b)) forbid using it to benchmark a competing product, and Tontine is an RFQ
// venue. NEAR Intents stays the money rail. USDT and USD are treated as equal to USDC here.
// Replay: Binance 5-minute closes frozen in fixtures/<asset>-usd-5m.json, so `make demo` and `make sim` run
// offline and repeat exactly.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Side } from "./rules.ts";

const ONECLICK = process.env.ONECLICK_URL ?? "https://1click.chaindefuser.com/v0/quote";
const USDC_ID = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const WNEAR_ID = "nep141:wrap.near";
export const NEAR_UNIT = 10n ** 24n;
/** How far below the market mid a client's minimum sits by default: about what a keyless aggregator charges. */
export const CLIENT_TOLERANCE_BPS = 25;

export type AssetSymbol = "NEAR" | "ETH" | "SOL";
/** Units of the NEAR Intents tokens nep141:wrap.near, nep141:eth.omft.near and nep141:sol.omft.near. */
export const ASSETS: Record<AssetSymbol, { symbol: AssetSymbol; decimals: number; unit: bigint }> = {
  NEAR: { symbol: "NEAR", decimals: 24, unit: NEAR_UNIT },
  ETH: { symbol: "ETH", decimals: 18, unit: 10n ** 18n },
  SOL: { symbol: "SOL", decimals: 9, unit: 10n ** 9n },
};

type Fixture = { start_ms: number; interval_ms: number; prices: number[] };
const fixtures = new Map<AssetSymbol, Fixture>();
export function replayPrices(symbol: AssetSymbol = "NEAR"): Fixture {
  let fx = fixtures.get(symbol);
  if (!fx) {
    fx = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", `${symbol.toLowerCase()}-usd-5m.json`), "utf8")) as Fixture;
    fixtures.set(symbol, fx);
  }
  return fx;
}

/** USDC base units per unit of the asset. */
export const toBase = (usdPerUnit: number) => BigInt(Math.round(usdPerUnit * 1e6));

/** Output of an order at `mid` (USDC per unit of the asset) less `costBps`. `unit` is the asset's base unit. */
export function outAt(side: Side, amountIn: bigint, mid: number, costBps: number, unit = NEAR_UNIT): bigint {
  const p = toBase(mid);
  const gross = side === "Buy" ? (amountIn * unit) / p : (amountIn * p) / unit;
  return (gross * BigInt(10_000 - costBps)) / 10_000n;
}

/**
 * A 1Click dry quote: what the client would receive through NEAR Intents for `amountIn`. Optional and no
 * longer used for the reference (see the 1Click terms above).
 */
export async function oneClickQuote(side: Side, amountIn: bigint): Promise<bigint> {
  const deadline = new Date(Date.now() + 30 * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: side === "Buy" ? USDC_ID : WNEAR_ID,
    destinationAsset: side === "Buy" ? WNEAR_ID : USDC_ID,
    amount: amountIn.toString(),
    depositType: "INTENTS",
    refundTo: "tontine.near",
    refundType: "INTENTS",
    recipient: "tontine.near",
    recipientType: "INTENTS",
    deadline,
    quoteWaitingTimeMs: 0,
  };
  const r = await fetch(ONECLICK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`1Click ${r.status}`);
  const j: any = await r.json();
  return BigInt(j.quote.amountOut);
}

export type MarketSource = { name: string; mid: number };
export type MarketMid = { mid: number; sources: MarketSource[]; spreadBps: number };

const getJson = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json() as Promise<any>;
};

/**
 * Rhea Finance's aggregate oracle (`aggregate-oracle.near`, NEAR mainnet): Pyth Pro, Binance, Outlayer, Atlas and
 * CoinGecko aggregated on chain, read through its Pyth-compatible view with Pyth feed ids. It lists NEAR and ETH
 * (bridged), not SOL. A feed older than RHEA_MAX_AGE_S answers null and is skipped.
 */
const RHEA_RPC = process.env.RHEA_RPC ?? "https://rpc.mainnet.fastnear.com";
export const RHEA_ORACLE = "aggregate-oracle.near";
const RHEA_FEEDS: Partial<Record<AssetSymbol, string>> = {
  NEAR: "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750", // wrap.near
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", // eth.bridge.near
};
const RHEA_MAX_AGE_S = 600;
async function rheaMid(s: AssetSymbol): Promise<number> {
  const id = RHEA_FEEDS[s];
  if (!id) return NaN;
  const args = Buffer.from(JSON.stringify({ price_id: id, age: RHEA_MAX_AGE_S })).toString("base64");
  const body = { jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: RHEA_ORACLE, method_name: "get_price_no_older_than", args_base64: args } };
  const j = await getJson(RHEA_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const p = JSON.parse(Buffer.from(j.result.result).toString());
  return p ? Number(p.price) * 10 ** p.expo : NaN;
}

// Public book tickers (Binance and OKX quote USDT, Coinbase USD), and Rhea's oracle.
const VENUES: { name: string; mid: (s: AssetSymbol) => Promise<number> }[] = [
  { name: "binance", mid: async (s) => ((j) => (+j.bidPrice + +j.askPrice) / 2)(await getJson(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${s}USDT`)) },
  { name: "okx", mid: async (s) => ((j) => (+j.data[0].bidPx + +j.data[0].askPx) / 2)(await getJson(`https://www.okx.com/api/v5/market/ticker?instId=${s}-USDT`)) },
  { name: "coinbase", mid: async (s) => ((j) => (+j.bid + +j.ask) / 2)(await getJson(`https://api.exchange.coinbase.com/products/${s}-USD/ticker`)) },
  { name: "rhea", mid: rheaMid },
];
const MID_TTL_MS = 5000;
/** How long the last good mid stands in: to pick between two venues that disagree, or when none answers. */
export const LAST_GOOD_MS = 10 * 60_000;
/** Two venues further apart than this: one of them is wrong. */
const DISAGREE = 0.02;
const mids = new Map<AssetSymbol, { at: number; v: MarketMid }>();
const good = new Map<AssetSymbol, { at: number; mid: number }>();
const inflight = new Map<AssetSymbol, Promise<MarketMid>>();

/**
 * The market mid in USD: the median of the venues that answer within 3 s (four for NEAR and ETH, three for SOL), cached 5 s per asset, one fetch at
 * a time per asset. Two venues more than 2% apart: the one closer to the last good mid, if under 10 minutes
 * old. No venue: that last good mid, its source saying so. Else it throws. `spreadBps` is the gap between the
 * highest and lowest venue, in bp of the mid.
 */
export function marketMid(symbol: AssetSymbol): Promise<MarketMid> {
  const hit = mids.get(symbol);
  if (hit && Date.now() - hit.at < MID_TTL_MS) return Promise.resolve(hit.v);
  let p = inflight.get(symbol);
  if (!p) {
    p = fetchMid(symbol).finally(() => inflight.delete(symbol));
    inflight.set(symbol, p);
  }
  return p;
}

async function fetchMid(symbol: AssetSymbol): Promise<MarketMid> {
  const got = await Promise.all(
    VENUES.map(async ({ name, mid }) => {
      try {
        const m = await mid(symbol);
        return Number.isFinite(m) && m > 0 ? { name, mid: m } : null;
      } catch {
        return null;
      }
    }),
  );
  let sources = got.filter((s): s is MarketSource => s !== null);
  const now = Date.now();
  const g = good.get(symbol);
  const last = g && now - g.at < LAST_GOOD_MS ? g : null;
  let v: MarketMid;
  if (!sources.length) {
    if (!last) throw new Error(`no market price for ${symbol}`);
    v = { mid: last.mid, sources: [{ name: `last good mid, ${Math.round((now - last.at) / 1000)} s old`, mid: last.mid }], spreadBps: 0 };
  } else {
    const xs = sources.map((s) => s.mid).sort((a, b) => a - b);
    if (xs.length === 2 && xs[1] > xs[0] * (1 + DISAGREE)) {
      if (!last) throw new Error(`no market price for ${symbol}: two venues ${((xs[1] / xs[0] - 1) * 100).toFixed(1)}% apart, and no recent mid to tell which is right`);
      sources = [sources.reduce((a, b) => (Math.abs(b.mid - last.mid) < Math.abs(a.mid - last.mid) ? b : a))];
    }
    const h = xs.length >> 1;
    const mid = sources.length === 1 ? sources[0].mid : xs.length % 2 ? xs[h] : (xs[h - 1] + xs[h]) / 2;
    v = { mid, sources, spreadBps: ((xs[xs.length - 1] - xs[0]) / mid) * 1e4 };
    good.set(symbol, { at: now, mid });
  }
  mids.set(symbol, { at: now, v });
  return v;
}

export type Reference = { out: bigint; mid: number; source: "market" | "replay"; sources: MarketSource[] };

/**
 * A client's default minimum for this order (the market mid less CLIENT_TOLERANCE_BPS), and the mid behind it.
 * Live by default; the replay price under REPLAY=1, or when marketMid throws (no venue and no good mid in the
 * last 10 minutes).
 */
export async function reference(side: Side, amountIn: bigint, replayIndex = -1, symbol: AssetSymbol = "NEAR"): Promise<Reference> {
  const unit = ASSETS[symbol].unit;
  if (process.env.REPLAY !== "1" && replayIndex < 0) {
    try {
      const m = await marketMid(symbol);
      return { out: outAt(side, amountIn, m.mid, CLIENT_TOLERANCE_BPS, unit), mid: m.mid, source: "market", sources: m.sources };
    } catch {}
  }
  const fx = replayPrices(symbol);
  const mid = fx.prices[replayIndex >= 0 ? replayIndex % fx.prices.length : fx.prices.length - 1];
  return { out: outAt(side, amountIn, mid, CLIENT_TOLERANCE_BPS, unit), mid, source: "replay", sources: [] };
}

export type Candle = { time: number; open: number; high: number; low: number; close: number };
export const INTERVALS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 };

/**
 * Candles for the trade chart: Binance <asset>/USDT, Coinbase <asset>/USD if Binance fails, the frozen
 * replay (5-minute closes, as flat candles) offline or under REPLAY=1. Times are unix seconds.
 */
export async function candles(interval: string, limit: number, symbol: AssetSymbol = "NEAR"): Promise<{ source: "binance" | "coinbase" | "replay"; candles: Candle[] }> {
  const secs = INTERVALS[interval] ?? 300;
  if (process.env.REPLAY !== "1") {
    try {
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const k: any[] = await r.json();
        return { source: "binance", candles: k.map((c) => ({ time: c[0] / 1000, open: +c[1], high: +c[2], low: +c[3], close: +c[4] })) };
      }
    } catch {}
    try {
      const r = await fetch(`https://api.exchange.coinbase.com/products/${symbol}-USD/candles?granularity=${Math.min(secs, 86_400)}`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const k: any[] = await r.json(); // [time, low, high, open, close, volume], newest first
        return { source: "coinbase", candles: k.slice(0, limit).reverse().map((c) => ({ time: c[0], open: c[3], high: c[2], low: c[1], close: c[4] })) };
      }
    } catch {}
  }
  const fx = replayPrices(symbol);
  const step = Math.max(1, Math.round(secs / 300));
  const out: Candle[] = [];
  for (let i = fx.prices.length - limit * step; i < fx.prices.length; i += step) {
    if (i < 1) continue;
    const slice = fx.prices.slice(i, i + step);
    const open = fx.prices[i - 1];
    out.push({ time: (fx.start_ms + i * fx.interval_ms) / 1000, open, high: Math.max(open, ...slice), low: Math.min(open, ...slice), close: slice.at(-1)! });
  }
  return { source: "replay", candles: out };
}
