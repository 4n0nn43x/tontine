import { test } from "node:test";
import assert from "node:assert/strict";
import { loadStrategies, safeBid, type Strategy } from "./strategy.ts";
import { judge, obviouslyEmpty } from "./judge.ts";
import { Replay } from "./llm.ts";
import { bidHash } from "./swarm.ts";

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
