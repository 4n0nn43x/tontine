// The light game layer over chain data: ranks, levels, badges, cash health and the visitor's own wins.
// Pure functions of the state and events, checked by achievements.check.ts.
import { nameOf, weatheredOf, type ChainEvent, type FirmState } from "./api";
import { bpOver, bpText, clientOut, gotText, NEAR_ASSET, usdc, type Asset } from "./format";

/** Level L needs L(L-1)/2 fills: level 2 at 1 fill, 3 at 3, 4 at 6, 5 at 10... */
export function levelOf(fills: number) {
  const n = Math.max(0, Math.floor(fills));
  const level = Math.floor((1 + Math.sqrt(1 + 8 * n)) / 2);
  const into = n - (level * (level - 1)) / 2;
  return { level, into, span: level, progress: into / level };
}

export type Health = "good" | "warn" | "bad";

/** Red under the cash floor, amber under 125% of it, green above. */
export function healthOf(cash: bigint, floor: bigint): Health {
  if (cash < floor) return "bad";
  return cash * 4n < floor * 5n ? "warn" : "good";
}

const cmp = (a: bigint, b: bigint) => (a > b ? -1 : a < b ? 1 : 0);

/** The leaderboard: closed firms last, then edge, fills, dividends paid, oldest first. */
export function rankFirms(firms: FirmState[]): FirmState[] {
  return [...firms].sort(
    (a, b) =>
      Number(a.status === "Closed") - Number(b.status === "Closed") ||
      cmp(BigInt(a.edge), BigInt(b.edge)) ||
      b.fills - a.fills ||
      cmp(BigInt(a.dividends), BigInt(b.dividends)) ||
      a.id - b.id,
  );
}

export type Achievement = { id: string; label: string; icon: string; tip: string };

/** Badges per firm id, from the firms and recent chain events. */
export function achievements(firms: FirmState[], events: ChainEvent[]): Map<number, Achievement[]> {
  const bps = new Map<number, number[]>();
  const soldAt = new Map<number, number>(); // firm id -> event id of its last takeover
  const comeback = new Set<number>();
  const raiders = new Set<number>();
  const listed = new Set<number>(); // put up for sale in the window
  for (const e of events) {
    const d = e.data ?? {};
    if (e.event === "order_filled") {
      const bp = bpOver(clientOut(d), d.reference_out);
      if (bp !== null) bps.set(d.firm_id, [...(bps.get(d.firm_id) ?? []), bp]);
      if (soldAt.has(d.firm_id)) comeback.add(d.firm_id);
    } else if (e.event === "liquidated") {
      soldAt.set(d.firm_id, e.id);
      raiders.add(d.buyer_firm_id);
    } else if (e.event === "liquidation_started") listed.add(d.firm_id);
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sharpest = [...bps].filter(([, xs]) => avg(xs) > 0).sort((a, b) => avg(b[1]) - avg(a[1]))[0];
  const topPayer = firms.filter((f) => BigInt(f.dividends) > 0n).sort((a, b) => cmp(BigInt(a.dividends), BigInt(b.dividends)))[0];

  const out = new Map<number, Achievement[]>();
  for (const f of firms) {
    const list: Achievement[] = [];
    const tier = [100, 50, 10].find((n) => f.fills >= n);
    if (tier) list.push({ id: `fills-${tier}`, label: `${tier} fills`, icon: tier === 100 ? "fa-trophy" : tier === 50 ? "fa-medal" : "fa-fire", tip: `Filled ${tier} orders or more` });
    else if (f.fills > 0) list.push({ id: "first-fill", label: "First fill", icon: "fa-flag-checkered", tip: "Won and filled its first order" });
    // After a takeover the buyer firm holds all 100 shares of the firm it bought.
    if (raiders.has(f.id) || firms.some((g) => g.id !== f.id && g.holdings.some((h) => h.account === f.account)))
      list.push({ id: "raider", label: "Raider", icon: "fa-chess-knight", tip: "Bought a rival in a takeover" });
    if (f.fills >= 10 && f.takeovers === 0 && f.status === "Solvent" && !listed.has(f.id))
      list.push({ id: "survivor", label: "Survivor", icon: "fa-shield-halved", tip: "10+ fills, never put up for sale" });
    if (comeback.has(f.id) && f.status === "Solvent") list.push({ id: "comeback", label: "Comeback", icon: "fa-rotate", tip: "Filled an order again after its takeover" });
    if (topPayer?.id === f.id) list.push({ id: "dividends", label: "Dividend machine", icon: "fa-sack-dollar", tip: "Paid the most dividends of all firms" });
    if (sharpest?.[0] === f.id) list.push({ id: "sharpest", label: "Sharpest quote", icon: "fa-crosshairs", tip: `Best average price vs market: ${bpText(avg(sharpest[1]))}` });
    const sat = weatheredOf(f);
    if (sat > 0) list.push({ id: "weathered", label: "Weathered the storm", icon: "fa-cloud-bolt", tip: `Its mandate kept it out of ${sat} order${sat === 1 ? "" : "s"} in a storm` });
    out.set(f.id, list);
  }
  return out;
}

export type Cheer = { icon: string; title: string; text: string };

/** A toast for the visitor's own wins: their order filled, dividends they claimed, an auction their firm won. */
export function cheerFor(e: ChainEvent, me: string, firms: FirmState[], clientOf: (orderId: number) => string | undefined, a: Asset = NEAR_ASSET): Cheer | null {
  if (e.standard !== "tontine") return null;
  const d = e.data ?? {};
  const firm = (id: number) => nameOf(firms.find((f) => f.id === id), id);
  if (e.event === "order_filled" && clientOf(d.order_id) === me) {
    const bp = bpOver(clientOut(d), d.reference_out);
    return { icon: "fa-right-left", title: "Order filled", text: `${a.symbol} #${d.order_id}: ${gotText(d.side, clientOut(d), a)} from ${firm(d.firm_id)}${bp !== null && bp > 0 ? `, ${bpText(bp)} vs market` : ""}` };
  }
  if (e.event === "dividend_claimed" && d.account === me) return { icon: "fa-hand-holding-dollar", title: "Dividends received", text: `+${usdc(d.amount, 4)} USDC from ${firm(d.firm_id)}` };
  if (e.event === "auction_settled" && d.winner !== null && firms.find((f) => f.id === d.winner)?.owner === me)
    return { icon: "fa-gavel", title: "Your firm won", text: `${firm(d.winner)} took auction #${d.auction_id}` };
  return null;
}
