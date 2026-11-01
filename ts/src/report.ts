// Due diligence on a firm for a share buyer or a lender: a deterministic 0 to 100 score with its components,
// and a short note. An LLM may write the note, but every number in it must come from the facts or the score;
// else (or without a live LLM) a fixed template writes it.
import type { Llm } from "./llm.ts";
import { owedOf } from "./strategy.ts";

export const REPORT_PROMPT =
  "You write a due-diligence note on an AI market-making firm for someone deciding whether to buy its shares. " +
  "At most 90 words of plain text, no lists, no markdown. Quote only numbers that appear in the JSON you get, " +
  "as given. Say what is strong, what is weak, and the main risk.";

export type FirmStatus = "Solvent" | "Illiquid" | "Liquidating" | "Closed";

/** USD amounts in USDC (1 USDC = 1 USD). */
export type FirmFacts = {
  id: number;
  name: string;
  status: FirmStatus;
  cashUsd: number;
  /** The cash floor under which the firm stops quoting, then is liquidated. */
  floorUsd: number;
  navUsd: number;
  fills: number;
  /** Sum of its fills' edges, signed. */
  edgeUsd: number;
  takeovers: number;
  slashedUsd: number;
  /** Owed to lenders, interest to now included. */
  owedUsd: number;
  /** Shares per holder (100 in all), the owner included. */
  holderShares: number[];
  /** History, when known: P&L against holding its starting cash and NEAR. */
  pnlVsHoldUsd?: number;
};

/** The fields of the API's FirmState (app/src/lib/api.ts) the report reads. */
export type FirmStateLike = {
  id: number;
  status: FirmStatus;
  treasury: string;
  nav: string;
  fills: number;
  edge: string;
  takeovers: number;
  slashed: string;
  debts: { principal: string; rate_bps: number; since: number }[];
  holdings: { account: string; shares: number }[];
  profile: string | null;
  strategy: { name: string } | null;
};

const usd = (base: string) => Number(BigInt(base)) / 1e6;

/** Facts from a FirmState; the name from its profile, else its strategy. Debts as owedOf counts them (1% margin). */
export function factsFromFirm(f: FirmStateLike, floorUsd: number, history: { pnlVsHoldUsd?: number } = {}, nowMs = Date.now()): FirmFacts {
  let name = f.strategy?.name ?? `firm #${f.id}`;
  try {
    const p = f.profile ? JSON.parse(f.profile) : null;
    if (typeof p?.name === "string" && p.name) name = p.name.slice(0, 60);
  } catch {}
  return {
    id: f.id, name, status: f.status, cashUsd: usd(f.treasury), floorUsd, navUsd: usd(f.nav), fills: f.fills, edgeUsd: usd(f.edge),
    takeovers: f.takeovers, slashedUsd: usd(f.slashed), owedUsd: Number(owedOf(f.debts, nowMs)) / 1e6, holderShares: f.holdings.map((h) => h.shares),
    ...history,
  };
}

export type Grade = "A" | "B" | "C" | "D" | "E";
/** `value` 0 to 1, null when unknown (left out, the other weights rescaled); `points` its share of the score. */
export type Component = { key: string; label: string; weight: number; value: number | null; points: number };
export type Score = { score: number; grade: Grade; components: Component[] };

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
/** A firm in liquidation or closed scores at most this (grade E). */
const CAP_DOWN = 20;

/**
 * Weights (sum 100) and each component's 0 to 1 scale:
 * cash 20: 0 at the floor, 1 at 3 times it. pnl 15: P&L against holding, 0 at -5% of NAV, 1 at +5% (unknown: left out).
 * edge 15: edge per fill, 0 at 0 or less, 1 at 0.10 USDC. experience 10: log of fills, 1 at 500.
 * takeovers 5: 1 at 2. slashes 10: 1 when never slashed, 0 at 10 USDC. debt 10: 1 - owed / cash.
 * holders 5: 1 - HHI of the shares, full at HHI 0.25 (4 equal holders). status 10: Solvent 1, Illiquid 0.3, else 0.
 */
export function firmScore(f: FirmFacts): Score {
  const total = f.holderShares.reduce((a, b) => a + b, 0);
  const hhi = total > 0 ? f.holderShares.reduce((a, s) => a + (s / total) ** 2, 0) : 1;
  const raw: [string, string, number, number | null][] = [
    ["cash", "cash over the floor", 20, f.floorUsd > 0 ? clamp01((f.cashUsd / f.floorUsd - 1) / 2) : f.cashUsd > 0 ? 1 : 0],
    ["pnl", "P&L against holding", 15, f.pnlVsHoldUsd === undefined ? null : clamp01(0.5 + (f.pnlVsHoldUsd / Math.max(f.navUsd, 1)) * 10)],
    ["edge", "edge per fill", 15, f.fills ? clamp01(f.edgeUsd / f.fills / 0.1) : 0],
    ["experience", "fills", 10, clamp01(Math.log10(1 + f.fills) / Math.log10(501))],
    ["takeovers", "takeovers", 5, clamp01(f.takeovers / 2)],
    ["slashes", "slashes", 10, clamp01(1 - f.slashedUsd / 10)],
    ["debt", "debt against cash", 10, f.owedUsd <= 0 ? 1 : f.cashUsd > 0 ? clamp01(1 - f.owedUsd / f.cashUsd) : 0],
    ["holders", "spread of shareholders", 5, clamp01((1 - hhi) / 0.75)],
    ["status", "status", 10, f.status === "Solvent" ? 1 : f.status === "Illiquid" ? 0.3 : 0],
  ];
  const known = raw.reduce((a, [, , w, v]) => a + (v === null ? 0 : w), 0);
  const components = raw.map(([key, label, weight, value]) => ({ key, label, weight, value: value === null ? null : round(value), points: value === null ? 0 : round((100 * weight * value) / known, 1) }));
  let score = Math.round(components.reduce((a, c) => a + c.points, 0));
  if (f.status === "Liquidating" || f.status === "Closed") score = Math.min(score, CAP_DOWN);
  const grade: Grade = score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : score >= 35 ? "D" : "E";
  return { score, grade, components };
}

