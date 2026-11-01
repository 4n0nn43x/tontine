// Run: cd app && npx tsx src/lib/achievements.check.ts
import type { ChainEvent, FirmState } from "./api";
import { achievements, cheerFor, healthOf, levelOf, rankFirms } from "./achievements";

// The app's tsconfig has no node types: a JSON-equality assert is enough here.
function deepEqual(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const assert = { deepEqual, equal: deepEqual };
const firm = (id: number, o: Partial<FirmState> = {}): FirmState =>
  ({ id, account: `w${id}.tender`, owner: `o${id}`, status: "Solvent", holdings: [{ account: `o${id}`, shares: 100, debt: "0" }], fills: 0, edge: "0", dividends: "0", takeovers: 0, profile: null, strategy: null, ...o }) as FirmState;
let n = 0;
const ev = (event: string, data: any): ChainEvent => ({ id: ++n, height: n, time: n, txHash: "", signer: "", contract: "tender", standard: "tontine", event, data });

// Levels: 1 at 0 fills, 2 at 1, 3 at 3, 4 at 6.
assert.deepEqual([0, 1, 2, 3, 5, 6, 45].map((f) => levelOf(f).level), [1, 2, 2, 3, 3, 4, 10]);
assert.deepEqual(levelOf(4), { level: 3, into: 1, span: 3, progress: 1 / 3 });

// Health: red under the floor, amber under 125% of it.
assert.equal(healthOf(39n, 40n), "bad");
assert.equal(healthOf(40n, 40n), "warn");
assert.equal(healthOf(49n, 40n), "warn");
assert.equal(healthOf(50n, 40n), "good");

// Ranking: edge first, closed firms last, ties broken by fills then id.
const ranked = rankFirms([firm(0, { edge: "5" }), firm(1, { edge: "9", status: "Closed" }), firm(2, { edge: "5", fills: 2 }), firm(3, { edge: "-1" })]);
assert.deepEqual(ranked.map((f) => f.id), [2, 0, 3, 1]);

// Badges.
const firms = [
  firm(0, { fills: 12, dividends: "300", holdings: [{ account: "o0", shares: 100, debt: "0" }] }),
  firm(1, { fills: 1, dividends: "100", takeovers: 1, holdings: [{ account: "w0.tender", shares: 100, debt: "0" }] }),
  firm(2, { fills: 55 }),
];
const events = [
  ev("order_filled", { firm_id: 0, out: "1010", reference_out: "1000" }),
  ev("order_filled", { firm_id: 1, out: "1020", reference_out: "1000" }),
  ev("liquidated", { firm_id: 1, buyer_firm_id: 0 }),
  ev("order_filled", { firm_id: 1, out: "1001", reference_out: "1000" }),
  ev("liquidation_started", { firm_id: 2 }),
];
const a = achievements(firms, events);
const ids = (id: number) => a.get(id)!.map((x) => x.id);
assert.deepEqual(ids(0), ["fills-10", "raider", "survivor", "dividends"]);
assert.deepEqual(ids(1), ["first-fill", "comeback", "sharpest"]);
assert.deepEqual(ids(2), ["fills-50"]);
assert.deepEqual(achievements([firm(0)], []).get(0), []);
// A firm its mandate kept out of a storm.
assert.deepEqual(achievements([{ ...firm(0), weathered: 3 } as FirmState], []).get(0)!.map((x) => [x.id, x.tip]), [["weathered", "Its mandate kept it out of 3 orders in a storm"]]);

// Toasts: only the visitor's own wins.
const clientOf = (id: number) => (id === 7 ? "me" : "someone");
assert.equal(cheerFor(ev("order_filled", { order_id: 7, firm_id: 0, side: "Buy", out: "1010", reference_out: "1000" }), "me", firms, clientOf)?.title, "Order filled");
assert.equal(cheerFor(ev("order_filled", { order_id: 8, firm_id: 0, side: "Buy", out: "1010", reference_out: "1000" }), "me", firms, clientOf), null);
// The client gets the firm's `out` less Tontine's surplus share, in its market's units.
const sell = ev("order_filled", { order_id: 7, firm_id: 0, side: "Sell", out: "1010000", surplus_fee: "3000", reference_out: "1000000" });
assert.equal(cheerFor(sell, "me", firms, clientOf, { symbol: "ETH", decimals: 18 })?.text, "ETH #7: 1.0070 USDC from Firm #0, +70.0 bp vs market");
assert.equal(cheerFor(ev("dividend_claimed", { account: "me", firm_id: 0, amount: "1500" }), "me", firms, clientOf)?.text, "+0.0015 USDC from Firm #0");
assert.equal(cheerFor(ev("auction_settled", { auction_id: 3, winner: 2, price: "1" }), "o2", firms, clientOf)?.title, "Your firm won");
assert.equal(cheerFor(ev("auction_settled", { auction_id: 3, winner: null, price: null }), "o2", firms, clientOf), null);

console.log("achievements: all checks pass");
