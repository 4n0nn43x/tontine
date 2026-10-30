import type { ChainEvent, Side } from "./api";
import { FIRMS, EXTRA_SLOTS } from "../scene/story.js";

export const USDC_DECIMALS = 6;
export const NEAR_DECIMALS = 24;

export function usdc(base: string | number | bigint | null | undefined, digits = 2): string {
  if (base === null || base === undefined) return "–";
  const n = Number(BigInt(String(base))) / 10 ** USDC_DECIMALS;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** NEAR or wNEAR from yocto (24 decimals), 4 decimals by default. */
export function near(yocto: string | number | bigint | null | undefined, digits = 4): string {
  if (yocto === null || yocto === undefined) return "–";
  const n = Number(BigInt(String(yocto)) / 10n ** 16n) / 1e8;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** "4.50" to base units: 6 decimals for USDC, 24 for NEAR. */
export function toBase(amount: string, decimals = USDC_DECIMALS): bigint {
  const [i, f = ""] = amount.trim().split(".");
  if (!/^\d+$/.test(i || "0") || !/^\d*$/.test(f)) throw new Error("not a number");
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals));
}

/** A buy pays USDC and receives NEAR; a sell pays NEAR and receives USDC. */
export const paidText = (side: Side, v: string | bigint | null | undefined) => (side === "Buy" ? `${usdc(v)} USDC` : `${near(v)} NEAR`);
/** What an order delivers, 4 decimals in both tokens: fills differ from the 1Click reference by a few bp. */
export const gotText = (side: Side, v: string | bigint | null | undefined) => (side === "Buy" ? `${near(v)} NEAR` : `${usdc(v, 4)} USDC`);

/** How much better `out` is than `ref`, in basis points. */
export function bpOver(out: string | bigint | null | undefined, ref: string | bigint | null | undefined): number | null {
  if (out === null || out === undefined || !ref || BigInt(ref) === 0n) return null;
  return (Number(BigInt(out) - BigInt(ref)) / Number(BigInt(ref))) * 1e4;
}

export const bpText = (x: number | null) => (x === null ? "–" : `${x >= 0 ? "+" : ""}${x.toFixed(1)} bp`);

/** USD per NEAR implied by a fill or a quote. */
export function priceOf(side: Side, amountIn: string | bigint, out: string | bigint): number {
  const usd = Number(side === "Buy" ? amountIn : out) / 1e6;
  const nearAmt = Number(side === "Buy" ? out : amountIn) / 1e24;
  return nearAmt ? usd / nearAmt : 0;
}

