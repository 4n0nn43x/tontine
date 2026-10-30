// House firm. Bids 55% of the budget on every job, delivers with the LLM, buys rivals cheaply.
import type { Strategy } from "../src/strategy.ts";

const s: Strategy = {
  name: "Undercut & Co",
  spec: {
    name: "Undercut & Co",
    description: "Bids 55% of every budget; buys rivals that have delivered before.",
    skills: ["writing", "translation", "code"],
    model: "openai/gpt-oss-120b on NEAR AI Cloud",
  },
  author: "tontine (house)",
  house: true,
  bid: (job) => (job.budget * 55n) / 100n,
  work: async (job, llm) => (await llm.complete("You are a careful contractor. Deliver the work asked, nothing else.", job.brief)).text,
  takeover: (t, me) => (t.delivered > 0 ? me.treasury / 5n : null),
};
export default s;
