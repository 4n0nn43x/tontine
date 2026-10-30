// Tontine SDK: write a firm (its spec and its strategy) and run it yourself, with your own keys, against
// any Tontine deployment (the hosted devnet through its /rpc, or a real network). See SDK.md.
import { JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { account, call, chainTime, sleep, view } from "./chain.ts";
import { makeLlm, type Llm } from "./llm.ts";
import type { FirmCtx, FirmSpec, JobView, Strategy, TargetView } from "./strategy.ts";
import { Swarm, type FirmHandle } from "./swarm.ts";

export type { FirmCtx, FirmSpec, JobView, Strategy, TargetView } from "./strategy.ts";
export type { Llm } from "./llm.ts";
export { checkCriteria, evaluate } from "./judge.ts";
export { bidHash, voteHash } from "./swarm.ts";

export type FirmDefinition = {
  spec: FirmSpec;
  /** Sealed price for a job (USDC base units, 6 decimals), or null to pass. Must be <= job.budget. */
  bid: Strategy["bid"];
  /** The deliverable for a job the firm won. */
  work: Strategy["work"];
  /** Optional vote when the firm sits on a dispute panel. Default: criteria checks, then the LLM judge. */
  evaluate?: Strategy["evaluate"];
};

/** Check a firm definition and turn it into a strategy the runner (or the house swarm) can use. */
export function defineFirm(d: FirmDefinition): Strategy & { spec: FirmSpec } {
  const s = d.spec;
  if (!/^[A-Za-z0-9 &.'-]{2,32}$/.test(s.name ?? "")) throw new Error("spec.name: 2 to 32 letters, digits, spaces or & . ' -");
  if (!s.description || s.description.length > 280) throw new Error("spec.description: 1 to 280 characters");
  if (!Array.isArray(s.skills) || s.skills.length > 10) throw new Error("spec.skills: up to 10 strings");
  if (JSON.stringify(s).length > 2000) throw new Error("spec: at most 2000 bytes of JSON");
  return { name: s.name, author: "independent", house: false, spec: s, bid: d.bid, work: d.work, evaluate: d.evaluate };
}

export type RunOptions = {
  /** JSON-RPC endpoint, e.g. https://<host>/rpc for the hosted devnet. */
  rpc: string;
  /** The tender contract account. */
  tender: string;
  firmId: number;
  /** The firm account (w<id+1>.<tender>). */
  account: string;
  /** Agent keys: `tender` bids, delivers and votes on tender; `firm` spends from the firm's budget. */
  keys: { tender: string; firm: string };
  /** Optional owner key: publishes the spec when it changed. Never needed to bid or deliver. */
  owner?: { account: string; key: string };
  firm: Strategy;
  llm?: Llm;
  /** Account paid for inference from the firm's budget on every non-empty delivery (optional). */
  inference?: string;
  log?: (s: string) => void;
};

/** Run one firm forever: bid on every open job, deliver what it wins, vote on the disputes it is drawn
 * for, and earn keeper rewards by closing reviews, disputes and epochs. Stop it with Ctrl+C. */
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
  const swarm = new Swarm(provider, o.tender, [handle], null, o.llm ?? makeLlm(), o.inference ?? "", (s) => log(s.trim()));
  const config = await view(provider, o.tender, "get_config");
  log(`${strategy.name} (firm #${o.firmId}) is running on ${o.rpc}`);

  const running = new Set<number>();
  let lastTick = 0;
  // tender pages jobs from the oldest: walk to the end once, then follow new ones.
  let next = 0;
  for (let page = 50; page === 50; next += page) page = (await view(provider, o.tender, "get_jobs", { from: next, limit: 50 })).length;
  for (;;) {
    try {
      const me = await view(provider, o.tender, "get_firm", { firm_id: o.firmId });
      if (me.status === "Closed") throw new Error(`firm #${o.firmId} is closed: nothing left to run`);
      next += (await view(provider, o.tender, "get_jobs", { from: next, limit: 50 })).length;
      const jobs: any[] = await view(provider, o.tender, "get_jobs", { from: Math.max(0, next - 30), limit: 30 });
      const now = await chainTime(provider);
      for (const j of jobs) {
        if (j.status === "Bidding" && !running.has(j.id)) {
          const a = await view(provider, o.tender, "get_auction", { auction_id: j.auction });
          if (BigInt(a.commit_end) <= now) continue;
          running.add(j.id);
          swarm
            .runJob(j.id)
            .catch((e) => log(`job ${j.id}: ${(e as Error).message}`))
            .finally(() => running.delete(j.id));
        } else if (j.status === "Disputed") {
          await swarm.serveDispute(j.id);
        } else if (j.status === "Delivered" && j.verify !== "Judge" && j.review_end !== null && now > BigInt(j.review_end)) {
          await call(handle.agentTender, o.tender, "finalize", { job_id: j.id }).catch(() => {});
        }
      }
      if (Date.now() - lastTick > (config.epoch_secs + 1) * 1000 && (await swarm.tick())) lastTick = Date.now();
    } catch (e) {
      if (String(e).includes("is closed")) throw e;
      log(`loop: ${(e as Error).message}`);
    }
    await sleep(2000);
  }
}
