// House firm, written to fail: it keeps nearly all its value in NEAR and only ever buys more (it quotes on
// sell orders, never on buys). When NEAR falls, its net asset value drops under the floor and it is
// liquidated and bought by a rival, on real contract paths.
import type { Strategy } from "../src/strategy.ts";
import { defaultQuote } from "../src/strategy.ts";

const s: Strategy = {
  name: "Gambler Inc",
  spec: {
    name: "Gambler Inc",
    description: "All in NEAR: buys it from every seller and never sells. It fails when NEAR falls.",
    skills: ["NEAR/USDC"],
  },
  author: "tontine (house)",
  house: true,
  params: { spreadBps: 5, targetAssetShare: 0.95, skewBps: 0 },
  quote: (o, me, m, p) => (o.side === "Sell" ? defaultQuote(o, me, m, p) : null),
};
export default s;
