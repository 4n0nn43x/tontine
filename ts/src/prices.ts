// Reference prices for NEAR in USDC.
// Live: NEAR Intents 1Click dry quotes (no key, real solvers, with the 0.2% fee 1Click adds without a key):
// what a NEAR user pays today, the bar a Tontine firm must beat for an order to fill.
// Replay: Binance 5-minute closes frozen in fixtures/near-usd-5m.json, so `make demo` and `make sim` run
// offline and repeat exactly.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Side } from "./rules.ts";

const ONECLICK = process.env.ONECLICK_URL ?? "https://1click.chaindefuser.com/v0/quote";
const USDC_ID = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const WNEAR_ID = "nep141:wrap.near";
export const NEAR_UNIT = 10n ** 24n;
/** What 1Click without a key costs on top of the mid (measured 2026-10-30: 20 bp fee + about 5 bp of solver spread). */
export const ONECLICK_COST_BPS = 25;

type Fixture = { start_ms: number; interval_ms: number; prices: number[] };
let fixture: Fixture | null = null;
export function replayPrices(): Fixture {
  fixture ??= JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "near-usd-5m.json"), "utf8"));
  return fixture!;
}

/** USDC base units per NEAR. */
export const toBase = (usdPerNear: number) => BigInt(Math.round(usdPerNear * 1e6));

/** Output of an order at `mid` (USDC per NEAR) less `costBps`. */
export function outAt(side: Side, amountIn: bigint, mid: number, costBps: number): bigint {
  const p = toBase(mid);
  const gross = side === "Buy" ? (amountIn * NEAR_UNIT) / p : (amountIn * p) / NEAR_UNIT;
  return (gross * BigInt(10_000 - costBps)) / 10_000n;
}

/** A 1Click dry quote: what the client would receive through NEAR Intents for `amountIn`. */
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

export type Reference = { out: bigint; mid: number; source: "1click" | "replay" };

/**
 * What NEAR Intents would give for this order, and the mid behind it. Live by default; the replay
 * price (with the measured 1Click cost) when offline, under REPLAY=1, or when 1Click fails.
 */
export async function reference(side: Side, amountIn: bigint, replayIndex = -1): Promise<Reference> {
  const fx = replayPrices();
  const replayMid = fx.prices[replayIndex >= 0 ? replayIndex % fx.prices.length : fx.prices.length - 1];
  if (process.env.REPLAY !== "1" && replayIndex < 0) {
    try {
      const out = await oneClickQuote(side, amountIn);
      // Back out the mid: the quote already carries the 1Click cost.
      const gross = (out * 10_000n) / BigInt(10_000 - ONECLICK_COST_BPS);
      const mid = side === "Buy" ? Number(amountIn) / 1e6 / (Number(gross) / 1e24) : Number(gross) / 1e6 / (Number(amountIn) / 1e24);
      return { out, mid, source: "1click" };
    } catch {}
  }
  return { out: outAt(side, amountIn, replayMid, ONECLICK_COST_BPS), mid: replayMid, source: "replay" };
}
