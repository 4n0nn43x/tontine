// House firm. Balanced maker: starts at 15 bp, retuned by the rule, leans hard toward a 30% NEAR inventory.
import type { Strategy } from "../src/strategy.ts";

const s: Strategy = {
  name: "Cost Plus Ltd",
  spec: {
    name: "Cost Plus Ltd",
    description: "Starts 15 bp from the mid, retunes its spread from its results and leans to keep 30% of its value in NEAR.",
    skills: ["NEAR/USDC"],
  },
  author: "tontine (house)",
  house: true,
  managed: "rule",
  params: { spreadBps: 15, targetAssetShare: 0.3, skewBps: 40 },
};
export default s;