/**
 * What the note may quote: the facts rounded for display, a few ratios, and the score. The owner sets the
 * firm's name: it is not sent to the LLM (no instructions hidden in it), only shown.
 */
function given(f: FirmFacts, s: Score) {
  return {
    firm: {
      name: "the firm", status: f.status, cashUsd: round(f.cashUsd), floorUsd: round(f.floorUsd), cashToFloor: f.floorUsd > 0 ? round(f.cashUsd / f.floorUsd, 1) : null,
      navUsd: round(f.navUsd), fills: f.fills, edgeUsd: round(f.edgeUsd), edgePerFillUsd: f.fills ? round(f.edgeUsd / f.fills, 3) : null,
      takeovers: f.takeovers, slashedUsd: round(f.slashedUsd), owedUsd: round(f.owedUsd), holders: f.holderShares.length,
      largestHolderShares: Math.max(0, ...f.holderShares), pnlVsHoldUsd: f.pnlVsHoldUsd === undefined ? null : round(f.pnlVsHoldUsd),
    },
    score: { score: s.score, outOf: 100, grade: s.grade, components: s.components.map((c) => ({ label: c.label, weight: c.weight, points: c.points })) },
  };
}

/** Every finite number in a JSON-like value. */
function numbersIn(x: unknown, out: number[] = []): number[] {
  if (typeof x === "number" && Number.isFinite(x)) out.push(x);
  else if (x && typeof x === "object") for (const v of Object.values(x)) numbersIn(v, out);
  return out;
}

/**
 * The numbers in `text` that match none of `allowed`. A written number matches a value rounded to as many
 * decimals as it shows; "42%" also matches 0.42. Signs are ignored ("lost 3.20" for -3.2), thousands commas
 * allowed. Digits after a letter ("w3") are not numbers; the caller strips the firm name first.
 */
export function inventedNumbers(text: string, allowed: number[]): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(/(?<![\w.])\d+(?:,\d{3})*(?:\.\d+)?(%?)/g)) {
    const s = m[0].replace(/[,%]/g, "");
    const x = Number(s);
    const d = s.includes(".") ? s.split(".")[1].length : 0;
    const ok = (v: number, dd: number) => Math.abs(round(Math.abs(v), dd) - x) < 1e-9;
    if (!allowed.some((v) => ok(v, d) || (m[1] === "%" && ok(v * 100, d)))) bad.push(m[0]);
  }
  return bad;
}

/** The note without an LLM. Every number in it comes from `given`. */
export function reportTemplate(f: FirmFacts, s: Score): string {
  const g = given(f, s).firm;
  const weakest = s.components.filter((c) => c.value !== null).sort((a, b) => a.value! - b.value! || b.weight - a.weight)[0];
  return [
    `${f.name}: grade ${s.grade}, score ${s.score} of 100.`,
    `Cash ${g.cashUsd} USDC${g.cashToFloor === null ? "" : `, ${g.cashToFloor} times its ${g.floorUsd} USDC floor`}.`,
    g.fills ? `${g.fills} fills, edge ${g.edgeUsd} USDC, ${g.edgePerFillUsd} USDC per fill.` : "No fills yet.",
    g.pnlVsHoldUsd === null ? "" : `P&L against holding: ${g.pnlVsHoldUsd} USDC.`,
    g.owedUsd > 0 ? `Owes ${g.owedUsd} USDC to lenders.` : "No debt.",
    g.slashedUsd > 0 ? `Slashed ${g.slashedUsd} USDC.` : "Never slashed.",
    f.status === "Solvent" ? "" : `Status: ${f.status}.`,
    weakest && weakest.value! < 1 ? `Weakest point: ${weakest.label}.` : "",
  ].filter(Boolean).join(" ");
}

export type Report = { text: string; source: "llm" | "template"; chatId?: string; signature?: unknown; rejected?: string };

/** An LLM note if it has at most 90 words and invents no number, else the template. */
export async function reportProse(llm: Llm | null, f: FirmFacts, s: Score): Promise<Report> {
  const g = given(f, s);
  let rejected: string | undefined;
  if (llm?.live) {
    try {
      const c = await llm.complete(REPORT_PROMPT, JSON.stringify(g));
      const text = c.text.trim();
      const words = text.split(/\s+/).filter(Boolean).length;
      const bad = inventedNumbers(text.split(f.name).join(" "), numbersIn(g));
      if (text && words <= 90 && !bad.length) return { text, source: "llm", chatId: c.chatId, signature: c.signature };
      rejected = bad.length ? `numbers not in the facts: ${bad.join(", ")}` : `${words} words`;
    } catch {
      rejected = "LLM unavailable"; // the provider's error is the caller's to log, not the API's to show
    }
  }
  return { text: reportTemplate(f, s), source: "template", ...(rejected ? { rejected } : {}) };
}
