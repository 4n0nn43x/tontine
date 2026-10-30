import { test } from "node:test";
import assert from "node:assert/strict";
import { loadStrategies, safeBid, type Strategy } from "./strategy.ts";
import { checkCriteria, judge, obviouslyEmpty } from "./judge.ts";
import { Replay } from "./llm.ts";
import { createHash } from "node:crypto";
import { bidHash, voteHash } from "./swarm.ts";

const job = { id: 0, client: "c", budget: 10_000_000n, brief: "Translate a README" };
const me = { id: 0, account: "w", treasury: 0n, delivered: 0, rejected: 0 };

test("every file in strategies/ is a valid Strategy", async () => {
  const s = await loadStrategies();
  assert.ok(s.length >= 5);
  for (const x of s) assert.ok(x.name && x.author);
});

test("safeBid drops bids above budget, non-positive or throwing", () => {
  const mk = (bid: Strategy["bid"]): Strategy => ({ name: "t", author: "t", house: false, bid, work: async () => "" });
  assert.equal(safeBid(mk(() => 11_000_000n), job, me), null);
  assert.equal(safeBid(mk(() => 0n), job, me), null);
  assert.equal(safeBid(mk(() => { throw new Error("x"); }), job, me), null);
  assert.equal(safeBid(mk(() => 5n), job, me), 5n);
});

test("judge never accepts an empty deliverable", async () => {
  assert.ok(obviouslyEmpty(""));
  assert.ok(obviouslyEmpty("[replay 0123456789abcdef]   "));
  const v = await judge(new Replay(), job.brief, "");
  assert.equal(v.accept, false);
});

test("bid hash matches the contract format sha256('{amount}:{salt}')", () => {
  // Same vector is asserted in contracts/tender/src/tests.rs (bid_hash_vector).
  assert.equal(bidHash(6_000_000n, "s0"), "bb0041d21898d7bb4e1c67959ec2beaa5e433ead7084e524f13dfc179744f9fd");
  assert.match(bidHash(1n, "x"), /^[0-9a-f]{64}$/);
});

import { multiple, quantile, evaluate } from "./thesis.ts";

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

test("criteria checks are deterministic and fail on the first broken rule", () => {
  assert.equal(checkCriteria("a rubric with no checkable rule", "anything"), null);
  assert.deepEqual(checkCriteria("must include: hola\nmin words: 2", "Hola mundo"), { ok: true, reason: "every criteria check passes" });
  assert.equal(checkCriteria("must include: hola", "bonjour")?.ok, false);
  assert.equal(checkCriteria("regex: ^\\d{3}$", "123")?.ok, true);
  assert.equal(checkCriteria("regex: ^\\d{3}$", "12a")?.ok, false);
  assert.equal(checkCriteria("json", '{"a":1}')?.ok, true);
  assert.equal(checkCriteria("json", "{a:1}")?.ok, false);
  assert.equal(checkCriteria("min words: 5", "too short")?.ok, false);
  assert.equal(checkCriteria("regex: (", "x")?.ok, true, "an invalid pattern checks nothing");
});

test("vote hash matches the contract format sha256('{1|0}:{salt}')", () => {
  assert.equal(voteHash(true, "s"), createHash("sha256").update("1:s").digest("hex"));
  assert.equal(voteHash(false, "s"), createHash("sha256").update("0:s").digest("hex"));
});
