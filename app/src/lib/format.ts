import type { ChainEvent } from "./api";
import { FIRMS, EXTRA_SLOTS } from "../scene/story.js";

export const USDC_DECIMALS = 6;

export function usdc(base: string | number | bigint | null | undefined, digits = 2): string {
  if (base === null || base === undefined) return "–";
  const n = Number(BigInt(String(base))) / 10 ** USDC_DECIMALS;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function toBase(amount: string): bigint {
  const [i, f = ""] = amount.trim().split(".");
  if (!/^\d+$/.test(i || "0") || !/^\d*$/.test(f)) throw new Error("not a number");
  return BigInt(i || "0") * 10n ** 6n + BigInt((f + "000000").slice(0, 6));
}

export function near(yocto: string): string {
  return (Number(BigInt(yocto) / 10n ** 20n) / 1e4).toFixed(2);
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

export type Described = { icon: string; tone: "" | "good" | "bad" | "accent"; text: string; jobId?: number; firmId?: number };

/** One human sentence per chain event. `firm(id)` resolves a firm id to its name. */
export function describe(e: ChainEvent, firm: (id: number) => string): Described | null {
  const d = e.data ?? {};
  if (e.standard === "tontine") {
    switch (e.event) {
      case "job_posted":
        return { icon: "fa-briefcase", tone: "accent", text: `Job #${d.job_id} posted, ${usdc(d.budget)} USDC in escrow`, jobId: d.job_id };
      case "bid_committed":
        return { icon: "fa-lock", tone: "", text: `${firm(d.firm_id)} sealed a bid`, firmId: d.firm_id };
      case "bid_revealed":
        return { icon: "fa-lock-open", tone: "", text: `${firm(d.firm_id)} revealed ${usdc(d.amount)} USDC`, firmId: d.firm_id };
      case "auction_settled":
        return d.winner === null
          ? { icon: "fa-ban", tone: "", text: `Auction #${d.auction_id} closed without bids` }
          : { icon: "fa-gavel", tone: "accent", text: `${firm(d.winner)} wins at the 2nd price, ${usdc(d.price)} USDC`, firmId: d.winner };
      case "delivered":
        return d.result
          ? { icon: "fa-box", tone: "", text: `${firm(d.firm_id)} delivered job #${d.job_id}`, jobId: d.job_id, firmId: d.firm_id }
          : { icon: "fa-box-open", tone: "bad", text: `${firm(d.firm_id)} delivered nothing on job #${d.job_id}`, jobId: d.job_id, firmId: d.firm_id };
      case "paid":
        return { icon: "fa-coins", tone: "good", text: `Job #${d.job_id} paid ${usdc(d.price)} USDC, ${usdc(d.dividends)} to shareholders`, jobId: d.job_id, firmId: d.firm_id };
      case "slashed":
        return { icon: "fa-scissors", tone: "bad", text: `${firm(d.firm_id)} rejected: owner bond slashed ${usdc(d.amount)} USDC`, jobId: d.job_id, firmId: d.firm_id };
      case "liquidation_started":
        return { icon: "fa-triangle-exclamation", tone: "bad", text: `${firm(d.firm_id)} is in liquidation`, firmId: d.firm_id };
      case "liquidated":
        return { icon: "fa-handshake", tone: "accent", text: `${firm(d.buyer_firm_id)} bought ${firm(d.firm_id)} for ${usdc(d.price)} USDC`, firmId: d.firm_id };
      case "dividend_claimed":
        return { icon: "fa-hand-holding-dollar", tone: "good", text: `${short(d.account)} received ${usdc(d.amount)} USDC of dividends from ${firm(d.firm_id)}`, firmId: d.firm_id };
      case "shares_bought":
        return { icon: "fa-chart-pie", tone: "accent", text: `${short(d.buyer)} bought ${d.amount} shares of ${firm(d.firm_id)}`, firmId: d.firm_id };
      case "shares_listed":
        return { icon: "fa-tag", tone: "", text: `${d.amount} shares of ${firm(d.firm_id)} listed at ${usdc(d.price_per_share)} USDC`, firmId: d.firm_id };
      case "loan":
        return { icon: "fa-building-columns", tone: "", text: `${short(d.lender)} lent ${usdc(d.amount)} USDC to ${firm(d.firm_id)}`, firmId: d.firm_id };
      case "deposit":
        return { icon: "fa-arrow-down", tone: "", text: `${short(d.account)} deposited ${usdc(d.amount)} USDC` };
      case "withdraw":
        return { icon: "fa-arrow-up", tone: "", text: `${short(d.account)} withdrew ${usdc(d.amount)} USDC` };
      case "verdict_timeout":
        return { icon: "fa-hourglass-end", tone: "", text: `Job #${d.job_id} cancelled: no verdict in time`, jobId: d.job_id };
    }
    return null;
  }
  if (e.standard === "tontine-firm" && e.event === "spend") {
    return { icon: "fa-microchip", tone: "", text: `${short(e.contract)} paid ${usdc(d.amount)} USDC of inference` };
  }
  return null;
}
