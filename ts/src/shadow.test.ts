import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { counterfactual, DecisionLog, GENESIS, merkle, ShadowBook, type LogEntry } from "./shadow.ts";

const USDC = 1_000_000n;
const NEAR = 10n ** 24n;
const n = (x: number) => (BigInt(Math.round(x * 10)) * NEAR) / 10n;

// A buy of 40 USDC, minimum 9 NEAR. Commit order: firm 1, firm 2 (ours), firm 3.
const revealed = [
  { firmId: 1, amount: n(9.5) },
  { firmId: 2, amount: n(9.7) },
  { firmId: 3, amount: n(9.9) },
];
const order = { auction: 7, firmId: 2, side: "Buy" as const, amountIn: 40n * USDC, reserve: 9n * NEAR, feeBps: 2, ref: 4n * USDC, unit: NEAR };

test("counterfactual second price: a shadow win and a loss on a hand-made auction", () => {
  assert.deepEqual(counterfactual(revealed, 2, n(9.7), order.reserve), { winner: 3, out: n(9.7) }, "actual: firm 3 wins at our bid");
  assert.deepEqual(counterfactual(revealed, 2, n(10), order.reserve), { winner: 2, out: n(9.9) }, "a higher shadow bid wins at the second best");
  assert.deepEqual(counterfactual(revealed, 2, n(9.9), order.reserve), { winner: 2, out: n(9.9) }, "a tie goes to the earlier commit: ours");
  assert.deepEqual(counterfactual(revealed.filter((b) => b.firmId !== 2), 2, n(9.9), order.reserve), { winner: 3, out: n(9.9) }, "not revealed for real: the shadow goes last");
  assert.deepEqual(counterfactual(revealed, 2, n(8), order.reserve), { winner: 3, out: n(9.5) }, "under the reserve: refused at reveal, as passing");
  assert.equal(counterfactual(revealed.slice(1), 2, null, order.reserve), null, "one bid left: no fill under min_bidders 2");
  assert.deepEqual(counterfactual(revealed.slice(1), 2, null, order.reserve, 1), { winner: 3, out: order.reserve });

  const book = new ShadowBook();
  book.record({ ...order, bids: { actual: n(9.7), rule: n(10), fixed: null } });
  const [r] = book.settle(7, revealed);
  // Edge at the reference: 40 USDC less the 2 bp fee, less 9.9 NEAR at 4 USDC.
  const edge = 40n * USDC - 8000n - 39_600_000n;
  assert.deepEqual(r.outcomes, { actual: { won: false, out: 0n, edge: 0n }, rule: { won: true, out: n(9.9), edge }, fixed: { won: false, out: 0n, edge: 0n } });
  assert.deepEqual(book.summary(2), {
    actual: { auctions: 1, wins: 0, delivered: 0n, edge: 0n },
    rule: { auctions: 1, wins: 1, delivered: 39_600_000n, edge },
    fixed: { auctions: 0, wins: 0, delivered: 0n, edge: 0n },
  });
  assert.deepEqual(book.settle(7, revealed), [], "an auction is settled once");

  // A sell: 10 NEAR in, the firm delivers USDC.
  book.record({ auction: 8, firmId: 2, side: "Sell", amountIn: 10n * NEAR, reserve: 38n * USDC, feeBps: 0, ref: 4n * USDC, unit: NEAR, bids: { actual: 39n * USDC, rule: 39n * USDC, fixed: 39n * USDC } });
  book.settle(8, [{ firmId: 2, amount: 39n * USDC }, { firmId: 5, amount: 385n * USDC / 10n }]);
  assert.deepEqual(book.summary(2).fixed, { auctions: 1, wins: 1, delivered: 38_500_000n, edge: 1_500_000n });
});

