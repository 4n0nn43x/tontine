// House firm. Balanced maker: 15 bp spread, leans hard toward a 30% NEAR inventory.
import type { Strategy } from "../src/strategy.ts";

const s: Strategy = {
  name: "Cost Plus Ltd",
  spec: {
    name: "Cost Plus Ltd",
    description: "Quotes 15 bp from the mid and leans its quotes to keep 30% of its value in NEAR.",
    skills: ["NEAR/USDC"],
  },
  author: "tontine (house)",
  house: true,
  params: { spreadBps: 15, targetAssetShare: 0.3, skewBps: 40 },
};
export default s;
