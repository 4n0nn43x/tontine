// House firm with an AI manager: it starts at 12 bp and an LLM on NEAR AI Cloud retunes its spread,
// inventory target and lean from its results (manager.ts). Without a key, a stated rule does it, labelled.
import type { Strategy } from "../src/strategy.ts";

const s: Strategy = {
  name: "Atlas AI",
  spec: {
    name: "Atlas AI",
    description: "An LLM retunes its spread and inventory from its results; the owner's on-chain policy bounds it.",
    skills: ["NEAR/USDC"],
    model: "openai/gpt-oss-120b on NEAR AI Cloud",
  },
  author: "tontine (house)",
  house: true,
  managed: true,
  params: { spreadBps: 12, targetAssetShare: 0.4, skewBps: 30 },
};
export default s;
