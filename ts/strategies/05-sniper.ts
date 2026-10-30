// House firm. Only orders of 50 USDC or more, at 10 bp; pays 0.5 USDC for any firm in liquidation.
import type { Strategy } from "../src/strategy.ts";
import { defaultQuote } from "../src/strategy.ts";

const s: Strategy = {
  name: "Sniper Holdings",
  spec: {
    name: "Sniper Holdings",
    description: "Only orders of 50 USDC or more, at 10 bp; buys any firm in liquidation.",
    skills: ["NEAR/USDC", "large orders", "acquisitions"],
    min_budget: 50,
  },
  author: "tontine (house)",
  house: true,
  params: { spreadBps: 10, targetAssetShare: 0.3, skewBps: 10 },
  quote: (o, me, m, p) => {
    const notional = o.side === "Buy" ? o.amountIn : (o.amountIn * BigInt(Math.round(m.mid * 1e6))) / m.unit;
    return notional >= 50_000_000n ? defaultQuote(o, me, m, p) : null;
  },
  takeover: (_t, me) => (me.stable > 10_000_000n ? 500_000n : null),
};
export default s;
