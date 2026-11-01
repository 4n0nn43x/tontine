import { after, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { ASSETS, CLIENT_TOLERANCE_BPS, LAST_GOOD_MS, marketMid, outAt, reference, replayPrices } from "./prices.ts";

// No network: fetch is stubbed, and Date is mocked so each test starts past the 5 s cache.
const realFetch = globalThis.fetch;
mock.timers.enable({ apis: ["Date"] });
beforeEach(() => mock.timers.tick(60_000));
after(() => {
  globalThis.fetch = realFetch;
  mock.timers.reset();
});
delete process.env.REPLAY;

/** Each venue answers its own JSON shape with a book of mid ± 0.5, fails with 503 if `null`, and throws if absent. */
function stub(m: Partial<Record<"binance" | "okx" | "coinbase", number | null>>): string[] {
  const calls: string[] = [];
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const venue = (["binance", "okx", "coinbase"] as const).find((v) => url.includes(v))!;
    const mid = m[venue];
    if (mid === undefined) throw new TypeError("fetch failed");
    if (mid === null) return new Response("down", { status: 503 });
    const [bid, ask] = [String(mid - 0.5), String(mid + 0.5)];
    const body = venue === "binance" ? { bidPrice: bid, askPrice: ask } : venue === "okx" ? { code: "0", data: [{ bidPx: bid, askPx: ask }] } : { bid, ask };
    return new Response(JSON.stringify(body));
  };
  return calls;
}

test("marketMid takes the median of three venues", async () => {
  const calls = stub({ binance: 102, okx: 100, coinbase: 101 });
  const m = await marketMid("NEAR");
  assert.equal(m.mid, 101);
  assert.deepEqual(m.sources.map((s) => s.name), ["binance", "okx", "coinbase"]);
  assert.ok(calls.some((u) => u.includes("symbol=NEARUSDT")) && calls.some((u) => u.includes("NEAR-USDT")) && calls.some((u) => u.includes("NEAR-USD/ticker")));
});

test("marketMid averages two venues, and survives one down", async () => {
  stub({ binance: 100, okx: 102, coinbase: null });
  const m = await marketMid("NEAR");
  assert.equal(m.mid, 101);
  assert.deepEqual(m.sources, [{ name: "binance", mid: 100 }, { name: "okx", mid: 102 }]);
  mock.timers.tick(60_000);
  stub({ okx: 101, coinbase: 103 }); // binance throws; under 2% apart (further, see below)
  assert.equal((await marketMid("NEAR")).mid, 102);
});

test("marketMid with one venue left uses it, and throws when none answers", async () => {
  stub({ coinbase: 90 });
  assert.equal((await marketMid("SOL")).mid, 90);
  mock.timers.tick(LAST_GOOD_MS); // past the last good mid (see below)
  stub({ binance: null, okx: null });
  await assert.rejects(marketMid("SOL"), /no market price for SOL/);
});

test("marketMid spread is the gap between venues in bp of the mid", async () => {
  stub({ binance: 100, okx: 101, coinbase: 102 });
  const m = await marketMid("ETH");
  assert.ok(Math.abs(m.spreadBps - (2 / 101) * 1e4) < 1e-9);
  mock.timers.tick(60_000);
  stub({ binance: 100, okx: 100, coinbase: 100 });
  assert.equal((await marketMid("ETH")).spreadBps, 0);
});

test("marketMid is cached 5 s per asset", async () => {
  const calls = stub({ binance: 100, okx: 100, coinbase: 100 });
  assert.equal((await marketMid("ETH")).mid, 100);
  stub({ binance: 200, okx: 200, coinbase: 200 });
  mock.timers.tick(4999);
  assert.equal((await marketMid("ETH")).mid, 100, "still cached");
  assert.equal(calls.length, 3);
  assert.equal((await marketMid("SOL")).mid, 200, "another asset is not");
  mock.timers.tick(1);
  assert.equal((await marketMid("ETH")).mid, 200, "expired");
});

test("outAt converts at the mid less the cost, on buys and sells", () => {
  // 100 USDC buys 25 NEAR at 4, less 25 bp.
  assert.equal(outAt("Buy", 100_000_000n, 4, 25), 24_937_500_000_000_000_000_000_000n);
  // 2 NEAR sells for 9 USDC at 4.5, then less 25 bp.
  assert.equal(outAt("Sell", 2n * ASSETS.NEAR.unit, 4.5, 0), 9_000_000n);
  assert.equal(outAt("Sell", 2n * ASSETS.NEAR.unit, 4.5, 25), 8_977_500n);
  // Other assets use their own unit: 3000 USDC buys 1.5 ETH at 2000; 0.5 SOL sells for 50 USDC at 100.
  assert.equal(outAt("Buy", 3_000_000_000n, 2000, 0, ASSETS.ETH.unit), 1_500_000_000_000_000_000n);
  assert.equal(outAt("Sell", ASSETS.SOL.unit / 2n, 100, 0, ASSETS.SOL.unit), 50_000_000n);
});

