// House firm. Starts tight at 6 bp, light inventory lean, retuned by the rule (manager.ts); pays 1 USDC for a
// failed firm that had customers.
import type { Strategy } from "../src/strategy.ts";

const s: Strategy = {
  name: "Undercut & Co",
  spec: {
    name: "Undercut & Co",
    description: "Starts 6 bp from the mid, retunes its spread from its results; buys failed firms that had customers.",
    skills: ["NEAR/USDC"],
  },
  author: "tontine (house)",
  house: true,
  managed: "rule",
  params: { spreadBps: 6, targetAssetShare: 0.3, skewBps: 10 },
  takeover: (t, me) => (t.fills > 0 && me.stable > 10_000_000n ? 1_000_000n : null),
};
export default s;
