// A firm's manager: from its recent results it retunes the params its quotes use (strategy.ts).
// Live (NEARAI_API_KEY, else ANTHROPIC_API_KEY for Claude): an LLM answers in JSON, and the firm pays the
// inference from its treasury (swarm.ts). Without a key: a stated rule, labelled "rule", never presented as AI.
// A third kind, "bandit", is a UCB1 bandit on the spread: no LLM, no inference cost.
// The owner's on-chain policy bounds whatever comes out, and the contract enforces it on every bid.
import type { Llm } from "./llm.ts";
import type { Params } from "./strategy.ts";

export type Results = {
  /** Orders it quoted and orders it filled since the last decision. */
  quoted: number;
  filled: number;
  /** Orders it was offered (could have quoted) since the last decision: the bandit's denominator, `quoted` if absent. */
  orders?: number;
  /** Sum of its fills' edges since the last decision (stable base units). */
  edge: bigint;
  /** Share of its net asset value held in NEAR now. */
  assetShare: number;
};

export type Decision = {
  firm: string;
  at: number;
  source: "near-ai-cloud" | "anthropic" | "rule" | "bandit";
  before: Params;
  after: Params;
  reason: string;
  chatId?: string;
  model?: string;
  /** The LLM's TEE signature payload (NEAR AI Cloud), when it has one. */
  signature?: unknown;
};

const clamp = (x: number, lo: number, hi: number, fallback: number) => (Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : fallback);

/** Keep params sane: spread 1 to 300 bp, target within the owner's inventory cap, skew 0 to 100 bp. */
export function bound(next: Params, prev: Params, maxAssetShare: number): Params {
  return {
    spreadBps: Math.round(clamp(next.spreadBps, 1, 300, prev.spreadBps)),
    targetAssetShare: clamp(next.targetAssetShare, 0.05, Math.min(0.9, maxAssetShare), prev.targetAssetShare),
    skewBps: Math.round(clamp(next.skewBps, 0, 100, prev.skewBps)),
  };
}

/** The rule: losing money widens the spread, winning too few orders tightens it. */
export function rule(p: Params, r: Results): { params: Params; reason: string } {
  const usdc = (Number(r.edge) / 1e6).toFixed(2);
  if (r.edge < 0n) return { params: { ...p, spreadBps: p.spreadBps * 1.3 }, reason: `lost ${usdc} USDC on ${r.filled} fills: widen the spread` };
  if (r.quoted >= 3 && r.filled / r.quoted < 0.2) return { params: { ...p, spreadBps: p.spreadBps * 0.8 }, reason: `filled ${r.filled} of ${r.quoted} orders quoted: tighten the spread` };
  return { params: p, reason: `filled ${r.filled} of ${r.quoted}, edge ${usdc} USDC: keep the params` };
}

/** The bandit's spreads (bp), one arm each. */
export const BANDIT_ARMS = [4, 6, 8, 10, 12, 15, 20, 30];
/**
 * Reward bound S, USDC per order offered: a reward is clipped to [-S, S], then mapped to [0, 1] as (x / S + 1) / 2,
 * the range UCB1 assumes. 0.1 holds about 90% of hourly periods in `make bench` (all arms, 14 weeks, seed 1).
 */
export const BANDIT_SCALE = 0.1;

/** A firm's bandit, plain JSON: the arm in play (-1 before the first pick), then periods and clipped reward sums per arm. */
export type BanditState = { arm: number; pulls: number[]; sums: number[] };
export const newBandit = (): BanditState => ({ arm: -1, pulls: BANDIT_ARMS.map(() => 0), sums: BANDIT_ARMS.map(() => 0) });

