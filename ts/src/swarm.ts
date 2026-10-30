// The single swarm process: runs every firm's strategy against the tender contract.
// Firm agents sign with function call keys only (no deposit possible): commit, reveal, settle, spend.
import { randomBytes, createHash } from "node:crypto";
import type { Account, JsonRpcProvider } from "near-api-js";
import { call, view, waitUntilChainTime } from "./chain.ts";
import type { Llm } from "./llm.ts";
import { decide, type Decision, type Results } from "./manager.ts";
import { owedOf, safeQuote, type FirmCtx, type Market, type OrderView, type Params, type Strategy } from "./strategy.ts";

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

/** Inference price per manager decision, paid by the firm from its treasury (USDC base units). */
export const INFERENCE_COST = 50_000n;

export const bidHash = (amount: bigint, salt: string) => createHash("sha256").update(`${amount}:${salt}`).digest("hex");

const fmtAsset = (v: bigint, side: "Buy" | "Sell") => (side === "Buy" ? `${(Number(v) / 1e24).toFixed(4)} NEAR` : `${(Number(v) / 1e6).toFixed(2)} USDC`);

export class Swarm {
  /** Current params per firm, and what each did since its manager's last decision. */
  params = new Map<number, Params>();
  results = new Map<number, Results>();
  decisions: Decision[] = [];

  constructor(
    public provider: JsonRpcProvider,
    public tender: string,
    public firms: FirmHandle[],
    public llm: Llm,
    public inferenceProvider: string,
    /** Reference mid (USDC per NEAR) when quoting. */
    public mid: () => Promise<number>,
    public log: (s: string) => void = console.log,
  ) {}

  firm(id: number) {
    const f = this.firms.find((x) => x.id === id);
    if (!f) throw new Error(`unknown firm ${id}`);
    return f;
  }

  paramsOf(f: FirmHandle): Params {
    if (!this.params.has(f.id)) this.params.set(f.id, { ...f.strategy.params });
    return this.params.get(f.id)!;
  }

  async ctx(f: FirmHandle): Promise<FirmCtx> {
    const v = await view(this.provider, this.tender, "get_firm", { firm_id: f.id });
    const [stable, asset] = await Promise.all([
      view(this.provider, this.tender, "balance_of", { account_id: f.account }),
      view(this.provider, this.tender, "asset_balance_of", { account_id: f.account }),
    ]);
    return { id: f.id, account: f.account, stable: BigInt(stable), asset: BigInt(asset), fills: v.fills, edge: BigInt(v.edge), status: v.status, policy: v.policy, owed: owedOf(v.debts) };
  }

  async market(): Promise<Market> {
    const [mid, last, cfg] = await Promise.all([this.mid(), view(this.provider, this.tender, "get_last_price"), view(this.provider, this.tender, "get_config")]);
    return { mid, last: BigInt(last), unit: BigInt(cfg.asset_unit) };
  }

  /** The band anchor of an order: the reference price when it was posted. */
  async anchor(orderId: number): Promise<bigint> {
    return BigInt((await view(this.provider, this.tender, "get_order", { order_id: orderId })).price);
  }

  async order(id: number): Promise<OrderView & { auction: number; status: string }> {
    const o = await view(this.provider, this.tender, "get_order", { order_id: id });
    return { id: o.id, client: o.client, side: o.side, amountIn: BigInt(o.amount_in), minOut: BigInt(o.min_out), referenceOut: o.reference_out ? BigInt(o.reference_out) : null, auction: o.auction, status: o.status };
  }

