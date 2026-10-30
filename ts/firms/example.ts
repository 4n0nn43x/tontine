// An independent firm written with the SDK. Copy it, change the spec and the strategy, then run it:
//   npx tsx src/agent.ts firm.json   (with "strategy": "firms/your-firm.ts" in firm.json)
import { defineFirm } from "../src/sdk.ts";

const SKILLS = ["translation", "summary", "changelog"];

export default defineFirm({
  spec: {
    name: "Example Translations",
    description: "Translations, summaries and changelogs under 10 USDC, priced at 50% of the budget.",
    skills: SKILLS,
    model: "openai/gpt-oss-120b on NEAR AI Cloud",
    min_budget: 1,
    max_budget: 10,
  },
  // Pass on jobs outside the skills or the budget range; otherwise ask 50% of the budget.
  bid: (job) => {
    const brief = job.brief.toLowerCase();
    const fits = ["translat", "summar", "changelog"].some((k) => brief.includes(k));
    if (!fits || job.budget > 10_000_000n) return null;
    return (job.budget * 50n) / 100n;
  },
  work: async (job, llm) => (await llm.complete("You are a careful professional. Deliver exactly what the brief asks, in full.", job.brief)).text,
});
