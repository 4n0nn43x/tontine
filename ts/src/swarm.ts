// The single swarm process: runs every firm's strategy against the tender contract.
// Firm agents sign with function call keys only (no deposit possible): commit, reveal, deliver, spend.
import { randomBytes, createHash } from "node:crypto";
import type { Account, JsonRpcProvider } from "near-api-js";
import { call, view, waitUntilChainTime, fmt } from "./chain.ts";
import { judge, type Verdict } from "./judge.ts";
import type { Llm } from "./llm.ts";
import { safeBid, type FirmCtx, type JobView, type Strategy } from "./strategy.ts";

export type FirmHandle = {
  id: number;
  account: string;
  owner: Account;
  /** Function call key on the firm account, receiver = tender. */
  agentTender: Account;
  /** Function call key on the firm account, receiver = the firm contract itself. */
  agentFirm: Account;
  strategy: Strategy;
};

/** Inference price per completion paid by the firm from its treasury (USDC base units). */
export const INFERENCE_COST = 50_000n;

export const bidHash = (amount: bigint, salt: string) => createHash("sha256").update(`${amount}:${salt}`).digest("hex");

export class Swarm {
  constructor(
    public provider: JsonRpcProvider,
    public tender: string,
    public firms: FirmHandle[],
    public judgeAccount: Account,
    public llm: Llm,
    public inferenceProvider: string,
    public log: (s: string) => void = console.log,
  ) {}

  firm(id: number) {
    const f = this.firms.find((x) => x.id === id);
    if (!f) throw new Error(`unknown firm ${id}`);
    return f;
  }

  async ctx(f: FirmHandle): Promise<FirmCtx> {
    const v = await view(this.provider, this.tender, "get_firm", { firm_id: f.id });
    const treasury = BigInt(await view(this.provider, this.tender, "balance_of", { account_id: f.account }));
    return { id: f.id, account: f.account, treasury, delivered: v.delivered, rejected: v.rejected };
  }

  async job(id: number): Promise<JobView & { auction: number; status: string }> {
    const j = await view(this.provider, this.tender, "get_job", { job_id: id });
    return { id: j.id, client: j.client, budget: BigInt(j.budget), brief: j.brief, auction: j.auction, status: j.status };
  }

  /** Commit then reveal one sealed bid per willing firm, then settle. Returns the auction after settlement. */
  async auction(auctionId: number, prices: Map<number, bigint>, byOwner: boolean, afterCommit?: () => Promise<void>) {
    const salts = new Map<number, string>();
    await Promise.all(
      [...prices].map(async ([id, price]) => {
        const f = this.firm(id);
        const salt = randomBytes(16).toString("hex");
        salts.set(id, salt);
        try {
          await call(byOwner ? f.owner : f.agentTender, this.tender, "commit_bid", { auction_id: auctionId, firm_id: id, hash: bidHash(price, salt) });
          this.log(`  commit  ${f.strategy.name.padEnd(18)} sealed`);
        } catch (e) {
          salts.delete(id);
          this.log(`  commit  ${f.strategy.name.padEnd(18)} refused: ${(e as Error).message}`);
        }
      }),
    );
    await afterCommit?.();
    const a0 = await view(this.provider, this.tender, "get_auction", { auction_id: auctionId });
    await waitUntilChainTime(this.provider, a0.commit_end);
    await Promise.all(
      [...salts].map(async ([id, salt]) => {
        const f = this.firm(id);
        const amount = prices.get(id)!;
        await call(byOwner ? f.owner : f.agentTender, this.tender, "reveal_bid", { auction_id: auctionId, firm_id: id, amount: amount.toString(), salt });
        this.log(`  reveal  ${f.strategy.name.padEnd(18)} ${fmt(amount)} USDC`);
      }),
    );
    await waitUntilChainTime(this.provider, a0.reveal_end);
    const r = await call(this.firms[0].agentTender, this.tender, "settle", { auction_id: auctionId });
    const a = await view(this.provider, this.tender, "get_auction", { auction_id: auctionId });
    return { ...a, events: r.events, txHash: r.txHash };
  }

  async runJob(jobId: number, afterCommit?: () => Promise<void>) {
    const job = await this.job(jobId);
    this.log(`job #${jobId} "${job.brief}" budget ${fmt(job.budget)} USDC`);
    const prices = new Map<number, bigint>();
    for (const f of this.firms) {
      const p = safeBid(f.strategy, job, await this.ctx(f));
      if (p !== null) prices.set(f.id, p);
    }
    const a = await this.auction(job.auction, prices, false, afterCommit);
    if (a.winner === null) {
      this.log(`  no bids: job cancelled, client refunded`);
      return { auction: a, verdict: null as Verdict | null };
    }
    const w = this.firm(a.winner);
    this.log(`  winner  ${w.strategy.name} paid the second price ${fmt(a.price)} USDC`);
    const verdict = await this.deliverAndJudge(jobId, w, job);
    return { auction: a, verdict };
  }

  async deliverAndJudge(jobId: number, w: FirmHandle, job: JobView): Promise<Verdict> {
    const result = await w.strategy.work(job, this.llm);
    if (result.trim()) {
      // The firm pays its own inference from its treasury, through its on-chain budget.
      await call(w.agentFirm, w.account, "spend", { receiver_id: this.inferenceProvider, amount: INFERENCE_COST.toString(), memo: `inference job ${jobId}` });
    }
    await call(w.agentTender, this.tender, "deliver", { job_id: jobId, result });
    this.log(`  deliver ${w.strategy.name}: ${result ? JSON.stringify(result.slice(0, 60)) + "..." : "(empty)"}`);
    const v = await judge(this.llm, job.brief, result);
    const r = await call(this.judgeAccount, this.tender, "verdict", { job_id: jobId, accept: v.accept, attestation: v.attestation });
    this.log(`  verdict ${v.accept ? "ACCEPTED" : "REJECTED"} (${v.reason})`);
    return { ...v, attestation: r.txHash };
  }

  /** epoch_tick, ignoring "epoch not over". */
  async tick(): Promise<boolean> {
    try {
      await call(this.firms[0].agentTender, this.tender, "epoch_tick");
      return true;
    } catch (e) {
      if (String(e).includes("epoch not over")) return false;
      throw e;
    }
  }

  async runLiquidation(firmId: number) {
    const target = await view(this.provider, this.tender, "get_firm", { firm_id: firmId });
    const t = { id: firmId, account: target.account, delivered: target.delivered, rejected: target.rejected, revenue: BigInt(target.revenue), treasury: BigInt(await view(this.provider, this.tender, "balance_of", { account_id: target.account })) };
    this.log(`liquidation of firm #${firmId} (${this.firm(firmId).strategy.name})`);
    const prices = new Map<number, bigint>();
    for (const f of this.firms) {
      if (f.id === firmId || !f.strategy.takeover) continue;
      try {
        const p = f.strategy.takeover(t, await this.ctx(f));
        if (p && p > 0n) prices.set(f.id, p);
      } catch {}
    }
    return this.auction(target.liquidation_auction, prices, true);
  }
}
