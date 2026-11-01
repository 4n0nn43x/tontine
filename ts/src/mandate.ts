// An owner's mandate in plain words ("pause if NEAR drops 5% in an hour"), compiled to a closed set of rules
// that only tighten what a firm does: pause, widen or narrow the spread, cap its NEAR target and order size.
// The LLM (or, without one, a small pattern parser) writes the rules; a strict validator keeps only those in
// the schema. The owner's on-chain policy (band, NEAR cap, pause) stays the hard limit the contract enforces.
import type { Llm } from "./llm.ts";
import type { Params } from "./strategy.ts";
import { RANK, type Point, type Regime } from "./guard.ts";

export const MANDATE_PROMPT =
  "Translate a market-making firm owner's instructions into rules. Answer with JSON only: " +
  '{"rules": [{"when": C, "then": A, "note": string}]}, at most 8 rules. C is one of: ' +
  '{"kind": "price_move", "windowMin": 5 to 1440, "belowPct": negative number, "abovePct": positive number} (one or both), ' +
  '{"kind": "inventory_share", "above": 0 to 1, "below": 0 to 1} (one or both), ' +
  '{"kind": "cash_vs_floor", "belowRatio": 1 to 5}, {"kind": "regime", "atLeast": "alert" | "storm"}. ' +
  'A has any of: "pause": true, "spreadMinBps": 1 to 300, "spreadMaxBps": 1 to 300, "targetAssetShare": 0.05 to 0.9, "maxOrderUsd": number > 0. ' +
  'Shares are fractions (40% is 0.4). No other fields. "note" quotes the instruction. Nothing fits: {"rules": []}.';

export type Condition =
  | { kind: "price_move"; windowMin: number; belowPct?: number; abovePct?: number }
  | { kind: "inventory_share"; above?: number; below?: number }
  | { kind: "cash_vs_floor"; belowRatio: number }
  | { kind: "regime"; atLeast: "alert" | "storm" };
export type Action = { pause?: boolean; spreadMinBps?: number; spreadMaxBps?: number; targetAssetShare?: number; maxOrderUsd?: number };
export type MandateRule = { when: Condition; then: Action; note: string };
export type Mandate = {
  text: string;
  rules: MandateRule[];
  source: "llm" | "pattern" | "none";
  compiledAt: number;
  /** Why rules or the LLM answer were dropped. */
  dropped: string[];
  chatId?: string;
  signature?: unknown;
};
/** Active rules combined: pause if any, the highest spread floor, the lowest spread cap, target and order cap. */
export type Overlay = { pause: boolean; spreadMinBps?: number; spreadMaxBps?: number; targetAssetShare?: number; maxOrderUsd?: number };
export type MandateState = { series: Point[]; assetShare: number; cashToFloor: number; regime: Regime };

export const MAX_TEXT = 500;
export const MAX_RULES = 8;

type Check = (v: unknown) => boolean;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const range = (lo: number, hi: number): Check => (v) => isNum(v) && v >= lo && v <= hi;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Fields per condition, and the groups of which at least one field must be present. */
const CONDITIONS: Record<Condition["kind"], { fields: Record<string, Check>; need: string[][] }> = {
  price_move: { fields: { windowMin: range(5, 1440), belowPct: (v) => isNum(v) && v < 0 && v > -100, abovePct: (v) => isNum(v) && v > 0 && v <= 1000 }, need: [["windowMin"], ["belowPct", "abovePct"]] },
  inventory_share: { fields: { above: range(0, 1), below: range(0, 1) }, need: [["above", "below"]] },
  cash_vs_floor: { fields: { belowRatio: range(1, 5) }, need: [["belowRatio"]] },
  regime: { fields: { atLeast: (v) => v === "alert" || v === "storm" }, need: [["atLeast"]] },
};
const ACTION: Record<string, Check> = {
  pause: (v) => typeof v === "boolean",
  spreadMinBps: range(1, 300),
  spreadMaxBps: range(1, 300),
  targetAssetShare: range(0.05, 0.9),
  maxOrderUsd: (v) => isNum(v) && v > 0,
};

/** The first unknown or out-of-range field of `o`, null when all pass. */
function badField(o: Record<string, unknown>, spec: Record<string, Check>, skip: string[] = []): string | null {
  for (const [k, v] of Object.entries(o)) {
    if (skip.includes(k)) continue;
    if (!Object.hasOwn(spec, k)) return `unknown field ${k}`;
    if (!spec[k](v)) return `${k} out of range: ${JSON.stringify(v)}`;
  }
  return null;
}

