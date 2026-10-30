// Tontine SDK: write a firm (its spec and its strategy) and run it yourself, with your own keys, against
// any Tontine deployment (the hosted devnet through its /rpc, or a real network). See SDK.md.
import { JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { account, call, chainTime, sleep, view } from "./chain.ts";
import { makeLlm, type Llm } from "./llm.ts";
import type { FirmSpec, Params, Strategy } from "./strategy.ts";
import { reference } from "./prices.ts";
import { Swarm, type FirmHandle } from "./swarm.ts";

export type { FirmCtx, FirmSpec, Market, OrderView, Params, Strategy, TargetView } from "./strategy.ts";
export { defaultQuote } from "./strategy.ts";
export type { Llm } from "./llm.ts";
export { bidHash } from "./swarm.ts";

export type FirmDefinition = {
  spec: FirmSpec;
  /** Starting params of the default quote: spread, NEAR inventory target, lean toward it. */
  params: Params;
  /** Optional: your own quote (what the firm delivers for an order, or null to pass). */
  quote?: Strategy["quote"];
  /** Optional: let a manager retune the params from the firm's results (an LLM with NEARAI_API_KEY). */
  managed?: boolean;
};

/** Check a firm definition and turn it into a strategy the runner (or the house swarm) can use. */
export function defineFirm(d: FirmDefinition): Strategy & { spec: FirmSpec } {
  const s = d.spec;
  if (!/^[A-Za-z0-9 &.'-]{2,32}$/.test(s.name ?? "")) throw new Error("spec.name: 2 to 32 letters, digits, spaces or & . ' -");
  if (!s.description || s.description.length > 280) throw new Error("spec.description: 1 to 280 characters");
  if (!Array.isArray(s.skills) || s.skills.length > 10) throw new Error("spec.skills: up to 10 strings");
  if (JSON.stringify(s).length > 2000) throw new Error("spec: at most 2000 bytes of JSON");
  if (!(d.params.spreadBps > -300 && d.params.spreadBps < 300)) throw new Error("params.spreadBps: between -300 and 300");
  return { name: s.name, author: "independent", house: false, spec: s, params: d.params, quote: d.quote, managed: d.managed };
}

export type RunOptions = {
  /** JSON-RPC endpoint, e.g. https://<host>/rpc for the hosted devnet. */
  rpc: string;
  /** The tender contract account. */
  tender: string;
  firmId: number;
  /** The firm account (w<id+1>.<tender>). */
  account: string;
  /** Agent keys: `tender` bids and settles on tender; `firm` spends from the firm's budget. */
  keys: { tender: string; firm: string };
  /** Optional owner key: publishes the spec when it changed. Never needed to bid or deliver. */
  owner?: { account: string; key: string };
  firm: Strategy;
  llm?: Llm;
  /** Account paid for inference from the firm's budget on every manager decision (optional). */
  inference?: string;
  log?: (s: string) => void;
};

/** Run one firm forever: quote every open order (only bids its owner's policy and the contract accept),
 * let its manager retune it, and earn keeper rewards by settling auctions and ticking epochs. Ctrl+C stops it. */
export async function runFirm(o: RunOptions): Promise<never> {
  const log = o.log ?? ((s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`));
  const provider = new JsonRpcProvider({ url: o.rpc });
  const onChain = await view(provider, o.tender, "get_firm", { firm_id: o.firmId });
  if (onChain.account !== o.account) throw new Error(`firm #${o.firmId} is ${onChain.account}, not ${o.account}`);
  const owner = o.owner ? account(o.owner.account, provider, o.owner.key as KeyPairString) : account(onChain.owner, provider, KeyPair.fromRandom("ed25519"));
  if (o.owner && o.firm.spec && onChain.profile !== JSON.stringify(o.firm.spec)) {
    await call(owner, o.tender, "set_firm_profile", { firm_id: o.firmId, profile: JSON.stringify(o.firm.spec) }, 1n);
    log(`published the spec of ${o.firm.name}`);
  }
  // Takeover bids are signed by the owner: only offered when its key is given.
  const strategy: Strategy = o.owner ? o.firm : { ...o.firm, takeover: undefined };
  const handle: FirmHandle = {
    id: o.firmId,
    account: o.account,
    owner,
    agentTender: account(o.account, provider, o.keys.tender as KeyPairString),
    agentFirm: account(o.account, provider, o.keys.firm as KeyPairString),
    strategy,
  };
  // The reference mid: a NEAR Intents 1Click quote (live), cached 30 s.
  let mid = { v: (await reference("Buy", 100_000_000n)).mid, at: Date.now() };
  const midNow = async () => {
    if (Date.now() - mid.at > 30_000) mid = { v: (await reference("Buy", 100_000_000n)).mid, at: Date.now() };
    return mid.v;
  };
  const swarm = new Swarm(provider, o.tender, [handle], o.llm ?? makeLlm(), o.inference ?? "", midNow, (s) => log(s.trim()));
  const config = await view(provider, o.tender, "get_config");
  log(`${strategy.name} (firm #${o.firmId}) is running on ${o.rpc}`);

  const running = new Set<number>();
  let lastTick = 0;
  let lastManaged = Date.now();
  // tender pages orders from the oldest: walk to the end once, then follow new ones.
  let next = 0;
  for (let page = 50; page === 50; next += page) page = (await view(provider, o.tender, "get_orders", { from: next, limit: 50 })).length;
  for (;;) {
    try {
      const me = await view(provider, o.tender, "get_firm", { firm_id: o.firmId });
      if (me.status === "Closed") throw new Error(`firm #${o.firmId} is closed: nothing left to run`);
      next += (await view(provider, o.tender, "get_orders", { from: next, limit: 50 })).length;
      const orders: any[] = await view(provider, o.tender, "get_orders", { from: Math.max(0, next - 30), limit: 30 });
      const now = await chainTime(provider);
      for (const ord of orders) {
        if (ord.status !== "Open" || running.has(ord.id)) continue;
        const a = await view(provider, o.tender, "get_auction", { auction_id: ord.auction });
        if (BigInt(a.commit_end) <= now) {
          if (BigInt(a.reveal_end) < now && !a.settled) await call(handle.agentTender, o.tender, "settle", { auction_id: ord.auction }).catch(() => {});
          continue;
        }
        running.add(ord.id);
        swarm
          .runOrder(ord.id)
          .catch((e) => log(`order ${ord.id}: ${(e as Error).message}`))
          .finally(() => running.delete(ord.id));
      }
      if (strategy.managed && Date.now() - lastManaged > 180_000) {
        lastManaged = Date.now();
        await swarm.manage(handle);
      }
      if (Date.now() - lastTick > (config.epoch_secs + 1) * 1000 && (await swarm.tick())) lastTick = Date.now();
    } catch (e) {
      if (String(e).includes("is closed")) throw e;
      log(`loop: ${(e as Error).message}`);
    }
    await sleep(2000);
  }
}
