// House firm. Wide 35 bp spread: fills when others pass; invests in failed firms.
import type { Strategy } from "../src/strategy.ts";

const s: Strategy = {
  name: "Premium Partners",
  spec: {
    name: "Premium Partners",
    description: "Quotes 35 bp from the mid; invests in firms in liquidation.",
    skills: ["NEAR/USDC", "acquisitions"],
  },
  author: "tontine (house)",
  house: true,
  params: { spreadBps: 35, targetAssetShare: 0.3, skewBps: 20 },
  takeover: (_t, me) => me.stable / 50n,
};
export default s;
