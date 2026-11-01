// Pure helpers of the AI layer's views (components/Ai.tsx), checked by ai.check.ts.
import { regimeOf, SYMBOLS, type AppState, type MandateRule, type MarketSymbol, type RegimeLevel, type ShadowView } from "./api";
import { usdc } from "./format";

const RANK: Record<RegimeLevel, number> = { calm: 0, alert: 1, storm: 2 };

/** The worst regime across the markets: the city's weather. */
export const worstRegime = (states: Partial<Record<MarketSymbol, AppState | null>>): RegimeLevel =>
  SYMBOLS.map((s) => regimeOf(states[s])?.level ?? "calm").reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "calm");

const pct = (x: number) => `${Math.round(x * 100)}%`;
const mins = (m: number) => (m % 60 === 0 ? `${m / 60} h` : `${m} min`);

/** A compiled rule in a few words: "NEAR -4% in 1 h → pause". */
export function ruleText(r: MandateRule, asset: string): string {
  const w = r.when;
  const either = (xs: (string | false)[]) => xs.filter(Boolean).join(" or ");
  const when =
    w.kind === "price_move"
      ? `${either([w.belowPct !== undefined && `${asset} ${w.belowPct}%`, w.abovePct !== undefined && `${asset} +${w.abovePct}%`])} in ${mins(w.windowMin)}`
      : w.kind === "inventory_share"
        ? either([w.above !== undefined && `${asset} over ${pct(w.above)}`, w.below !== undefined && `${asset} under ${pct(w.below)}`])
        : w.kind === "cash_vs_floor"
          ? `cash under ${w.belowRatio}x the floor`
          : w.atLeast === "storm"
            ? "storm"
            : "alert or storm";
  const t = r.then;
  const then = [
    t.pause && "pause",
    t.spreadMinBps !== undefined && `spread at least ${t.spreadMinBps} bp`,
    t.spreadMaxBps !== undefined && `spread at most ${t.spreadMaxBps} bp`,
    t.targetAssetShare !== undefined && `target ${pct(t.targetAssetShare)} ${asset}`,
    t.maxOrderUsd !== undefined && `orders up to ${t.maxOrderUsd} USDC`,
  ].filter(Boolean);
  return `${when} → ${then.join(", ")}`;
}

/** One honest line on the shadow scoreboard: the actual manager against the stated rule and fixed params. */
export function verdict(s: ShadowView): string {
  const n = Math.max(s.arms.actual.auctions, s.arms.rule.auctions, s.arms.fixed.auctions);
  if (!n) return "No auction replayed yet.";
  const over = `over ${n} auction${n === 1 ? "" : "s"}`;
  const edge = (k: "actual" | "rule" | "fixed") => BigInt(s.arms[k].edge);
  const vs = (k: "rule" | "fixed") => edge("actual") - edge(k);
  const abs = (x: bigint) => usdc(x < 0n ? -x : x, 4);
  if (s.manager === "rule")
    return vs("fixed") === 0n ? `The stated rule manages it: even with fixed params ${over}.` : `The stated rule manages it: ${vs("fixed") > 0n ? "ahead of" : "behind"} fixed params by ${abs(vs("fixed"))} USDC ${over}.`;
  const who = s.manager === "llm" ? "The LLM" : "The bandit";
  const [r, f] = [vs("rule"), vs("fixed")];
  if (r > 0n && f > 0n) return `${who} leads the rule by ${abs(r)} and fixed params by ${abs(f)} USDC ${over}.`;
  if (r === 0n && f === 0n) return `${who} has done exactly what the rule and fixed params would have ${over}.`;
  const [k, d] = r <= f ? (["rule", r] as const) : (["fixed params", f] as const);
  return d < 0n ? `${who} trails the ${k} by ${abs(d)} USDC ${over}: no edge from it yet.` : `${who} is even with the ${k} ${over}.`;
}
