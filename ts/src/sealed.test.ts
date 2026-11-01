// The /city game's rules (app/src/lib/sealed.ts): rounds from chain events, odds, payouts, refunds, pity chips.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPlayer, newPlayer, oddsOf, PITY_TO, Sealed, type Ev } from "../../app/src/lib/sealed.ts";

const ev = (event: string, data: any, market: "NEAR" | "ETH" | "SOL" = "NEAR"): Ev => ({ event, market, data });
const round = (g: Sealed, auction = 7, order = 3, market: "NEAR" | "ETH" | "SOL" = "NEAR") => {
  g.apply(ev("order_posted", { order_id: order, auction_id: auction, side: "Buy", client: "c" }, market));
  for (const f of [1, 2, 3]) g.apply(ev("bid_committed", { auction_id: auction, firm_id: f }, market));
  return `${market}:${auction}`;
};

test("odds follow the bidders' past fills, less 8%, between 1.1 and 8", () => {
  const o = oddsOf([1, 2, 3], (f) => ({ 1: 18, 2: 0, 3: 1 })[f]!);
  // weights 19, 1, 2 out of 22
  assert.equal(o.get(1), 1.1);
  assert.equal(o.get(2), 8);
  assert.equal(o.get(3), 8); // 10.1, capped
  const even = oddsOf([1, 2], () => 5);
  assert.equal(even.get(1), 1.8);
});

test("a winning call pays stake times odds; a streak and badges follow", () => {
  const g = new Sealed(newPlayer("d"));
  const k = round(g);
  assert.equal(g.back(k, 2, 25, new Map([[2, 3]])), null);
  assert.equal(g.player.chips, 75);
  assert.match(g.back(k, 1, 10, new Map([[1, 2]])) ?? "", /already backed/);
  g.apply(ev("bid_revealed", { auction_id: 7, firm_id: 2, amount: "5" }));
  g.apply(ev("auction_settled", { auction_id: 7, winner: 2, price: "4" }));
  assert.equal(g.rounds.get(k)!.paid, 75);
  assert.equal(g.player.chips, 150);
  assert.deepEqual([g.player.hits, g.player.streak, g.player.today], [1, 1, 50]);
  assert.ok(g.player.badges.includes("first-call") && g.player.badges.includes("longshot"));
});

test("no bet once revealed; a loss resets the streak and pity chips keep a broke player in", () => {
  const p = newPlayer("d");
  p.chips = 12;
  const g = new Sealed(p);
  const k = round(g);
  assert.equal(g.back(k, 1, 12, new Map([[1, 1.5]])), null);
  g.apply(ev("bid_revealed", { auction_id: 7, firm_id: 3, amount: "5" }));
  const k2 = round(g, 8, 4);
  g.apply(ev("bid_revealed", { auction_id: 8, firm_id: 1, amount: "5" }));
  assert.match(g.back(k2, 1, 5, new Map()) ?? "", /already revealed/);
  g.apply(ev("auction_settled", { auction_id: 7, winner: 3, price: "4" }));
  assert.equal(g.rounds.get(k)!.paid, 0);
  assert.deepEqual([g.player.streak, g.player.chips, g.player.pity], [0, PITY_TO, 1]);
});

test("a refund (no winner) gives the stake back; markets with the same auction id stay apart", () => {
  const g = new Sealed(newPlayer("d"));
  const near = round(g, 5, 2, "NEAR");
  const eth = round(g, 5, 2, "ETH");
  g.back(near, 1, 10, new Map([[1, 2]]));
  g.back(eth, 2, 10, new Map([[2, 2]]));
  g.apply(ev("order_refunded", { order_id: 2, client: "c" }, "ETH"));
  assert.equal(g.rounds.get(eth)!.phase, "refunded");
  assert.equal(g.rounds.get(near)!.phase, "sealed");
  assert.equal(g.player.chips, 90);
  g.apply(ev("auction_settled", { auction_id: 5, winner: null, price: null }, "NEAR"));
  assert.equal(g.player.chips, 100);
  assert.equal(g.player.calls, 0);
});

test("a saved player resumes the same day, and a new day keeps badges and the best streak", () => {
  const saved = JSON.stringify({ ...newPlayer("2026-11-01"), chips: 40, best: 4, badges: ["oracle"] });
  assert.equal(loadPlayer(saved, "2026-11-01").chips, 40);
  const next = loadPlayer(saved, "2026-11-02");
  assert.deepEqual([next.chips, next.best, next.badges], [100, 4, ["oracle"]]);
  assert.equal(loadPlayer("{bad", "d").chips, 100);
});
