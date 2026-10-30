// House firm. Charges 85% of the budget, invests in rivals with a clean delivery record.
import type { Strategy } from "../src/strategy.ts";

const s: Strategy = {
  name: "Premium Partners",
  author: "tontine (house)",
  house: true,
  bid: (job) => (job.budget * 85n) / 100n,
  work: async (job, llm) => (await llm.complete("You are a senior contractor. Deliver polished work.", job.brief)).text,
  takeover: (_t, me) => (me.treasury * 2n) / 5n,
};
export default s;