/** A rule in the schema, or why not. Unknown fields and out-of-range values are refused, never clamped. */
export function validateRule(x: unknown): MandateRule | string {
  if (!isObj(x)) return "rule is not an object";
  const top = badField(x, { when: isObj, then: isObj, note: (v) => typeof v === "string" });
  if (top) return top;
  const w = x.when, a = x.then;
  if (!isObj(w) || !isObj(a)) return "rule needs when and then";
  if (typeof w.kind !== "string" || !Object.hasOwn(CONDITIONS, w.kind)) return `unknown condition ${JSON.stringify(w.kind)}`;
  const spec = CONDITIONS[w.kind as Condition["kind"]];
  const cond = badField(w, spec.fields, ["kind"]) ?? (spec.need.every((g) => g.some((k) => w[k] !== undefined)) ? null : `${w.kind} needs ${spec.need.map((g) => g.join(" or ")).join(" and ")}`);
  if (cond) return cond;
  const act = badField(a, ACTION) ?? (Object.keys(a).length ? null : "empty action");
  if (act) return act;
  if (isNum(a.spreadMinBps) && isNum(a.spreadMaxBps) && a.spreadMinBps > a.spreadMaxBps) return "spreadMinBps over spreadMaxBps";
  return { when: w as Condition, then: a as Action, note: String(x.note ?? "").slice(0, 160) };
}

/** Valid rules among `xs`, at most MAX_RULES; the reasons for the others go to `dropped`. */
function keep(xs: unknown[], dropped: string[], tag: string): MandateRule[] {
  const out: MandateRule[] = [];
  xs.forEach((x, i) => {
    const r = validateRule(x);
    if (typeof r === "string") dropped.push(`${tag} rule ${i + 1}: ${r}`);
    else if (out.length >= MAX_RULES) dropped.push(`${tag} rule ${i + 1}: over ${MAX_RULES} rules`);
    else out.push(r);
  });
  return out;
}

