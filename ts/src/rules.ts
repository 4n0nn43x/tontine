// The order rules of contracts/tender, in TypeScript (see RULES.md). The swarm checks a bid with them
// before revealing it (a refused reveal costs the owner's bond) and the simulation (sim.ts) clears orders
// with them. Any change here must follow lib.rs; tests in rules.test.ts use the contract's own vectors.

export const BPS = 10_000n;
export type Side = "Buy" | "Sell";
export type Policy = { max_asset_bps: number; band_bps: number; paused: boolean };

/** Winner (highest bid, earliest on ties) and what it delivers: the second best, or the reserve if alone. */
export function clear(bids: bigint[], reserve: bigint): { winner: number; out: bigint } | null {
  const order = bids.map((v, i) => ({ v, i })).sort((a, b) => (b.v > a.v ? 1 : b.v < a.v ? -1 : a.i - b.i));
  if (!order.length) return null;
  return { winner: order[0].i, out: order.length > 1 ? order[1].v : reserve };
}

/** Stable base units per asset unit implied by delivering `out` for `amountIn`. */
export function impliedPrice(side: Side, amountIn: bigint, out: bigint, unit: bigint): bigint {
  return side === "Buy" ? (amountIn * unit) / out : (out * unit) / amountIn;
}

export const value = (asset: bigint, price: bigint, unit: bigint) => (asset * price) / unit;

/** The owner's band: the bid's price within `band_bps` of the last clearing price (0 = no band). */
export function inBand(price: bigint, last: bigint, bandBps: number): boolean {
  if (bandBps === 0) return true;
  const diff = price > last ? price - last : last - price;
  return diff * BPS <= BigInt(bandBps) * last;
}

/** The owner's inventory cap, checked on sells (the firm receives the asset). */
export function inventoryOk(side: Side, amountIn: bigint, out: bigint, firm: { stable: bigint; asset: bigint }, last: bigint, unit: bigint, maxAssetBps: number): boolean {
  if (side === "Buy") return true;
  const asset = value(firm.asset + amountIn, last, unit);
  const stable = firm.stable > out ? firm.stable - out : 0n;
  return asset * BPS <= BigInt(maxAssetBps) * (stable + asset);
}

/** What the winner gains on a fill, valued at the previous clearing price, after Tontine's fee. */
export function edge(side: Side, amountIn: bigint, out: bigint, feeBps: number, last: bigint, unit: bigint): bigint {
  const fee = (amountIn * BigInt(feeBps)) / BPS;
  return side === "Buy" ? amountIn - fee - value(out, last, unit) : value(amountIn - fee, last, unit) - out;
}

/** Everything the contract checks when a bid is revealed, in its order. Null when it would pass. */
export function revealRefusal(
  side: Side,
  amountIn: bigint,
  minOut: bigint,
  out: bigint,
  firm: { stable: bigint; asset: bigint; status?: string; policy: Policy; owed?: bigint },
  last: bigint,
  unit: bigint,
): string | null {
  if (out < minOut) return "bid below reserve";
  if (firm.status === "Liquidating" || firm.status === "Closed") return "firm in liquidation or closed";
  if (!inBand(impliedPrice(side, amountIn, out, unit), last, firm.policy.band_bps)) return "bid outside the firm's price band";
  if (side === "Sell" && firm.stable - out < (firm.owed ?? 0n)) return "the firm must keep the cash it owes its lenders";
  if (!inventoryOk(side, amountIn, out, firm, last, unit, firm.policy.max_asset_bps)) return "fill over the firm's inventory limit";
  if ((side === "Buy" ? firm.asset : firm.stable) < out) return "insufficient balance";
  return null;
}