  /** Commit then reveal one sealed bid per willing firm, then settle. Returns the auction after settlement. */
  async auction(auctionId: number, prices: Map<number, bigint>, byOwner: boolean, afterCommit?: () => Promise<void>, label = (v: bigint) => v.toString()) {
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
        try {
          await call(byOwner ? f.owner : f.agentTender, this.tender, "reveal_bid", { auction_id: auctionId, firm_id: id, amount: amount.toString(), salt });
          this.log(`  reveal  ${f.strategy.name.padEnd(18)} ${label(amount)}`);
        } catch (e) {
          this.log(`  reveal  ${f.strategy.name.padEnd(18)} refused: ${(e as Error).message}`);
        }
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

  /** Every firm quotes the order (keeping only bids the contract would accept), then the auction runs. */
  async runOrder(orderId: number, afterCommit?: () => Promise<void>) {
    const o = await this.order(orderId);
    // Bands are checked against the price when the order was posted, not the latest fill.
    const market = { ...(await this.market()), last: await this.anchor(orderId) };
    this.log(`order #${orderId} ${o.side} ${fmtAsset(o.amountIn, o.side === "Buy" ? "Sell" : "Buy")}, at least ${fmtAsset(o.minOut, o.side)}`);
    const prices = new Map<number, bigint>();
    for (const f of this.firms) {
      const me = await this.ctx(f);
      // Only a solvent firm may commit; the contract refuses the others.
      if (me.status !== "Solvent" || f.owner.accountId === o.client) continue;
      const v = safeQuote(f.strategy, o, me, market, this.paramsOf(f));
      const r = this.results.get(f.id) ?? { quoted: 0, filled: 0, edge: 0n, assetShare: 0 };
      if (v !== null) {
        prices.set(f.id, v);
        r.quoted++;
      }
      this.results.set(f.id, r);
    }
    const a = await this.auction(o.auction, prices, false, afterCommit, (v) => fmtAsset(v, o.side));
    const after = await view(this.provider, this.tender, "get_order", { order_id: orderId });
    if (after.status !== "Filled") {
      this.log(`  no fill: order refunded`);
      return { auction: a, order: after };
    }
    const w = this.firms.find((x) => x.id === a.winner);
    const filled = a.events.find((e: any) => e.event === "order_filled")?.data?.[0];
    if (w) {
      const r = this.results.get(w.id)!;
      r.filled++;
      r.edge += BigInt(filled?.edge ?? 0);
    }
    this.log(`  filled  ${w?.strategy.name ?? `firm #${a.winner}`} delivers ${fmtAsset(BigInt(after.out), o.side)} (second best), edge ${(Number(filled?.edge ?? 0) / 1e6).toFixed(4)} USDC`);
    return { auction: a, order: after };
  }

  /**
   * A managed firm's manager reviews its results and retunes its params. The firm pays the inference from
   * its treasury through its own contract (`spend`, under its budget), and the decision is kept as a receipt.
   */
  async manage(f: FirmHandle): Promise<Decision> {
    const me = await this.ctx(f);
    const market = await this.market();
    const assetValue = (me.asset * BigInt(Math.round(market.mid * 1e6))) / market.unit;
    const r = { ...(this.results.get(f.id) ?? { quoted: 0, filled: 0, edge: 0n, assetShare: 0 }), assetShare: Number(assetValue) / Number(me.stable + assetValue || 1n) };
    const d = await decide(this.llm, f.strategy.name, this.paramsOf(f), r, me.policy.max_asset_bps / 10_000);
    if (d.source === "near-ai-cloud" && this.inferenceProvider) {
      await call(f.agentFirm, f.account, "spend", { receiver_id: this.inferenceProvider, amount: INFERENCE_COST.toString(), memo: `manager decision ${d.chatId ?? ""}` }).catch((e) =>
        this.log(`  manager ${f.strategy.name}: inference not paid (${(e as Error).message})`),
      );
    }
    this.params.set(f.id, d.after);
    this.results.set(f.id, { quoted: 0, filled: 0, edge: 0n, assetShare: r.assetShare });
    this.decisions.push(d);
    this.log(`  manager ${f.strategy.name} (${d.source}): spread ${d.before.spreadBps} -> ${d.after.spreadBps} bp, ${d.reason}`);
    return d;
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
    const a0 = await view(this.provider, this.tender, "get_auction", { auction_id: target.liquidation_auction });
    const [stable, asset] = await Promise.all([
      view(this.provider, this.tender, "balance_of", { account_id: target.account }),
      view(this.provider, this.tender, "asset_balance_of", { account_id: target.account }),
    ]);
    const t = { id: firmId, account: target.account, fills: target.fills, edge: BigInt(target.edge), stable: BigInt(stable), asset: BigInt(asset), reserve: BigInt(a0.reserve) };
    this.log(`liquidation of firm #${firmId} (${this.firms.find((f) => f.id === firmId)?.strategy.name ?? target.account}), reserve ${(Number(t.reserve) / 1e6).toFixed(2)} USDC`);
    const prices = new Map<number, bigint>();
    for (const f of this.firms) {
      if (f.id === firmId || !f.strategy.takeover) continue;
      try {
        const me = await this.ctx(f);
        const p = f.strategy.takeover(t, me);
        if (p && p >= t.reserve && p <= me.stable && me.status !== "Liquidating" && me.status !== "Closed") prices.set(f.id, p);
      } catch {}
    }
    return this.auction(target.liquidation_auction, prices, true, undefined, (v) => `${(Number(v) / 1e6).toFixed(2)} USDC`);
  }
}