const N = String.raw`(\d+(?:\.\d+)?)`;
const MOVE = new RegExp(String.raw`\b(drops?|falls?|dumps?|crash(?:es)?|plunges?|is down|rises?|jumps?|pumps?|spikes?|rall(?:y|ies)|is up)\s+(?:by\s+)?(?:more than\s+)?${N}\s*%`);
const WINDOW = /\b(?:in|within|over)\s+(?:(\d+(?:\.\d+)?)\s*|an?\s+|one\s+)(minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/;
const HOLD = new RegExp(String.raw`(?:never|don't|do not|not)\s+hold\s+(?:more|over)\s+(?:than\s+)?${N}\s*%|(?:at most|no more than)\s+${N}\s*%\s+(?:in|of)\b`);
const CASH = new RegExp(String.raw`cash\b.*?(?:below|under|less than)\s+${N}\s*(?:x|times)\s+(?:the\s+)?floor`);
const WIDEN = new RegExp(String.raw`(?:widen|spread|at least)\D*?${N}\s*(?:bps?|basis points?)\b`);

/**
 * Without an LLM: common phrasings, one rule per clause. A clause needs an action (pause, widen to N bp) and a
 * condition (drops or rises N% in a window, 1 hour by default; stormy or volatile market; cash under Nx the
 * floor), or is a holding cap ("never hold more than 40% in NEAR": above 40%, target 40%).
 * ponytail: regexes for a handful of phrasings; anything else needs the LLM.
 */
export function patternRules(text: string): unknown[] {
  const out: unknown[] = [];
  const clauses = text.split(/[;\n]|\.(?!\d)|\band\b(?=\s+(?:pause|stop|halt|widen|never|keep|hold|don't|do not)\b)/i);
  for (const raw of clauses) {
    const c = raw.trim().toLowerCase();
    const note = raw.trim().slice(0, 160);
    if (!c) continue;
    const hold = c.match(HOLD);
    if (hold) {
      const share = +(hold[1] ?? hold[2]) / 100;
      out.push({ when: { kind: "inventory_share", above: share }, then: { targetAssetShare: share }, note });
      continue;
    }
    const then: Action = {};
    if (/\b(pause|stop|halt)\b/.test(c)) then.pause = true;
    const bp = c.match(WIDEN);
    if (bp) then.spreadMinBps = +bp[1];
    if (!Object.keys(then).length) continue;
    let when: Record<string, unknown> | null = null;
    const move = c.match(MOVE);
    const cash = c.match(CASH);
    if (move) {
      const w = c.match(WINDOW);
      const unit = w?.[2][0] === "d" ? 1440 : w?.[2][0] === "h" ? 60 : w ? 1 : 60;
      const windowMin = (w?.[1] ? +w[1] : 1) * unit;
      const pct = +move[2];
      when = /drop|fall|dump|crash|plunge|down/.test(move[1]) ? { kind: "price_move", windowMin, belowPct: -pct } : { kind: "price_move", windowMin, abovePct: pct };
    } else if (cash) when = { kind: "cash_vs_floor", belowRatio: +cash[1] };
    else if (/\b(storm|stormy|turbulent|panic)\b/.test(c)) when = { kind: "regime", atLeast: "storm" };
    else if (/\b(volatile|nervous|choppy|jumpy|alert)\b/.test(c)) when = { kind: "regime", atLeast: "alert" };
    if (when) out.push({ when, then, note });
  }
  return out;
}

/**
 * The owner's text (first MAX_TEXT chars) to rules. A live LLM answers in JSON; its valid rules are kept.
 * No live LLM, an error, an unreadable answer or no valid rule: the pattern parser, through the same validator.
 */
export async function compileMandate(llm: Llm | null, text: string, now = Date.now()): Promise<Mandate> {
  const t = text.trim().slice(0, MAX_TEXT);
  const dropped: string[] = [];
  if (!t) return { text: t, rules: [], source: "none", compiledAt: now, dropped };
  if (llm?.live) {
    try {
      const c = await llm.complete(MANDATE_PROMPT, t);
      const j = JSON.parse(c.text.slice(c.text.indexOf("{"), c.text.lastIndexOf("}") + 1));
      if (!isObj(j) || !Array.isArray(j.rules) || Object.keys(j).length !== 1) throw new Error('expected {"rules": [...]} only');
      const rules = keep(j.rules, dropped, "llm");
      if (rules.length) return { text: t, rules, source: "llm", compiledAt: now, dropped, chatId: c.chatId, signature: c.signature };
    } catch (e) {
      dropped.push(`llm: ${(e as Error).message}`);
    }
  }
  const rules = keep(patternRules(t), dropped, "pattern");
  return { text: t, rules, source: rules.length ? "pattern" : "none", compiledAt: now, dropped };
}

/**
 * Whether a condition holds now. A price move compares the last mid with the window's high (belowPct) or low
 * (abovePct): "drops 5% in an hour" is a fall of 5% from any point of the last hour. With both bounds of
 * a condition, either one is enough. The series is sorted by t (ms).
 */
function holds(c: Condition, s: MandateState): boolean {
  switch (c.kind) {
    case "price_move": {
      const end = s.series.at(-1);
      if (!end) return false;
      const w = s.series.filter((p) => p.t >= end.t - c.windowMin * 60_000).map((p) => p.mid);
      if (w.length < 2) return false;
      const fromHigh = (end.mid / Math.max(...w) - 1) * 100;
      const fromLow = (end.mid / Math.min(...w) - 1) * 100;
      return (c.belowPct !== undefined && fromHigh <= c.belowPct) || (c.abovePct !== undefined && fromLow >= c.abovePct);
    }
    case "inventory_share":
      return (c.above !== undefined && s.assetShare > c.above) || (c.below !== undefined && s.assetShare < c.below);
    case "cash_vs_floor":
      return s.cashToFloor < c.belowRatio;
    case "regime":
      return RANK[s.regime] >= RANK[c.atLeast];
  }
}

/** The rules that hold now and their combined overlay. Pure. */
export function evaluateMandate(m: Mandate, s: MandateState): { active: MandateRule[]; overlay: Overlay } {
  const active = m.rules.filter((r) => holds(r.when, s));
  const o: Overlay = { pause: false };
  for (const { then: a } of active) {
    if (a.pause) o.pause = true;
    if (a.spreadMinBps !== undefined) o.spreadMinBps = Math.max(o.spreadMinBps ?? 0, a.spreadMinBps);
    for (const k of ["spreadMaxBps", "targetAssetShare", "maxOrderUsd"] as const) if (a[k] !== undefined) o[k] = Math.min(o[k] ?? Infinity, a[k]);
  }
  return { active, overlay: o };
}

/** Params inside the overlay. When the spread floor and cap conflict, the floor (the wider, safer spread) wins. */
export function applyOverlay(p: Params, o: Overlay): Params {
  let spreadBps = Math.min(p.spreadBps, o.spreadMaxBps ?? Infinity);
  spreadBps = Math.max(spreadBps, o.spreadMinBps ?? 0);
  return { ...p, spreadBps, targetAssetShare: Math.min(p.targetAssetShare, o.targetAssetShare ?? Infinity) };
}

/** Whether the firm may quote an order of this size (USD) under the overlay. */
export const allowsOrder = (o: Overlay, notionalUsd: number) => !o.pause && notionalUsd <= (o.maxOrderUsd ?? Infinity);