test("Merkle root on a known vector", () => {
  const h = (s: string) => createHash("sha256").update(s).digest("hex");
  const [a, b, c] = ["a", "b", "c"].map(h);
  assert.equal(a, "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
  assert.equal(merkle([a, b]), "e5a01fee14e0ed5c48714f22180f25ad8365b53f9779f79dc4a3d7e93963f94a");
  assert.equal(merkle([a, b, c]), "d31a37ef6ac14a2db1470c4316beb5592e6afd4465022339adafda76a18ffabe", "the odd leaf is doubled");
  assert.equal(merkle([a]), a);
  assert.equal(merkle([]), null);
});

test("decision log: hash chain, tampering detected, daily root, reload", () => {
  const log = new DecisionLog();
  const day = Date.UTC(2026, 10, 1);
  const e0 = log.append({ firm: "Atlas AI", after: { spreadBps: 12 }, edge: 5n }, { text: "sig" }, day + 1000);
  log.append({ firm: "Atlas AI", after: { spreadBps: 14 } }, null, day + 2000);
  log.append({ firm: "Undercut" }, null, day + 3000);
  log.append({ firm: "Atlas AI" }, null, day + 86_400_000);
  assert.equal(e0.prev, GENESIS);
  assert.equal(e0.hash, createHash("sha256").update(e0.json).digest("hex"));
  assert.deepEqual(JSON.parse(e0.json), { seq: 0, at: day + 1000, prev: GENESIS, record: { firm: "Atlas AI", after: { spreadBps: 12 }, edge: "5" }, signature: { text: "sig" } });
  assert.equal(log.entries[1].prev, e0.hash);
  assert.deepEqual(log.verifyChain(), { ok: true });
  assert.equal(log.merkleRoot("2026-11-01"), merkle(log.entries.slice(0, 3).map((e) => e.hash)));
  assert.equal(log.merkleRoot("2026-11-02"), log.entries[3].hash);
  assert.equal(log.merkleRoot("2026-11-03"), null);

  const copy = (es: LogEntry[]) => new DecisionLog(JSON.parse(JSON.stringify(es)));
  assert.deepEqual(copy(log.entries).verifyChain(), { ok: true }, "reloaded from JSON");
  const edited = copy(log.entries);
  edited.entries[1].json = edited.entries[1].json.replace('"spreadBps":14', '"spreadBps":40');
  assert.deepEqual(edited.verifyChain(), { ok: false, bad: 1 });
  const dropped = copy(log.entries);
  dropped.entries.splice(1, 1);
  assert.deepEqual(dropped.verifyChain(), { ok: false, bad: 1 });
  const redated = copy(log.entries);
  redated.entries[2].at += 86_400_000;
  assert.deepEqual(redated.verifyChain(), { ok: false, bad: 2 }, "the date is inside the hash");
});

test("decision log: 7 days in memory, the chain verifies across the window, dropped days keep their root", () => {
  const log = new DecisionLog();
  const day0 = Date.UTC(2026, 10, 1);
  const day = (d: number) => new Date(day0 + d * 86_400_000).toISOString().slice(0, 10);
  const roots: (string | null)[] = [];
  const all: LogEntry[] = [];
  for (let d = 0; d < 9; d++) {
    for (let i = 0; i < 3; i++) all.push(log.append({ d, i }, null, day0 + d * 86_400_000 + i * 1000));
    roots.push(log.merkleRoot(day(d)));
  }
  assert.equal(log.entries.length, 21, "days 2 to 8");
  assert.deepEqual([log.entries[0].seq, log.entries.at(-1)!.seq], [6, 26]);
  assert.equal(log.entries[0].prev, all[5].hash, "the window's first prev: the hash of the last entry dropped");
  assert.deepEqual(log.verifyChain(), { ok: true });
  assert.deepEqual([log.day(day(1)), log.day(day(2)).map((e) => e.seq)], [[], [6, 7, 8]]);
  assert.equal(log.merkleRoot(day(0)), roots[0], "a dropped day keeps its root");
  assert.equal(log.merkleRoot(day(1)), merkle(all.slice(3, 6).map((e) => e.hash)));
  assert.equal(log.merkleRoot(day(9)), null);
  // A root is cached until its day gets another entry.
  const e = log.append({ late: true }, null, day0 + 8 * 86_400_000 + 5000);
  assert.equal(e.seq, 27);
  assert.equal(log.merkleRoot(day(8)), merkle([...all.slice(24), e].map((x) => x.hash)));
  assert.notEqual(log.merkleRoot(day(8)), roots[8]);
  // Tampering inside the window is still caught; so is a window that does not start at a link.
  const copy = (es: LogEntry[]) => new DecisionLog(JSON.parse(JSON.stringify(es)));
  const edited = copy(log.entries);
  edited.entries[4].json = edited.entries[4].json.replace('"i":1', '"i":2');
  assert.deepEqual(edited.verifyChain(), { ok: false, bad: 4 });
  const cut = copy(log.entries);
  cut.entries.splice(1, 1);
  assert.deepEqual(cut.verifyChain(), { ok: false, bad: 1 });
  assert.deepEqual(copy(log.entries).verifyChain(), { ok: true }, "a reloaded window verifies");
});
