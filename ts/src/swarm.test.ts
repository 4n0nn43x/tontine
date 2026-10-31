import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultQuote, loadStrategies, safeQuote, type FirmCtx, type Market, type OrderView, type Strategy } from "./strategy.ts";
import { bound, rule } from "./manager.ts";
import { bidHash } from "./swarm.ts";

const NEAR = 10n ** 24n;
const order: OrderView = { id: 0, client: "c", side: "Buy", amountIn: 40_000_000n, minOut: 9n * NEAR, referenceOut: null };
const me: FirmCtx = { id: 0, account: "w", stable: 1000_000_000n, asset: 100n * NEAR, fills: 0, edge: 0n, status: "Solvent", policy: { max_asset_bps: 8000, band_bps: 1000, paused: false } };
const market: Market = { mid: 4, last: 4_000_000n, unit: NEAR };
const params = { spreadBps: 10, targetAssetShare: 0.3, skewBps: 0 };

test("every file in strategies/ is a valid Strategy", async () => {
  const s = await loadStrategies();
  assert.ok(s.length >= 5);
  for (const x of s) assert.ok(x.name && x.author && x.params);
});

test("safeQuote keeps only bids the contract would accept at reveal", () => {
  const mk = (quote: Strategy["quote"]): Strategy => ({ name: "t", author: "t", house: false, params, quote });
  assert.equal(safeQuote(mk(() => 8n * NEAR), order, me, market, params), null, "under the client's minimum");
  assert.equal(safeQuote(mk(() => 12n * NEAR), order, me, market, params), null, "outside the 10% band");
  assert.equal(safeQuote(mk(() => { throw new Error("x"); }), order, me, market, params), null);
  assert.equal(safeQuote(mk(() => 99n * NEAR / 10n), order, { ...me, policy: { ...me.policy, paused: true } }, market, params), null, "paused");
  assert.equal(safeQuote(mk(() => 99n * NEAR / 10n), order, me, market, params), 99n * NEAR / 10n);
  // The default quote: 40 USDC at 4 USD, less 10 bp.
  assert.equal(defaultQuote(order, me, market, params), (10n * NEAR * 9990n) / 10000n);
});

test("the inventory lean: a firm long NEAR sells it cheaper", () => {
  const long = { ...me, stable: 0n };
  const lean = { ...params, skewBps: 20 };
  assert.ok(defaultQuote(order, long, market, lean)! > defaultQuote(order, me, market, lean)!, "better buy quotes when holding too much NEAR");
});

test("the manager rule and its bounds", () => {
  const r = { quoted: 5, filled: 2, edge: -1_000_000n, assetShare: 0.3 };
  assert.ok(rule(params, r).params.spreadBps > params.spreadBps, "a loss widens the spread");
  assert.ok(rule(params, { ...r, filled: 0, edge: 0n }).params.spreadBps < params.spreadBps, "no fills tighten it");
  const b = bound({ spreadBps: 5000, targetAssetShare: 2, skewBps: Number.NaN }, params, 0.8);
  assert.deepEqual(b, { spreadBps: 300, targetAssetShare: 0.8, skewBps: 0 }, "capped, and NaN keeps the previous value");
});

test("bid hash matches the contract format sha256('{amount}:{salt}')", () => {
  // Same vector is asserted in contracts/tender/src/tests.rs (bid_hash_vector).
  assert.equal(bidHash(6_000_000n, "s0"), "bb0041d21898d7bb4e1c67959ec2beaa5e433ead7084e524f13dfc179744f9fd");
  assert.match(bidHash(1n, "x"), /^[0-9a-f]{64}$/);
});

import { multiple, quantile, evaluate, evaluateBuybacks } from "./thesis.ts";

test("thesis multiple reproduces the spec figure (5.3x at 5.41 bp, 2.5% emission)", () => {
  const m = multiple({ supply: 1.31e9, price: 4.14, emission: 0.025, takeRateBp: 5.41, avgDailyVol: 132e6 });
  assert.ok(Math.abs(m.multiple - 5.3) < 0.1, String(m.multiple));
  // Volume settled internally pays no fee: the multiple grows.
  assert.ok(multiple({ supply: 1.31e9, price: 4.14, emission: 0.025, takeRateBp: 5.41, avgDailyVol: 132e6, internalShare: 0.5 }).multiple > 10);
});

test("quantile interpolates", () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([0, 10], 0.1), 1);
});

test("evaluate stays pending until the 12-day window is complete and read on time", () => {
  const p: any = { window: { from: "2026-11-01", to: "2026-11-12" }, P1: { low: 0, high: 1e12 }, P2: { low: 0, high: 1e9 }, P3: { min: 4 } };
  const day = (i: number) => ({ ts: 0, date: `2026-11-${String(i).padStart(2, "0")}`, vol: 1e8, rev: 5e4, fees: 1e5, gas: 4e3 });
  assert.match(evaluate(p, [day(1), day(2)]).P3.status, /pending/);
  const full = evaluate(p, Array.from({ length: 12 }, (_, i) => day(i + 1)));
  assert.equal(full.P3.status, "TRUE"); // 5 bp >= 4
  // Read too early, the last days are still revised: no verdict.
  const early = evaluate({ ...p, window: { ...p.window, read_from: "2026-11-14" } }, Array.from({ length: 12 }, (_, i) => day(i + 1)), "2026-11-13T09:00:00Z");
  assert.match(early.P3.status, /read on or after 2026-11-14/);
});

test("P5 and P6 read the buyback balance from 2026-11-01 to 2026-11-13; a fall above 1 NEAR fails P6", () => {
  const p = { window: { from: "2026-11-01", to: "2026-11-12", read_from: "2026-11-14" }, P5: { low: 80_000, high: 170_000 }, P6: { max_drop_near: 1 } };
  const bal = (near: (i: number) => number) => Array.from({ length: 13 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, "0")}`, height: i, near: near(i) }));
  assert.match(evaluateBuybacks(p, bal((i) => 1e6 + i * 10_000).slice(0, 12)).P5.status, /pending \(11\/12 days\)/);
  const ok = evaluateBuybacks(p, bal((i) => (i === 6 ? 1e6 + 50_000 - 0.4 : 1e6 + i * 10_000)), "2026-11-14T01:00:00Z");
  // Day 6 falls 0.4 NEAR (gas of a confirmation): under 1 NEAR, P6 holds.
  assert.deepEqual([ok.P5.observed, ok.P5.status, ok.P6.observed?.toFixed(1), ok.P6.status], [120_000, "TRUE", "0.4", "TRUE"]);
  const sold = evaluateBuybacks(p, bal((i) => 1e6 + (i < 6 ? i * 10_000 : 0)), "2026-11-14T01:00:00Z");
  assert.deepEqual([sold.P5.status, sold.P6.status], ["FALSE", "FALSE"]);
  assert.match(evaluateBuybacks(p, bal((i) => 1e6 + i * 10_000), "2026-11-13T09:00:00Z").P6.status, /read on or after/);
});
