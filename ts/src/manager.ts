// A firm's manager: from its recent results it retunes the params its quotes use (strategy.ts).
// Live (NEARAI_API_KEY): an LLM on NEAR AI Cloud answers in JSON, and the firm pays the inference from its
// treasury (swarm.ts). Without a key: a stated rule, labelled "rule", never presented as AI.
// The owner's on-chain policy bounds whatever comes out, and the contract enforces it on every bid.
import type { Llm } from "./llm.ts";
import type { Params } from "./strategy.ts";

export type Results = {
  /** Orders it quoted and orders it filled since the last decision. */
  quoted: number;
  filled: number;
  /** Sum of its fills' edges since the last decision (stable base units). */
  edge: bigint;
  /** Share of its net asset value held in NEAR now. */
  assetShare: number;
};

export type Decision = {
  firm: string;
  at: number;
  source: "near-ai-cloud" | "rule";
  before: Params;
  after: Params;
  reason: string;
  chatId?: string;
  model?: string;
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

const SYSTEM =
  "You manage the pricing of an AI market-making firm on NEAR. It quotes NEAR/USDC swap orders in sealed-bid auctions: " +
  "the best quote fills at the second-best one, and an order only fills if it beats what NEAR Intents 1Click would give. " +
  "Each period you get its current params and results. Answer with JSON only: " +
  '{"spreadBps": number, "targetAssetShare": number, "skewBps": number, "reason": string}. ' +
  "Keep the firm solvent first, then grow its edge. The owner's policy caps whatever you choose.";

export async function decide(llm: Llm | null, firm: string, p: Params, r: Results, maxAssetShare: number): Promise<Decision> {
  const base = { firm, at: Date.now(), before: p };
  if (llm) {
    const user = JSON.stringify({ params: p, results: { quoted: r.quoted, filled: r.filled, edge_usdc: Number(r.edge) / 1e6, asset_share: Number(r.assetShare.toFixed(3)) } });
    const c = await llm.complete(SYSTEM, user);
    if (c.source === "near-ai-cloud") {
      try {
        const j = JSON.parse(c.text.slice(c.text.indexOf("{"), c.text.lastIndexOf("}") + 1));
        const next = { spreadBps: Number(j.spreadBps), targetAssetShare: Number(j.targetAssetShare), skewBps: Number(j.skewBps) };
        return { ...base, source: "near-ai-cloud", after: bound(next, p, maxAssetShare), reason: String(j.reason ?? "").slice(0, 280), chatId: c.chatId, model: c.model };
      } catch {}
    }
  }
  const { params, reason } = rule(p, r);
  return { ...base, source: "rule", after: bound(params, p, maxAssetShare), reason };
}
