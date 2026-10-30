// The single swarm process: runs every firm's strategy against the tender contract.
// Firm agents sign with function call keys only (no deposit possible): commit, reveal, deliver, spend.
import { randomBytes, createHash } from "node:crypto";
import type { Account, JsonRpcProvider } from "near-api-js";
import { call, chainTime, view, waitUntilChainTime, fmt } from "./chain.ts";
import { evaluate, judge, type Verdict } from "./judge.ts";
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
/** Sealed vote of an evaluator, as `tender.vote_hash`: 1 accepts the delivery, 0 rejects it. */
export const voteHash = (accept: boolean, salt: string) => createHash("sha256").update(`${accept ? 1 : 0}:${salt}`).digest("hex");

export class Swarm {
  constructor(
    public provider: JsonRpcProvider,
    public tender: string,
    public firms: FirmHandle[],
    /** The oracle account for judge-mode jobs; null for an agent that only runs its own firm. */
    public judgeAccount: Account | null,
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
    return { id: f.id, account: f.account, treasury, delivered: v.delivered, rejected: v.rejected, status: v.status };
  }

  async job(id: number): Promise<JobView & { auction: number; status: string; criteria: string; judged: boolean }> {
    const j = await view(this.provider, this.tender, "get_job", { job_id: id });
    // `verify` is "Judge" or {"Optimistic": {...}}: only judge-mode jobs get an oracle verdict.
    return { id: j.id, client: j.client, budget: BigInt(j.budget), brief: j.brief, auction: j.auction, status: j.status, criteria: j.criteria ?? "", judged: j.verify === "Judge" };
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
    // Several agents race to settle (and earn the keeper reward): losing that race is fine.
    const r = await call(this.firms[0].agentTender, this.tender, "settle", { auction_id: auctionId }).catch((e) => {
      if (!String(e).includes("already settled")) throw e;
      return null;
    });
    const a = await view(this.provider, this.tender, "get_auction", { auction_id: auctionId });
    return { ...a, events: r?.events ?? [], txHash: r?.txHash ?? "" };
  }

  async runJob(jobId: number, afterCommit?: () => Promise<void>) {
    const job = await this.job(jobId);
    this.log(`job #${jobId} "${job.brief}" budget ${fmt(job.budget)} USDC`);
    const prices = new Map<number, bigint>();
    for (const f of this.firms) {
      const me = await this.ctx(f);
      if (me.status === "Closed" || me.status === "Liquidating") continue;
      const p = safeBid(f.strategy, job, me);
      if (p !== null) prices.set(f.id, p);
    }
    const a = await this.auction(job.auction, prices, false, afterCommit);
    if (a.winner === null) {
      this.log(`  no bids: job cancelled, client refunded`);
      return { auction: a, verdict: null as Verdict | null };
    }
    const w = this.firms.find((x) => x.id === a.winner);
    if (!w) {
      this.log(`  winner  firm #${a.winner}, run by another agent`);
      return { auction: a, verdict: null as Verdict | null };
    }
    this.log(`  winner  ${w.strategy.name} paid the second price ${fmt(a.price)} USDC`);
    const verdict = await this.deliverAndJudge(jobId, w, job);
    return { auction: a, verdict };
  }

  async deliverAndJudge(jobId: number, w: FirmHandle, job: JobView): Promise<Verdict | null> {
    const result = await w.strategy.work(job, this.llm);
    if (result.trim() && this.inferenceProvider) {
      // The firm pays its own inference from its treasury, through its on-chain budget.
      await call(w.agentFirm, w.account, "spend", { receiver_id: this.inferenceProvider, amount: INFERENCE_COST.toString(), memo: `inference job ${jobId}` });
    }
    await call(w.agentTender, this.tender, "deliver", { job_id: jobId, result });
    this.log(`  deliver ${w.strategy.name}: ${result ? JSON.stringify(result.slice(0, 60)) + "..." : "(empty)"}`);
    // Optimistic jobs: the client reviews, and a dispute goes to a panel of firms (serveDispute).
    if (!(await this.job(jobId)).judged || !this.judgeAccount) return null;
    const v = await judge(this.llm, job.brief, result);
    const r = await call(this.judgeAccount, this.tender, "verdict", { job_id: jobId, accept: v.accept, attestation: v.attestation });
    this.log(`  verdict ${v.accept ? "ACCEPTED" : "REJECTED"} (${v.reason})`);
    return { ...v, attestation: r.txHash };
  }

  private ballots = new Map<string, { accept: boolean; salt: string }>(); // `${job}:${firm}`

  /** Evaluator duty for one disputed job: our firms on the panel vote (sealed, then revealed), and the
   * dispute is closed once the votes are in. Call it repeatedly; each call does what the phase allows. */
  async serveDispute(jobId: number) {
    const d = await view(this.provider, this.tender, "get_dispute", { job_id: jobId });
    if (!d || d.resolved || !d.panel.length) return;
    const now = await chainTime(this.provider);
    for (const b of d.panel) {
      const f = this.firms.find((x) => x.id === b.firm_id);
      if (!f) continue;
      const key = `${jobId}:${f.id}`;
      if (now < BigInt(d.commit_end) && !b.hash && !this.ballots.has(key)) {
        const j = await this.job(jobId);
        const raw = await view(this.provider, this.tender, "get_job", { job_id: jobId });
        const result: string = raw.result ?? "";
        const accept = f.strategy.evaluate ? await f.strategy.evaluate(j, result, this.llm) : (await evaluate(this.llm, j.brief, j.criteria, result)).accept;
        const salt = randomBytes(16).toString("hex");
        this.ballots.set(key, { accept, salt });
        const args = { job_id: jobId, firm_id: f.id, hash: voteHash(accept, salt) };
        // After a takeover the old agent keys are gone: the owner votes itself until it adds new ones.
        try {
          await call(f.agentTender, this.tender, "commit_vote", args).catch(() => call(f.owner, this.tender, "commit_vote", args));
          this.log(`  vote    ${f.strategy.name.padEnd(18)} sealed on job #${jobId}`);
        } catch (e) {
          this.log(`  vote    ${f.strategy.name.padEnd(18)} refused: ${(e as Error).message}`);
        }
      } else if (now >= BigInt(d.commit_end) && now < BigInt(d.reveal_end) && b.vote === null && this.ballots.has(key)) {
        const { accept, salt } = this.ballots.get(key)!;
        const args = { job_id: jobId, firm_id: f.id, accept, salt };
        await call(f.agentTender, this.tender, "reveal_vote", args).catch(() => call(f.owner, this.tender, "reveal_vote", args)).catch(() => {});
        this.log(`  vote    ${f.strategy.name.padEnd(18)} ${accept ? "accepts" : "rejects"} job #${jobId}`);
      }
    }
    if (now >= BigInt(d.reveal_end)) {
      await call(this.firms[0].agentTender, this.tender, "resolve_dispute", { job_id: jobId }).catch(() => {});
    }
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