test("reference uses the market mid live, and the replay when every venue fails", async () => {
  stub({ binance: 99, okx: 101, coinbase: 100 });
  const live = await reference("Buy", 1_000_000_000n, -1, "SOL");
  assert.equal(live.source, "market");
  assert.equal(live.mid, 100);
  assert.equal(live.sources.length, 3);
  assert.equal(live.out, outAt("Buy", 1_000_000_000n, 100, CLIENT_TOLERANCE_BPS, ASSETS.SOL.unit));
  mock.timers.tick(LAST_GOOD_MS); // past ETH's last good mid
  const calls = stub({});
  const off = await reference("Sell", ASSETS.ETH.unit, -1, "ETH");
  const last = replayPrices("ETH").prices.at(-1)!;
  assert.deepEqual(off, { out: outAt("Sell", ASSETS.ETH.unit, last, CLIENT_TOLERANCE_BPS, ASSETS.ETH.unit), mid: last, source: "replay", sources: [] });
  assert.equal(calls.length, 3);
  assert.equal((await reference("Buy", 100_000_000n, 7)).mid, replayPrices().prices[7]);
  assert.equal(calls.length, 3, "a replay index skips the network");
});

test("marketMid: concurrent misses share one fetch per venue", async () => {
  const calls = stub({ binance: 3, okx: 3, coinbase: 3 });
  const all = await Promise.all(Array.from({ length: 60 }, () => marketMid("NEAR")));
  assert.equal(calls.length, 3);
  assert.ok(all.every((m) => m.mid === 3));
  mock.timers.tick(60_000);
  stub({});
  await assert.rejects(Promise.all([marketMid("SOL"), marketMid("SOL")]).then(() => marketMid("SOL")), /no market price/, "a failed fetch is not kept");
  stub({ coinbase: 90 });
  assert.equal((await marketMid("SOL")).mid, 90);
});

test("marketMid: two venues far apart, the one closer to the last good mid; none recent, it throws", async () => {
  mock.timers.tick(LAST_GOOD_MS);
  stub({ binance: 3, okx: 3.01, coinbase: 30 });
  assert.equal((await marketMid("NEAR")).mid, 3.01, "three venues: the median ignores a x10 print");
  mock.timers.tick(60_000);
  stub({ okx: 3.01, coinbase: 30 }); // binance down
  const m = await marketMid("NEAR");
  assert.deepEqual([m.mid, m.sources], [3.01, [{ name: "okx", mid: 3.01 }]], "not the average, 16.5");
  mock.timers.tick(60_000);
  stub({ okx: 3.04, coinbase: 3.02 });
  assert.ok(Math.abs((await marketMid("NEAR")).mid - 3.03) < 1e-9, "within 2%: their average");
  mock.timers.tick(LAST_GOOD_MS);
  stub({ okx: 3, coinbase: 30 });
  await assert.rejects(marketMid("NEAR"), /two venues .*% apart/);
});

test("marketMid: every venue down, the last good mid for 10 minutes, then the replay", async () => {
  stub({ binance: 100, okx: 101, coinbase: 102 });
  assert.equal((await marketMid("ETH")).mid, 101);
  mock.timers.tick(60_000);
  stub({});
  const m = await marketMid("ETH");
  assert.deepEqual([m.mid, m.sources], [101, [{ name: "last good mid, 60 s old", mid: 101 }]]);
  const r = await reference("Sell", ASSETS.ETH.unit, -1, "ETH");
  assert.deepEqual([r.source, r.mid, r.sources[0].name], ["market", 101, "last good mid, 60 s old"]);
  mock.timers.tick(LAST_GOOD_MS - 60_000);
  await assert.rejects(marketMid("ETH"), /no market price for ETH/, "10 minutes after the last good mid");
  assert.equal((await reference("Sell", ASSETS.ETH.unit, -1, "ETH")).source, "replay");
});

test("each replay fixture covers the NEAR range with sensible prices", () => {
  const near = replayPrices("NEAR");
  for (const [symbol, lo, hi] of [["NEAR", 1, 10], ["ETH", 1000, 10_000], ["SOL", 50, 500]] as const) {
    const fx = replayPrices(symbol);
    assert.equal(fx.start_ms, near.start_ms, symbol);
    assert.equal(fx.interval_ms, 300_000, symbol);
    assert.equal(fx.prices.length, near.prices.length, symbol);
    assert.ok(fx.prices.every((p) => p > lo && p < hi), `${symbol} within ${lo}..${hi}`);
  }
});
