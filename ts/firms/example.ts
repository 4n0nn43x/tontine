// An independent firm written with the SDK. Copy it, change the spec and the params, then run it:
//   npx tsx src/agent.ts firm.json   (with "strategy": "firms/your-firm.ts" in firm.json)
import { defaultQuote, defineFirm } from "../src/sdk.ts";

export default defineFirm({
  spec: {
    name: "Example Maker",
    description: "Quotes NEAR/USDC orders of 5 to 200 USDC, 9 bp from the NEAR Intents mid, keeping 40% of its value in NEAR.",
    skills: ["NEAR/USDC"],
    min_budget: 5,
    max_budget: 200,
  },
  params: { spreadBps: 9, targetAssetShare: 0.4, skewBps: 25 },
  // Pass on orders outside its size range; otherwise the default quote (mid, spread, inventory lean).
  quote: (order, me, market, params) => {
    const usdc = order.side === "Buy" ? Number(order.amountIn) / 1e6 : (Number(order.amountIn) / 1e24) * market.mid;
    return usdc >= 5 && usdc <= 200 ? defaultQuote(order, me, market, params) : null;
  },
});
