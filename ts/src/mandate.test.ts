import { test } from "node:test";
import assert from "node:assert/strict";
import type { Completion, Llm } from "./llm.ts";
import { allowsOrder, applyOverlay, compileMandate, evaluateMandate, validateRule, type Mandate, type MandateState } from "./mandate.ts";

/** A live LLM that always answers `text`. */
const fake = (text: string, live = true): Llm & { calls: number } => ({
  live,
  calls: 0,
  async complete(): Promise<Completion> {
    this.calls++;
    return { text, chatId: "chat-1", model: "fake", signature: { sig: "0xabc" }, source: "near-ai-cloud" };
  },
});
const pauseRule = { when: { kind: "price_move", windowMin: 60, belowPct: -5 }, then: { pause: true }, note: "pause on a 5% drop" };

test("the LLM's valid rules are kept, with its chat id and signature", async () => {
  const m = await compileMandate(fake("```json\n" + JSON.stringify({ rules: [pauseRule] }) + "\n```"), "pause if NEAR drops 5% in an hour", 1);
  assert.equal(m.source, "llm");
  assert.deepEqual(m.rules, [pauseRule]);
  assert.equal(m.chatId, "chat-1");
  assert.deepEqual(m.signature, { sig: "0xabc" });
  assert.deepEqual(m.dropped, []);
});

test("invalid and out-of-bounds rules are dropped with a reason", async () => {
  const rules = [
    pauseRule,
    { when: { kind: "regime", atLeast: "storm" }, then: { spreadMinBps: 900 }, note: "" },
    { when: { kind: "regime", atLeast: "storm" }, then: { pause: true, leverage: 3 }, note: "" },
    { when: { kind: "moon_phase" }, then: { pause: true }, note: "" },
    { when: { kind: "price_move", windowMin: 60, belowPct: 5 }, then: { pause: true }, note: "" },
    { when: { kind: "inventory_share" }, then: { pause: true }, note: "" },
  ];
  const m = await compileMandate(fake(JSON.stringify({ rules })), "x");
  assert.equal(m.source, "llm");
  assert.equal(m.rules.length, 1);
  assert.deepEqual(m.dropped, [
    "llm rule 2: spreadMinBps out of range: 900",
    "llm rule 3: unknown field leverage",
    'llm rule 4: unknown condition "moon_phase"',
    "llm rule 5: belowPct out of range: 5",
    "llm rule 6: inventory_share needs above or below",
  ]);
  assert.equal(typeof validateRule({ ...pauseRule, extra: 1 }), "string", "unknown top-level field");
  assert.equal(validateRule({ when: { kind: "regime", atLeast: "storm" }, then: { spreadMinBps: 40, spreadMaxBps: 20 } }), "spreadMinBps over spreadMaxBps");
});

test("at most 8 rules, text capped at 500 chars", async () => {
  const llm = fake(JSON.stringify({ rules: Array(10).fill(pauseRule) }));
  const m = await compileMandate(llm, "y".repeat(800));
  assert.equal(m.rules.length, 8);
  assert.equal(m.dropped.length, 2);
  assert.equal(m.text.length, 500);
});

test("unreadable output, extra top-level fields, no live LLM: the pattern parser", async () => {
  const text = "Pause if NEAR drops 5% in an hour";
  for (const llm of [fake("sure, I will pause"), fake(JSON.stringify({ rules: [pauseRule], comment: "hi" })), fake(JSON.stringify({ rules: [pauseRule] }), false), null]) {
    const m = await compileMandate(llm, text);
    assert.equal(m.source, "pattern");
    assert.deepEqual(m.rules, [{ when: { kind: "price_move", windowMin: 60, belowPct: -5 }, then: { pause: true }, note: text }]);
  }
  const replay = fake("{}", false);
  await compileMandate(replay, text);
  assert.equal(replay.calls, 0, "a replay is not asked");
});