/**
 * UCB1 (Auer, Cesa-Bianchi and Fischer 2002) over BANDIT_ARMS, after Abernethy and Kale, "Adaptive market
 * making via online learning" (NeurIPS 2013). The period's reward goes to the arm in play: its edge in USDC
 * per order offered, normalised as BANDIT_SCALE says; a period with no order offered is skipped. Per order
 * offered, not quoted: a spread too wide to quote must score 0, not stall the bandit on it.
 * Next arm: the first untried one, else the highest mean + sqrt(2 ln t / n), the tighter spread on ties.
 * Only the spread moves. Pure: same state and results, same answer.
 * ponytail: stationary UCB1; a discounted or sliding-window UCB if rivals keep moving their spreads.
 */
export function banditDecide(s: BanditState, p: Params, r: Results): { state: BanditState; params: Params; reason: string } {
  const pulls = [...s.pulls];
  const sums = [...s.sums];
  const orders = r.orders ?? r.quoted;
  if (s.arm >= 0 && orders > 0) {
    pulls[s.arm]++;
    sums[s.arm] += Math.max(-BANDIT_SCALE, Math.min(BANDIT_SCALE, Number(r.edge) / 1e6 / orders));
  }
  const t = pulls.reduce((a, b) => a + b, 0);
  const ucb = (i: number) => (pulls[i] ? (sums[i] / pulls[i] / BANDIT_SCALE + 1) / 2 + Math.sqrt((2 * Math.log(t)) / pulls[i]) : Infinity);
  let arm = 0;
  for (let i = 1; i < BANDIT_ARMS.length; i++) if (ucb(i) > ucb(arm)) arm = i;
  const bp = BANDIT_ARMS[arm];
  const reason = pulls[arm] ? `arm ${bp} bp: mean edge ${(sums[arm] / pulls[arm]).toFixed(3)} USDC/order over ${pulls[arm]} periods` : `arm ${bp} bp: untried, explore`;
  return { state: { arm, pulls, sums }, params: { ...p, spreadBps: bp }, reason };
}

const SYSTEM =
  "You manage the pricing of an AI market-making firm on NEAR. It quotes NEAR/USDC swap orders in sealed-bid auctions: " +
  "the best quote fills at the second-best one, and an order only fills if it beats the client's minimum, set just under the market price." +
  "Each period you get its current params and results. Answer with JSON only: " +
  '{"spreadBps": number, "targetAssetShare": number, "skewBps": number, "reason": string}. ' +
  "Keep the firm solvent first, then grow its edge. The owner's policy caps whatever you choose.";

/** One decision. With `bandit` (the firm's state, updated in place) the bandit decides; else the LLM, else the rule. */
export async function decide(llm: Llm | null, firm: string, p: Params, r: Results, maxAssetShare: number, bandit?: BanditState): Promise<Decision> {
  const base = { firm, at: Date.now(), before: p };
  if (bandit) {
    const b = banditDecide(bandit, p, r);
    Object.assign(bandit, b.state);
    return { ...base, source: "bandit", after: bound(b.params, p, maxAssetShare), reason: b.reason };
  }
  if (llm) {
    const user = JSON.stringify({ params: p, results: { quoted: r.quoted, filled: r.filled, edge_usdc: Number(r.edge) / 1e6, asset_share: Number(r.assetShare.toFixed(3)) } });
    const c = await llm.complete(SYSTEM, user);
    if (c.source !== "replay") {
      try {
        const j = JSON.parse(c.text.slice(c.text.indexOf("{"), c.text.lastIndexOf("}") + 1));
        const next = { spreadBps: Number(j.spreadBps), targetAssetShare: Number(j.targetAssetShare), skewBps: Number(j.skewBps) };
        return { ...base, source: c.source, after: bound(next, p, maxAssetShare), reason: String(j.reason ?? "").slice(0, 280), chatId: c.chatId, model: c.model, ...(c.signature ? { signature: c.signature } : {}) };
      } catch {}
    }
  }
  const { params, reason } = rule(p, r);
  return { ...base, source: "rule", after: bound(params, p, maxAssetShare), reason };
}
