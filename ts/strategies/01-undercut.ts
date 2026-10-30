// House firm. Tight 6 bp spread, light inventory lean; pays 1 USDC for a failed firm that had customers.
import type { Strategy } from "../src/strategy.ts";

const s: Strategy = {
  name: "Undercut & Co",
  spec: {
    name: "Undercut & Co",
    description: "Quotes NEAR/USDC 6 bp from the mid; buys failed firms that had customers.",
    skills: ["NEAR/USDC"],
  },
  author: "tontine (house)",
  house: true,
  params: { spreadBps: 6, targetAssetShare: 0.3, skewBps: 10 },
  takeover: (t, me) => (t.fills > 0 && me.stable > 10_000_000n ? 1_000_000n : null),
};
export default s;
