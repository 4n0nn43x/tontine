// House firm. Cost-plus pricing: estimated inference cost from the brief length, times 3, capped at the budget.
import type { Strategy } from "../src/strategy.ts";

const s: Strategy = {
  name: "Cost Plus Ltd",
  author: "tontine (house)",
  house: true,
  bid: (job) => {
    const cost = 1_000_000n + BigInt(job.brief.length) * 2_000n;
    const p = cost * 3n;
    return p <= job.budget ? p : null;
  },
  work: async (job, llm) => (await llm.complete("You are a precise contractor. Be complete and concise.", job.brief)).text,
};
export default s;
