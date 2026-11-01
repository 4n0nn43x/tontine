// Run: cd app && npx tsx src/lib/ai.check.ts
import type { AppState, ShadowView } from "./api";
import { ruleText, verdict, worstRegime } from "./ai";

function equal(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

equal(ruleText({ when: { kind: "price_move", windowMin: 60, belowPct: -4 }, then: { pause: true }, note: "" }, "NEAR"), "NEAR -4% in 1 h → pause");
equal(ruleText({ when: { kind: "inventory_share", above: 0.5 }, then: { targetAssetShare: 0.5 }, note: "" }, "ETH"), "ETH over 50% → target 50% ETH");
equal(ruleText({ when: { kind: "regime", atLeast: "alert" }, then: { spreadMinBps: 20 }, note: "" }, "SOL"), "alert or storm → spread at least 20 bp");
equal(ruleText({ when: { kind: "cash_vs_floor", belowRatio: 1.5 }, then: { pause: true, maxOrderUsd: 50 }, note: "" }, "NEAR"), "cash under 1.5x the floor → pause, orders up to 50 USDC");

const state = (level?: string) => ({ regime: level ? { level, since: 0, reasons: [], source: "volatility" } : undefined }) as unknown as AppState;
equal(worstRegime({ NEAR: state("alert"), ETH: state("storm"), SOL: null }), "storm");
equal(worstRegime({ NEAR: state(), ETH: null }), "calm");

const arm = (wins: number, edge: number) => ({ auctions: 10, wins, delivered: "0", edge: String(edge) });
const shadow = (manager: ShadowView["manager"], a: number, r: number, f: number): ShadowView => ({ manager, arms: { actual: arm(3, a), rule: arm(3, r), fixed: arm(3, f) } });
equal(verdict({ manager: "llm", arms: { actual: { ...arm(0, 0), auctions: 0 }, rule: { ...arm(0, 0), auctions: 0 }, fixed: { ...arm(0, 0), auctions: 0 } } }), "No auction replayed yet.");
equal(verdict(shadow("llm", 30_000, 10_000, 20_000)), "The LLM leads the rule by 0.0200 and fixed params by 0.0100 USDC over 10 auctions.");
equal(verdict(shadow("bandit", 10_000, 25_000, 5_000)), "The bandit trails the rule by 0.0150 USDC over 10 auctions: no edge from it yet.");
equal(verdict(shadow("rule", 10_000, 10_000, 4_000)), "The stated rule manages it: ahead of fixed params by 0.0060 USDC over 10 auctions.");
console.log("ai checks pass");
