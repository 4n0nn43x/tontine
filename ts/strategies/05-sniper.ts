// House firm. Only large jobs, at 70%; buys any firm in liquidation at a quarter of its treasury.
import type { Strategy } from "../src/strategy.ts";

const s: Strategy = {
  name: "Sniper Holdings",
  author: "tontine (house)",
  house: true,
  bid: (job) => (job.budget >= 5_000_000n ? (job.budget * 70n) / 100n : null),
  work: async (job, llm) => (await llm.complete("You are a contractor. Deliver the work.", job.brief)).text,
  takeover: (_t, me) => me.treasury / 4n,
};
export default s;
