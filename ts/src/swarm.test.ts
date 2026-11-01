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

test("safeQuote never pays a seller out of the cash a firm must keep above the floor (Gambler Inc may)", () => {
  // The client sells 10 NEAR at 4 USD: the firm pays about 39.96 USDC. With 70 USDC of cash and a 40 USDC floor, no.
  const sell: OrderView = { ...order, side: "Sell", amountIn: 10n * NEAR, minOut: 39_000_000n };
  const tight = { ...me, stable: 70_000_000n, asset: 0n };
  const floored = { ...market, floor: 40_000_000n };
  const mk = (ignoresFloor?: boolean): Strategy => ({ name: "t", author: "t", house: false, params, ignoresFloor });
  assert.equal(safeQuote(mk(), sell, tight, floored, params), null, "would leave 30 USDC, under the 40 USDC floor");
  assert.ok(safeQuote(mk(), sell, { ...tight, stable: 100_000_000n }, floored, params)! > 0n, "leaves 60 USDC: quotes");
  assert.ok(safeQuote(mk(true), sell, tight, floored, params)! > 0n, "a strategy written to fail may");
  assert.ok(safeQuote(mk(), sell, tight, market, params)! > 0n, "no floor given (the simulation): unchanged");
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

test("bid hash matches the contract format sha256('{auction_id}:{firm_id}:{amount}:{salt}')", () => {
  // Same vector is asserted in contracts/tender/src/tests.rs (bid_hash_vector).
  assert.equal(bidHash(7, 3, 6_000_000n, "s0"), "05dbe4e0eaf78d50469d77012dae2f7b250d2c3f6d15adb90999fcdb7f24ff97");
  assert.match(bidHash(0, 0, 1n, "x"), /^[0-9a-f]{64}$/);
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

import { applyOverlay, compileMandate } from "./mandate.ts";
import { dailyCapped, HOUSE_MANDATES, regimeRules, Swarm, type FirmHandle } from "./swarm.ts";
import { marketHouse } from "./devnet.ts";
import type { Llm } from "./llm.ts";

test("every house firm has a default mandate the pattern parser reads in full", async () => {
  const names = [...(await loadStrategies()), ...marketHouse("ETH"), ...marketHouse("SOL")].map((s) => s.name);
  assert.deepEqual(names.filter((n) => !HOUSE_MANDATES[n]), []);
  for (const [name, text] of Object.entries(HOUSE_MANDATES)) {
    const m = await compileMandate(null, text);
    assert.equal(m.source, "pattern", name);
    assert.deepEqual(m.dropped, [], name);
    assert.equal(m.rules.length, text.split(/\.(?!\d)/).filter((c) => c.trim()).length, `${name}: one rule per sentence`);
  }
});

test("the house regime response, unless the mandate has its own", async () => {
  const p = { spreadBps: 12, targetAssetShare: 0.3, skewBps: 10 };
  assert.deepEqual(regimeRules([], p).map((r) => [r.when, r.then]), [
    [{ kind: "regime", atLeast: "alert" }, { spreadMinBps: 18 }],
    [{ kind: "regime", atLeast: "storm" }, { pause: true }],
  ]);
  const stormOnly = (await compileMandate(null, HOUSE_MANDATES["Sniper Holdings"])).rules;
  assert.deepEqual(regimeRules(stormOnly, p).map((r) => r.then), [{ spreadMinBps: 18 }], "a storm rule leaves the alert default");
  const both = (await compileMandate(null, HOUSE_MANDATES["Atlas AI"])).rules;
  assert.deepEqual(regimeRules(both, p), [], "an alert rule covers the storm too");
  assert.equal(regimeRules([], { ...p, spreadBps: 250 })[0].then.spreadMinBps, 300, "capped at 300 bp");
});

test("the swarm's overlay: house defaults pause in a storm, an owner's mandate keeps quoting wider", async () => {
  const handle = (id: number, name: string, house: boolean): FirmHandle => ({ id, account: `w${id}`, owner: {} as any, agentTender: {} as any, agentFirm: {} as any, strategy: { name, author: "t", house, managed: "rule", params } });
  const [undercut, atlas, visitor] = [handle(0, "Undercut & Co", true), handle(1, "Atlas AI", true), handle(2, "Mine", false)];
  const s = new Swarm({} as any, "t", [undercut, atlas, visitor], {} as Llm, "", async () => 4);
  for (const f of [undercut, atlas]) s.mandates.set(f.id, await compileMandate(null, HOUSE_MANDATES[f.strategy.name]));
  const now = (f: FirmHandle) => s.mandateNow(f, me, 4);
  assert.deepEqual(now(undercut).overlay, { pause: false }, "calm: nothing holds");
  s.regime = "alert";
  assert.equal(applyOverlay(params, now(undercut).overlay).spreadBps, 15, "alert: 10 bp widened 1.5 times");
  assert.equal(applyOverlay(params, now(atlas).overlay).spreadBps, 20, "Atlas: its own 20 bp on alert");
  s.regime = "storm";
  const u = now(undercut);
  assert.equal(u.overlay.pause, true);
  assert.equal(u.rules[u.active.at(-1)!].note, "House default: stop quoting in a storm");
  assert.deepEqual(now(atlas).overlay, { pause: false, spreadMinBps: 35 }, "Atlas keeps quoting at 35 bp");
  assert.deepEqual(now(visitor).overlay, { pause: false }, "no house default for a visitor's firm");
  // A price move: 5% under the last hour's high pauses Undercut (its mandate: 4%).
  s.regime = "calm";
  s.series = [{ t: 0, mid: 4 }, { t: 30 * 60_000, mid: 3.8 }];
  assert.equal(now(undercut).overlay.pause, true);
});

test("dailyCapped: not live past its cap, live again the next day", async () => {
  let day = "2026-11-01";
  const inner: Llm = { live: true, complete: async () => ({ text: "", chatId: "", model: "", signature: null, source: "near-ai-cloud" }) };
  const llm = dailyCapped(inner, 2, () => day);
  for (let i = 0; i < 2; i++) {
    assert.equal(llm.live, true);
    await llm.complete("s", "u");
  }
  assert.equal(llm.live, false);
  assert.equal(llm.capped, true);
  day = "2026-11-02";
  assert.equal(llm.live, true);
  assert.equal(llm.capped, false);
  assert.equal(dailyCapped({ ...inner, live: false }, 0).capped, false, "not live without the cap: not capped");
});

import { LLM_CAPS, llmToday, quietErrors } from "./swarm.ts";
import { DecisionLog } from "./shadow.ts";

/** A tender with one solvent firm: what manage() reads. */
const managedChain: any = {
  callFunction: async ({ method }: { method: string }) =>
    ({
      get_firm: { fills: 0, edge: "0", status: "Solvent", policy: { max_asset_bps: 8000, band_bps: 1000, paused: false }, debts: [] },
      balance_of: "1000000000",
      asset_balance_of: "0",
      get_last_price: "4000000",
      get_config: { asset_unit: (10n ** 24n).toString(), treasury_floor: "40000000" },
    })[method],
};
const answer = JSON.stringify({ spreadBps: 12, targetAssetShare: 0.3, skewBps: 0, reason: "ok" });
const countingLlm = () => {
  const l = { calls: 0, live: true, complete: async () => (l.calls++, { text: answer, chatId: "c", model: "m", signature: null, source: "near-ai-cloud" as const }) };
  return l;
};
const firmOf = (id: number, house: boolean): FirmHandle => ({ id, account: `w${id}`, owner: {} as any, agentTender: {} as any, agentFirm: {} as any, strategy: { name: `F${id}`, author: "t", house, managed: true, params } });

test("manager LLM cap: one count for every swarm, and a visitor share that leaves the house firms theirs", async () => {
  const llm = countingLlm();
  const [house, visitor] = [firmOf(0, true), firmOf(1, false)];
  const near = new Swarm(managedChain, "t", [house, visitor], llm, "", async () => 4, () => {});
  const eth = new Swarm(managedChain, "t2", [house], llm, "", async () => 4, () => {});
  Object.assign(llmToday, { day: new Date().toISOString().slice(0, 10), house: LLM_CAPS.house - 1, visitor: LLM_CAPS.visitor - 1 });
  assert.equal((await near.manage(house)).source, "near-ai-cloud");
  assert.equal((await eth.manage(house)).source, "rule", "another market's swarm sees the same count");
  assert.equal((await near.manage(visitor)).source, "near-ai-cloud", "visitors have their own share");
  assert.equal((await near.manage(visitor)).source, "rule");
  assert.equal(llm.calls, 2);
  assert.ok(LLM_CAPS.house > 0 && LLM_CAPS.visitor > 0);
  llmToday.day = "2000-01-01";
  assert.equal((await eth.manage(house)).source, "near-ai-cloud", "a new day resets both");
});

test("swarm.decisions keeps the last 500", async () => {
  const s = new Swarm(managedChain, "t", [], { live: false } as Llm, "", async () => 4, () => {});
  const f = { ...firmOf(0, true), strategy: { ...firmOf(0, true).strategy, managed: "rule" as const } };
  for (let i = 0; i < 510; i++) await s.manage(f);
  assert.equal(s.decisions.length, 500);
  assert.equal(s.decisionLog.entries.at(-1)!.seq, 509, "the decision log has them all");
});

test("mandates: concurrent posts of one text compile once; one compiled under the cap compiles again once it resets", async () => {
  let calls = 0;
  let release = () => {};
  const inner: Llm = {
    live: true,
    complete: async () => {
      calls++;
      await new Promise<void>((r) => (release = r));
      return { text: '{"rules": [{"when": {"kind": "regime", "atLeast": "storm"}, "then": {"pause": true}, "note": "storm"}]}', chatId: "c", model: "m", signature: null, source: "near-ai-cloud" };
    },
  };
  const s = new Swarm({} as any, "t", [], inner, "", async () => 4, () => {});
  s.decisionLog = new DecisionLog();
  const f = firmOf(3, false);
  const text = "Pause in a storm.";
  const posts = Array.from({ length: 5 }, () => s.setMandate(inner, f, text));
  await new Promise((r) => setTimeout(r, 0));
  release();
  const mds = await Promise.all(posts);
  assert.equal(calls, 1);
  assert.ok(mds.every((m) => m === mds[0] && m.source === "llm"));
  assert.equal(s.decisionLog.entries.length, 1, "logged once");
  assert.equal(await s.setMandate(inner, f, ` ${text} `), mds[0], "the same text: no new compile");
  // Over the daily cap, the pattern parser compiles it; the next post once the cap resets uses the LLM.
  let day = "2026-11-01";
  const capped = dailyCapped(inner, 0, () => day);
  const f2 = firmOf(4, false);
  const p1 = await s.setMandate(capped, f2, text);
  assert.equal(p1.source, "pattern");
  assert.equal(await s.setMandate(capped, f2, text), p1, "still capped: kept");
  const tomorrow = dailyCapped(inner, 1, () => day);
  day = "2026-11-02";
  const again = s.setMandate(tomorrow, f2, text);
  await new Promise((r) => setTimeout(r, 0));
  release();
  assert.equal((await again).source, "llm");
  assert.equal(await s.setMandate(tomorrow, f2, text), await again, "compiled with the LLM: kept");
});

test("quietErrors: the provider's error body goes to the server log, the caller sees LLM unavailable", async () => {
  const logged: string[] = [];
  const llm = quietErrors({ live: true, complete: () => Promise.reject(new Error('NEAR AI Cloud 401: {"error":"bad key sk-123"}')) }, (s) => logged.push(s));
  await assert.rejects(llm.complete("s", "u"), (e: Error) => e.message === "LLM unavailable");
  assert.match(logged[0], /sk-123/);
  const md = await compileMandate(llm, "Pause in a storm.");
  assert.deepEqual([md.source, md.dropped], ["pattern", ["llm: LLM unavailable"]]);
});
