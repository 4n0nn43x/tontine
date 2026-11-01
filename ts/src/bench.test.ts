import { test } from "node:test";
import assert from "node:assert/strict";
import { BANDIT_ARMS, banditDecide, decide, newBandit, type BanditState } from "./manager.ts";
import { bench } from "./bench.ts";

const params = { spreadBps: 12, targetAssetShare: 0.4, skewBps: 30 };
// Synthetic edge per order offered (USDC): best at 10 bp, falling off on both sides.
const reward = (bp: number) => 0.1 * (1 - Math.abs(bp - 10) / 10);

function play(periods: number) {
  let s = newBandit();
  let p = params;
  const picks: number[] = [];
  for (let t = 0; t < periods; t++) {
    const orders = 12;
    const d = banditDecide(s, p, { quoted: 10, filled: 3, orders, edge: BigInt(Math.round(reward(p.spreadBps) * orders * 1e6)), assetShare: 0.4 });
    s = d.state;
    p = d.params;
    picks.push(p.spreadBps);
  }
  return { s, p, picks };
}

test("the bandit tries each spread once, then plays the best one most, the same way every time", () => {
  const a = play(400);
  assert.deepEqual(play(400), a, "deterministic");
  assert.deepEqual(a.picks.slice(0, BANDIT_ARMS.length), BANDIT_ARMS, "explores in grid order");
  const count = (xs: number[], bp: number) => xs.filter((x) => x === bp).length;
  for (const bp of BANDIT_ARMS) if (bp !== 10) assert.ok(count(a.picks, 10) > count(a.picks, bp), `10 bp played more than ${bp} bp`);
  assert.ok(count(a.picks.slice(-100), 10) > count(a.picks.slice(0, 100), 10), "plays the best arm more as it learns");
  assert.equal(a.p.targetAssetShare, params.targetAssetShare);
  assert.equal(a.p.skewBps, params.skewBps);
  // Serialisable: a JSON round trip decides the same.
  const r = { quoted: 5, filled: 1, orders: 6, edge: 30_000n, assetShare: 0.4 };
  assert.deepEqual(banditDecide(JSON.parse(JSON.stringify(a.s)), a.p, r), banditDecide(a.s, a.p, r));
  // A spread too wide to quote scores 0 per order offered: the period still counts.
  const s: BanditState = { ...newBandit(), arm: 7 };
  assert.equal(banditDecide(s, params, { quoted: 0, filled: 0, orders: 12, edge: 0n, assetShare: 0.4 }).state.pulls[7], 1);
});

test("decide with a bandit state: source bandit, state updated in place, owner bounds applied", async () => {
  const s = newBandit();
  const d = await decide(null, "t", params, { quoted: 0, filled: 0, edge: 0n, assetShare: 0.4 }, 0.3, s);
  assert.equal(d.source, "bandit");
  assert.equal(d.after.targetAssetShare, 0.3, "the owner's inventory cap");
  assert.match(d.reason, /^arm 4 bp/);
  assert.equal(d.after.spreadBps, 4);
  assert.equal(s.arm, 0);
});

test("the bench on a tiny window: every arm, paired runs, intervals around the mean", async () => {
  const r = await bench({ seed: 1, seeds: 1, days: 1, windows: 2, clients: 5, extraFirms: 1, ordersPerHour: 12, llm: false });
  assert.deepEqual(r.arms, ["fixed", "rule", "bandit"]);
  assert.equal(r.windows.length, 2);
  assert.equal(r.runs.length, 2 * 3);
  assert.equal(r.windows[1].offset - r.windows[0].offset, 288, "back to back days");
  assert.ok(r.skipped[0].startsWith("llm"));
  for (const arm of r.arms)
    for (const k of ["pnl", "fills", "edge", "maxDrawdown", "winRate", "pnlVsFixed"] as const) {
      const x = r.summary[arm][k];
      assert.ok(x.lo <= x.mean && x.mean <= x.hi, `${arm} ${k}`);
    }
  assert.equal(r.summary.fixed.pnlVsFixed.mean, 0);
});
