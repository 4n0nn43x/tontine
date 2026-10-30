import { test } from "node:test";
import assert from "node:assert/strict";
import { clear, edge, impliedPrice, inBand, revealRefusal } from "./rules.ts";

const USDC = 1_000_000n;
const NEAR = 10n ** 24n;
const policy = { max_asset_bps: 8000, band_bps: 1000, paused: false };

// Same vectors as contracts/tender/src/tests.rs (order_fills_at_the_second_best_quote_and_pays_dividends).
test("rules mirror the contract: second best fills, edge at the previous price", () => {
  const bids = [(95n * NEAR) / 10n, (99n * NEAR) / 10n, (97n * NEAR) / 10n];
  assert.deepEqual(clear(bids, 9n * NEAR), { winner: 1, out: (97n * NEAR) / 10n });
  assert.deepEqual(clear([(95n * NEAR) / 10n], 9n * NEAR), { winner: 0, out: 9n * NEAR }, "alone: the reserve");
  assert.equal(clear([], 1n), null);
  assert.equal(edge("Buy", 40n * USDC, (97n * NEAR) / 10n, 0, 4n * USDC, NEAR), 1_200_000n);
  assert.equal(edge("Sell", 10n * NEAR, 39n * USDC, 100, 4n * USDC, NEAR), 600_000n, "fee on what the firm receives");
  assert.equal(impliedPrice("Buy", 40n * USDC, 10n * NEAR, NEAR), 4n * USDC);
});

test("reveal checks: reserve, band, inventory, balance", () => {
  const firm = { stable: 1000n * USDC, asset: 100n * NEAR, policy };
  const last = 4n * USDC;
  assert.equal(revealRefusal("Buy", 40n * USDC, 9n * NEAR, 8n * NEAR, firm, last, NEAR), "bid below reserve");
  assert.equal(revealRefusal("Buy", 40n * USDC, 9n * NEAR, 12n * NEAR, firm, last, NEAR), "bid outside the firm's price band");
  assert.equal(revealRefusal("Buy", 40n * USDC, 9n * NEAR, (99n * NEAR) / 10n, firm, last, NEAR), null);
  const tight = { ...firm, policy: { ...policy, max_asset_bps: 5000 } };
  assert.equal(revealRefusal("Sell", 100n * NEAR, 380n * USDC, 395n * USDC, tight, last, NEAR), "fill over the firm's inventory limit");
  assert.equal(revealRefusal("Buy", 40n * USDC, NEAR, 10n * NEAR, { ...firm, asset: NEAR }, last, NEAR), "insufficient balance");
  assert.ok(inBand(4n * USDC, 4n * USDC, 0));
});