export function short(account: string, max = 22): string {
  if (!account) return "";
  return account.length <= max ? account : `${account.slice(0, max - 9)}…${account.slice(-8)}`;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function firmColor(name: string | undefined, index = 0): string {
  return FIRMS.find((f: any) => f.name === name)?.color ?? EXTRA_SLOTS[index % EXTRA_SLOTS.length].color;
}

export type Described = { icon: string; tone: "" | "good" | "bad" | "accent"; text: string; orderId?: number; firmId?: number };

/**
 * An amount revealed or cleared in an auction: what an order delivers (NEAR for a buy, USDC for a sell), or
 * USDC for a takeover. Without the order's side, an amount above 10^15 base units can only be yocto NEAR.
 */
export function auctionAmount(amount: string, side: Side | undefined): string {
  if (side) return gotText(side, amount);
  return BigInt(amount) > 10n ** 15n ? `${near(amount)} NEAR` : `${usdc(amount)} USDC`;
}

/** One human sentence per chain event. `firm(id)` resolves a firm id to its name, `sideOf` an auction to its order side. */
export function describe(e: ChainEvent, firm: (id: number) => string, sideOf: (auctionId: number) => Side | undefined = () => undefined): Described | null {
  const d = e.data ?? {};
  if (e.standard === "tontine") {
    switch (e.event) {
      case "order_posted":
        return {
          icon: d.side === "Buy" ? "fa-arrow-right-to-bracket" : "fa-arrow-right-from-bracket",
          tone: "accent",
          text: `Order #${d.order_id}: ${d.side === "Buy" ? `buy NEAR with ${usdc(d.amount_in)} USDC` : `sell ${near(d.amount_in)} NEAR`}, at least ${gotText(d.side, d.min_out)}`,
          orderId: d.order_id,
        };
      case "bid_committed":
        return { icon: "fa-lock", tone: "", text: `${firm(d.firm_id)} sealed a bid`, firmId: d.firm_id };
      case "bid_revealed":
        return { icon: "fa-lock-open", tone: "", text: `${firm(d.firm_id)} revealed ${auctionAmount(d.amount, sideOf(d.auction_id))}`, firmId: d.firm_id };
      case "auction_settled":
        return d.winner === null
          ? { icon: "fa-ban", tone: "", text: `Auction #${d.auction_id} closed without a winner` }
          : { icon: "fa-gavel", tone: "accent", text: `${firm(d.winner)} wins auction #${d.auction_id} at the 2nd best, ${auctionAmount(d.price, sideOf(d.auction_id))}`, firmId: d.winner };
      case "order_filled": {
        const vs = bpOver(d.out, d.reference_out);
        return {
          icon: "fa-right-left",
          tone: "good",
          text: `Order #${d.order_id} filled by ${firm(d.firm_id)}: ${gotText(d.side, d.out)} for ${paidText(d.side, d.amount_in)}${vs === null ? "" : `, ${bpText(vs)} vs 1Click`}, edge ${usdc(d.edge, 4)} USDC`,
          orderId: d.order_id,
          firmId: d.firm_id,
        };
      }
      case "order_refunded":
        return { icon: "fa-rotate-left", tone: "", text: `Order #${d.order_id} refunded: no quote beat the minimum`, orderId: d.order_id };
      case "slashed":
        return { icon: "fa-scissors", tone: "bad", text: `${firm(d.firm_id)}: owner bond slashed ${usdc(d.amount)} USDC to the client (${d.reason})`, orderId: d.order_id, firmId: d.firm_id };
      case "liquidation_started":
        return { icon: "fa-triangle-exclamation", tone: "bad", text: `${firm(d.firm_id)} is in liquidation: its cash stayed under the floor`, firmId: d.firm_id };
      case "liquidated":
        return {
          icon: "fa-handshake",
          tone: "accent",
          text: `${firm(d.buyer_firm_id)} bought ${firm(d.firm_id)} for ${usdc(d.price)} USDC; ${usdc(d.to_shareholders)} USDC and ${near(d.asset_to_shareholders)} NEAR to its shareholders`,
          firmId: d.firm_id,
        };
      case "firm_closed":
        return { icon: "fa-door-closed", tone: "bad", text: `${firm(d.firm_id)} closed (${d.reason}): ${usdc(d.to_shareholders)} USDC and ${near(d.asset_to_shareholders ?? 0)} NEAR to its shareholders`, firmId: d.firm_id };
      case "policy": {
        const p = d.policy ?? {};
        return {
          icon: "fa-sliders",
          tone: "",
          text: `${firm(d.firm_id)} policy: ${p.band_bps ? `band ±${p.band_bps / 100}%` : "no band"}, at most ${p.max_asset_bps / 100}% in NEAR${p.paused ? ", paused" : ""}`,
          firmId: d.firm_id,
        };
      }
      case "dividend_claimed":
        return { icon: "fa-hand-holding-dollar", tone: "good", text: `${short(d.account)} received ${usdc(d.amount)} USDC of dividends from ${firm(d.firm_id)}`, firmId: d.firm_id };
      case "shares_bought":
        return { icon: "fa-chart-pie", tone: "accent", text: `${short(d.buyer)} bought ${d.amount} shares of ${firm(d.firm_id)}`, firmId: d.firm_id };
      case "shares_listed":
        return { icon: "fa-tag", tone: "", text: `${d.amount} shares of ${firm(d.firm_id)} listed at ${usdc(d.price_per_share)} USDC`, firmId: d.firm_id };
      case "loan":
        return { icon: "fa-building-columns", tone: "", text: `${short(d.lender)} lent ${usdc(d.amount)} USDC to ${firm(d.firm_id)}${d.rate_bps ? ` at ${d.rate_bps / 100}% a year` : ""}`, firmId: d.firm_id };
      case "loan_terms":
        return { icon: "fa-percent", tone: "", text: `${firm(d.firm_id)} borrows at ${d.rate_bps / 100}% a year, up to ${usdc(d.cap)} USDC`, firmId: d.firm_id };
      case "creditor_paid":
        return { icon: "fa-building-columns", tone: "good", text: `${short(d.creditor)} repaid ${usdc(d.amount)} USDC by ${firm(d.firm_id)}`, firmId: d.firm_id };
      case "firm_registered":
        return { icon: "fa-building", tone: "accent", text: `${short(d.owner)} launched firm #${d.firm_id}`, firmId: d.firm_id };
      case "firm_profile":
        return { icon: "fa-id-card", tone: "", text: `${firm(d.firm_id)} published its spec`, firmId: d.firm_id };
      case "keeper_paid":
        return { icon: "fa-gears", tone: "", text: `${short(d.keeper)} earned ${usdc(d.amount)} USDC for keeping the market moving` };
      case "deposit":
        return { icon: "fa-arrow-down", tone: "", text: `${short(d.account)} deposited ${d.token === "asset" ? `${near(d.amount)} wNEAR` : `${usdc(d.amount)} USDC`}` };
      case "withdraw":
        return { icon: "fa-arrow-up", tone: "", text: `${short(d.account)} withdrew ${d.token === "asset" ? `${near(d.amount)} wNEAR` : `${usdc(d.amount)} USDC`}` };
    }
    return null;
  }
  if (e.standard === "tontine-firm" && e.event === "spend") {
    return { icon: "fa-microchip", tone: "", text: `${short(e.contract)} paid ${usdc(d.amount)} USDC of inference` };
  }
  return null;
}
