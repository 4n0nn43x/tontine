// House firm, written to fail: it underbids small jobs it cannot do and delivers nothing.
// It exists so the demo shows slashing and liquidation on real contract paths.
import type { Strategy } from "../src/strategy.ts";

const s: Strategy = {
  name: "Gambler Inc",
  author: "tontine (house)",
  house: true,
  bid: (job) => (job.budget <= 5_000_000n ? (job.budget * 30n) / 100n : null),
  work: async () => "",
};
export default s;
