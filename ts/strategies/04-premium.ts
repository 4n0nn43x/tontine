// House firm. Wide 20 bp spread, never retuned: fills when the others pass; invests in failed firms.
import type { Strategy } from "../src/strategy.ts";

const s: Strategy = {
  name: "Premium Partners",
  spec: {
    name: "Premium Partners",
    description: "Quotes 20 bp from the mid when the others pass; invests in firms in liquidation.",
    skills: ["NEAR/USDC", "acquisitions"],
  },
  author: "tontine (house)",
  house: true,
  params: { spreadBps: 20, targetAssetShare: 0.3, skewBps: 20 },
  takeover: (_t, me) => me.stable / 50n,
};
export default s;