test("the pattern parser on the three example phrases and on garbage", async () => {
  const m = await compileMandate(null, "Pause if NEAR drops 5% in an hour. Never hold more than 40% in NEAR; widen to 30 bp when the market is stormy");
  assert.deepEqual(
    m.rules.map((r) => [r.when, r.then]),
    [
      [{ kind: "price_move", windowMin: 60, belowPct: -5 }, { pause: true }],
      [{ kind: "inventory_share", above: 0.4 }, { targetAssetShare: 0.4 }],
      [{ kind: "regime", atLeast: "storm" }, { spreadMinBps: 30 }],
    ],
  );
  const more = await compileMandate(null, "stop if SOL falls 2.5% within 15 minutes and widen to 20 bps when it gets volatile");
  assert.deepEqual(more.rules.map((r) => r.when), [{ kind: "price_move", windowMin: 15, belowPct: -2.5 }, { kind: "regime", atLeast: "alert" }]);
  const g = await compileMandate(null, "make me rich, buy the dip, lol");
  assert.equal(g.source, "none");
  assert.deepEqual(g.rules, []);
  const out = await compileMandate(null, "pause if NEAR drops 5% in 2 minutes");
  assert.equal(out.source, "none");
  assert.match(out.dropped[0], /windowMin out of range: 2/, "the pattern goes through the same validator");
  assert.equal((await compileMandate(null, "   ")).source, "none");
});

// Flat at 4 USD for 2 hours, then a 6% drop over 40 minutes, one point a minute.
const T0 = Date.UTC(2026, 10, 1);
const series = [
  ...Array.from({ length: 120 }, (_, i) => ({ t: T0 + i * 60_000, mid: 4 })),
  ...Array.from({ length: 40 }, (_, i) => ({ t: T0 + (120 + i) * 60_000, mid: 4 * (1 - (0.06 * (i + 1)) / 40) })),
];
const calm: MandateState = { series: series.slice(0, 120), assetShare: 0.3, cashToFloor: 4, regime: "calm" };
const mandate = (rules: Mandate["rules"]): Mandate => ({ text: "", rules, source: "pattern", compiledAt: 0, dropped: [] });

test("a 6% drop in 40 minutes triggers a 1-hour -5% rule", () => {
  const m = mandate([{ when: { kind: "price_move", windowMin: 60, belowPct: -5 }, then: { pause: true }, note: "" }]);
  assert.deepEqual(evaluateMandate(m, calm), { active: [], overlay: { pause: false } });
  const r = evaluateMandate(m, { ...calm, series });
  assert.equal(r.active.length, 1);
  assert.equal(r.overlay.pause, true);
  assert.equal(allowsOrder(r.overlay, 10), false);
  const short = mandate([{ when: { kind: "price_move", windowMin: 10, belowPct: -5 }, then: { pause: true }, note: "" }]);
  assert.equal(evaluateMandate(short, { ...calm, series }).active.length, 0, "only 1.5% in the last 10 minutes");
  const up = mandate([{ when: { kind: "price_move", windowMin: 60, abovePct: 5 }, then: { pause: true }, note: "" }]);
  assert.equal(evaluateMandate(up, { ...calm, series }).active.length, 0);
});

test("two active rules combine: pause any, spread floor max, caps min", () => {
  const m = mandate([
    { when: { kind: "regime", atLeast: "alert" }, then: { spreadMinBps: 20, spreadMaxBps: 80, maxOrderUsd: 100 }, note: "" },
    { when: { kind: "cash_vs_floor", belowRatio: 2 }, then: { spreadMinBps: 30, spreadMaxBps: 60, targetAssetShare: 0.3, maxOrderUsd: 50 }, note: "" },
    { when: { kind: "inventory_share", above: 0.8 }, then: { pause: true }, note: "" },
  ]);
  const r = evaluateMandate(m, { ...calm, regime: "storm", cashToFloor: 1.5 });
  assert.equal(r.active.length, 2);
  assert.deepEqual(r.overlay, { pause: false, spreadMinBps: 30, spreadMaxBps: 60, targetAssetShare: 0.3, maxOrderUsd: 50 });
  const p = { spreadBps: 10, targetAssetShare: 0.5, skewBps: 5 };
  assert.deepEqual(applyOverlay(p, r.overlay), { spreadBps: 30, targetAssetShare: 0.3, skewBps: 5 });
  assert.equal(applyOverlay({ ...p, spreadBps: 100 }, r.overlay).spreadBps, 60);
  assert.equal(applyOverlay(p, { pause: false, spreadMinBps: 50, spreadMaxBps: 20 }).spreadBps, 50, "a conflict keeps the wider spread");
  assert.ok(allowsOrder(r.overlay, 50) && !allowsOrder(r.overlay, 51));
  assert.equal(evaluateMandate(m, { ...calm, regime: "alert" }).active.length, 1, "alert is at least alert");
});
