// The single swarm process: runs every firm's strategy against the tender contract.
// Firm agents sign with function call keys only (no deposit possible): commit, reveal, settle, spend.
import { randomBytes, createHash } from "node:crypto";
import type { Account, JsonRpcProvider } from "near-api-js";
import { call, view, waitUntilChainTime } from "./chain.ts";
import type { Llm } from "./llm.ts";
import { RANK, type Point, type Regime } from "./guard.ts";
import { allowsOrder, applyOverlay, compileMandate, evaluateMandate, MAX_TEXT, type Mandate, type MandateRule } from "./mandate.ts";
import { bound, decide, newBandit, rule, type BanditState, type Decision, type Results } from "./manager.ts";
import { DecisionLog, ShadowBook, type ShadowOrder } from "./shadow.ts";
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

/**
 * What a hosted firm pays for each LLM decision of its manager (USDC base units), before the call, from its
 * treasury through its firm contract (`spend`, under its owner's budget): about 3 times the inference cost
 * measured on Qwen3.8-27B (0.00015 USD a decision, 2026-10-31). Rule managers and self-hosted firms pay nothing.
 */
export const INFERENCE_COST = 500n;
/** LLM decisions per UTC day across every hosted firm of every market; past it, managers use the stated rule. */
const LLM_DAILY_CAP = Number(process.env.LLM_DAILY_CAP ?? 1000);
/**
 * Of those, visitors' firms (adopted from /api/agent, their inference paid with faucet USDC) get their own share,
 * VISITOR_LLM_DAILY_CAP, and the house firms the rest: visitors cannot use up the house firms' decisions.
 */
const VISITOR_LLM_DAILY_CAP = Math.min(LLM_DAILY_CAP, Number(process.env.VISITOR_LLM_DAILY_CAP ?? 200));
export const LLM_CAPS = { house: LLM_DAILY_CAP - VISITOR_LLM_DAILY_CAP, visitor: VISITOR_LLM_DAILY_CAP };
/** Today's LLM decisions: one count for every swarm of the process. */
export const llmToday = { day: "", house: 0, visitor: 0 };
/** Manager decisions kept in memory per swarm (the API shows the last 50). */
const MAX_DECISIONS = 500;

/** The sealed-bid commitment, bound to its auction and firm so another firm cannot copy it. */
export const bidHash = (auctionId: number, firmId: number, amount: bigint, salt: string) =>
  createHash("sha256").update(`${auctionId}:${firmId}:${amount}:${salt}`).digest("hex");

/**
 * `llm` until `cap` calls in a UTC day, then not live: its callers fall back to their rule, template or keywords.
 * `capped`: not live only because of the cap.
 */
export function dailyCapped(llm: Llm, cap: number, today = () => new Date().toISOString().slice(0, 10)): Llm & { readonly capped: boolean } {
  let day = "";
  let n = 0;
  const left = () => {
    if (day !== today()) [day, n] = [today(), 0];
    return n < cap;
  };
  return {
    get live() {
      return left() && llm.live;
    },
    get capped() {
      return !left() && llm.live;
    },
    complete(system, user) {
      n++;
      return llm.complete(system, user);
    },
  };
}

/**
 * `llm` whose failures read "LLM unavailable": the provider's error, its body included, goes to `log` only,
 * never to an API answer or the public decision log.
 */
export function quietErrors(llm: Llm, log: (s: string) => void): Llm {
  return {
    get live() {
      return llm.live;
    },
    complete: (system, user) =>
      llm.complete(system, user).catch((e) => {
        log(`llm: ${(e as Error).message}`);
        throw new Error("LLM unavailable");
      }),
  };
}

/** Each house firm's default mandate, in its owner's words. The pattern parser reads every one without an LLM. */
// In every market at least two house firms keep quoting, wider, in a storm (an order needs two bids): the
// market stays open while the cautious firms sit it out.
export const HOUSE_MANDATES: Record<string, string> = {
  "Undercut & Co": "Pause if NEAR drops 4% in an hour. Never hold more than 50% in NEAR.",
  "Cost Plus Ltd": "Pause if cash falls below 1.5 times the floor. Never hold more than 45% in NEAR.",
  "Gambler Inc": "Pause if NEAR crashes 15% in a day.",
  "Premium Partners": "Widen to at least 40 bp in a storm.",
  "Sniper Holdings": "Pause in a storm. Pause if NEAR drops 3% in 30 minutes.",
  "Atlas AI": "Widen to at least 20 bp when the market is volatile. In a storm, keep quoting but widen the spread to at least 35 bp.",
  "Ether Forge": "Pause if ETH drops 4% in an hour. Never hold more than 50% in ETH.",
  "Gaslight & Co": "Never hold more than 50% in ETH. In a storm, keep quoting but widen the spread to at least 35 bp.",
  "Blob Brothers": "Widen to at least 30 bp in a storm.",
  "Sunspot Labs": "Pause if SOL drops 5% in an hour. Never hold more than 50% in SOL.",
  "Lamport Lane": "Never hold more than 50% in SOL. In a storm, keep quoting but widen the spread to at least 35 bp.",
  "Solstice Fund": "Widen to at least 30 bp in a storm.",
};

/**
 * The house response to the market regime, for managed house firms: on alert the spread widens 1.5 times,
 * in a storm the firm stops quoting. The owner's mandate says otherwise with a regime rule of its own: one
 * from "alert" covers both levels, one from "storm" the storm only.
 */
export function regimeRules(own: MandateRule[], p: Params): MandateRule[] {
  const covered = (level: Regime) => own.some((r) => r.when.kind === "regime" && RANK[r.when.atLeast] <= RANK[level]);
  const out: MandateRule[] = [];
  if (!covered("alert")) out.push({ when: { kind: "regime", atLeast: "alert" }, then: { spreadMinBps: Math.min(300, Math.round(p.spreadBps * 1.5)) }, note: "House default: widen the spread 1.5 times on alert" });
  if (!covered("storm")) out.push({ when: { kind: "regime", atLeast: "storm" }, then: { pause: true }, note: "House default: stop quoting in a storm" });
  return out;
}

const noResults = (): Results => ({ quoted: 0, filled: 0, edge: 0n, assetShare: 0, orders: 0 });

/** The asset a swarm's tender trades, for its logs. */
export type AssetLabel = { symbol: string; unit: bigint };
const NEAR_LABEL: AssetLabel = { symbol: "NEAR", unit: 10n ** 24n };

export class Swarm {
  /** Current params per firm, and what each did since its manager's last decision. */
  params = new Map<number, Params>();
  results = new Map<number, Results>();
  decisions: Decision[] = [];
  // The AI layer, optional: the server sets the regime and the mid history, and compiles the mandates.
  regime: Regime = "calm";
  /** Recent mids of the asset, sorted by t: what a mandate's price moves are measured on. */
  series: Point[] = [];
  mandates = new Map<number, Mandate>();
  /** Managed firms' shadow quotes: their actual bid against the stated rule and the fixed starting params. */
  shadow = new ShadowBook();
  /** Every manager decision, hash-chained, with the LLM's signature when it has one. */
  decisionLog = new DecisionLog();
  /** Orders each firm sat out in a storm because its mandate paused it. */
  weathered = new Map<number, number>();
  /** The rule arm of the shadow quotes: its params, and its counterfactual results since the last decision. */
  private ruleArms = new Map<number, { params: Params; results: Results }>();
  /** The tender's config, as of the last market() read. */
  private cfg: any = null;

  constructor(
    public provider: JsonRpcProvider,
    public tender: string,
    public firms: FirmHandle[],
    public llm: Llm,
    public inferenceProvider: string,
    /** Reference mid (USDC per unit of the asset) when quoting. */
    public mid: () => Promise<number>,
    public log: (s: string) => void = console.log,
    public asset: AssetLabel = NEAR_LABEL,
  ) {}

  /** What an order delivers: the asset for a buy, USDC for a sell. */
  private fmt(v: bigint, side: "Buy" | "Sell") {
    return side === "Buy" ? `${(Number(v) / Number(this.asset.unit)).toFixed(4)} ${this.asset.symbol}` : `${(Number(v) / 1e6).toFixed(2)} USDC`;
  }

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
    this.cfg = cfg;
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
          await call(byOwner ? f.owner : f.agentTender, this.tender, "commit_bid", { auction_id: auctionId, firm_id: id, hash: bidHash(auctionId, id, price, salt) });
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
    const r = await this.keeper("settle", { auction_id: auctionId }).catch((e) => {
      if (!String(e).includes("already settled")) throw e;
      return null;
    });
    const a = await view(this.provider, this.tender, "get_auction", { auction_id: auctionId });
    return { ...a, events: r?.events ?? [], txHash: r?.txHash ?? "" };
  }

  private ruleArm(f: FirmHandle) {
    if (!this.ruleArms.has(f.id)) this.ruleArms.set(f.id, { params: { ...f.strategy.params }, results: noResults() });
    return this.ruleArms.get(f.id)!;
  }

  /** A firm's rules: its owner's mandate, then the house regime response if it is a managed house firm. */
  rulesOf(f: FirmHandle): MandateRule[] {
    const own = this.mandates.get(f.id)?.rules ?? [];
    return f.strategy.house && f.strategy.managed ? [...own, ...regimeRules(own, this.paramsOf(f))] : own;
  }

  /** The firm's rules against the market now (mid in USDC per asset unit): which hold (indexes), and their overlay. */
  mandateNow(f: FirmHandle, me: FirmCtx, mid: number) {
    const rules = this.rulesOf(f);
    const asset = (Number(me.asset) / Number(this.asset.unit)) * mid;
    const cash = Number(me.stable) / 1e6;
    const floor = Number(this.cfg?.treasury_floor ?? 0) / 1e6;
    const { active, overlay } = evaluateMandate({ rules } as Mandate, { series: this.series, assetShare: asset / (asset + cash || 1), cashToFloor: floor > 0 ? cash / floor : Infinity, regime: this.regime });
    return { rules, active: active.map((r) => rules.indexOf(r)), overlay };
  }

  private compiling = new Map<number, { text: string; p: Promise<Mandate> }>();
  /** Firms whose mandate the pattern parser compiled only because the LLM was over its daily cap. */
  private underCap = new Set<number>();

  /**
   * Compiles a firm's mandate once per change of its text, and logs it; concurrent calls with the same text
   * share one compile. One the pattern parser compiled only because `llm` was over its daily cap compiles
   * again on the next call with the LLM live.
   */
  setMandate(llm: Llm & { capped?: boolean }, f: FirmHandle, text: string): Promise<Mandate> {
    const t = text.trim().slice(0, MAX_TEXT);
    const cur = this.mandates.get(f.id);
    if (cur && cur.text === t && !(this.underCap.has(f.id) && llm.live)) return Promise.resolve(cur);
    const busy = this.compiling.get(f.id);
    if (busy?.text === t) return busy.p;
    const capped = llm.capped === true;
    const p: Promise<Mandate> = compileMandate(llm, t)
      .then((md) => {
        this.mandates.set(f.id, md);
        if (capped) this.underCap.add(f.id);
        else this.underCap.delete(f.id);
        const { signature, ...record } = md;
        this.decisionLog.append({ kind: "mandate", market: this.asset.symbol, firmId: f.id, ...record }, signature ?? null);
        this.log(`mandate ${f.strategy.name}: ${md.rules.length} rule(s) (${md.source}${capped ? ", LLM over its daily cap" : ""})${md.dropped.length ? `, dropped: ${md.dropped.join("; ")}` : ""}`);
        return md;
      })
      .finally(() => {
        if (this.compiling.get(f.id)?.p === p) this.compiling.delete(f.id);
      });
    this.compiling.set(f.id, { text: t, p });
    return p;
  }

  /** Replays the auction for each shadow order against every revealed bid; the rule arm's results feed its next decision. */
  private settleShadows(auction: number, bids: { firm_id: number; revealed: string | null }[], shadows: ShadowOrder[]) {
    if (!shadows.length) return;
    shadows.forEach((s) => this.shadow.record(s));
    const revealed = bids.filter((b) => b.revealed !== null).map((b) => ({ firmId: b.firm_id, amount: BigInt(b.revealed!) }));
    for (const { firmId, outcomes } of this.shadow.settle(auction, revealed)) {
      const r = this.ruleArms.get(firmId)!.results;
      r.orders = (r.orders ?? 0) + 1;
      if (shadows.find((s) => s.firmId === firmId)!.bids.rule !== null) r.quoted++;
      if (outcomes.rule.won) r.filled++;
      r.edge += outcomes.rule.edge;
    }
  }

  /** Every firm quotes the order (keeping only bids the contract would accept), then the auction runs. */
  async runOrder(orderId: number, afterCommit?: () => Promise<void>) {
    const o = await this.order(orderId);
    // Bands are checked against the price when the order was posted, not the latest fill.
    const market = { ...(await this.market()), last: await this.anchor(orderId) };
    this.log(`order #${orderId} ${o.side} ${this.fmt(o.amountIn, o.side === "Buy" ? "Sell" : "Buy")}, at least ${this.fmt(o.minOut, o.side)}`);
    const prices = new Map<number, bigint>();
    const usd = o.side === "Buy" ? Number(o.amountIn) / 1e6 : (Number(o.amountIn) / Number(market.unit)) * market.mid;
    const shadows: ShadowOrder[] = [];
    for (const f of this.firms) {
      const me = await this.ctx(f);
      // Only a solvent firm may commit; the contract refuses the others.
      if (me.status !== "Solvent" || f.owner.accountId === o.client) continue;
      // Its mandate (and the house regime response) may keep it out, or tighten the params it quotes with.
      const { overlay } = this.mandateNow(f, me, market.mid);
      if (!allowsOrder(overlay, usd)) {
        if (overlay.pause && this.regime === "storm") this.weathered.set(f.id, (this.weathered.get(f.id) ?? 0) + 1);
        this.log(`  pass    ${f.strategy.name.padEnd(18)} ${overlay.pause ? "paused" : "over its order cap"} by its mandate (${this.regime})`);
        continue;
      }
      const quote = (p: Params) => safeQuote(f.strategy, o, me, market, applyOverlay(p, overlay));
      const v = quote(this.paramsOf(f));
      // What the stated rule and the fixed starting params would have bid, under the same mandate.
      if (f.strategy.managed) {
        const bids = { actual: v, rule: quote(this.ruleArm(f).params), fixed: quote(f.strategy.params) };
        shadows.push({ auction: o.auction, firmId: f.id, side: o.side, amountIn: o.amountIn, reserve: o.minOut, feeBps: this.cfg?.order_fee_bps ?? 0, ref: BigInt(Math.round(market.mid * 1e6)), unit: market.unit, bids });
      }
      const r = this.results.get(f.id) ?? { quoted: 0, filled: 0, edge: 0n, assetShare: 0 };
      // Orders the firm could have quoted: the bandit's reward is its edge per order offered.
      r.orders = (r.orders ?? 0) + 1;
      if (v !== null) {
        prices.set(f.id, v);
        r.quoted++;
      }
      this.results.set(f.id, r);
    }
    const a = await this.auction(o.auction, prices, false, afterCommit, (v) => this.fmt(v, o.side));
    this.settleShadows(o.auction, a.bids, shadows);
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
    this.log(`  filled  ${w?.strategy.name ?? `firm #${a.winner}`} delivers ${this.fmt(BigInt(a.price), o.side)} (second best), client gets ${this.fmt(BigInt(after.out), o.side)}, edge ${(Number(filled?.edge ?? 0) / 1e6).toFixed(4)} USDC`);
    return { auction: a, order: after };
  }

  /**
   * A managed firm's manager reviews its results and retunes its params. With the LLM, the firm pays the
   * inference from its treasury through its own contract (`spend`, under its budget), and the decision is kept
   * as a receipt.
   */
  private bandits = new Map<number, BanditState>();

  /** The LLM for this decision, or null for the rule: a live LLM, under the daily cap of house or visitor firms, once the firm has paid. */
  private async paidLlm(f: FirmHandle): Promise<Llm | null> {
    if (f.strategy.managed !== true || !this.llm.live) return null;
    const kind = f.strategy.house ? "house" : "visitor";
    const day = new Date().toISOString().slice(0, 10);
    if (llmToday.day !== day) Object.assign(llmToday, { day, house: 0, visitor: 0 });
    if (llmToday[kind] >= LLM_CAPS[kind]) return null;
    if (this.inferenceProvider) {
      const paid = await call(f.agentFirm, f.account, "spend", { receiver_id: this.inferenceProvider, amount: INFERENCE_COST.toString(), memo: "manager decision" }).then(
        (r) => r.value === true,
        () => false,
      );
      if (!paid) {
        this.log(`  manager ${f.strategy.name}: inference not paid (budget or cash), the rule decides`);
        return null;
      }
    }
    llmToday[kind]++;
    return this.llm;
  }

  async manage(f: FirmHandle): Promise<Decision> {
    const me = await this.ctx(f);
    const market = await this.market();
    const assetValue = (me.asset * BigInt(Math.round(market.mid * 1e6))) / market.unit;
    const r = { ...(this.results.get(f.id) ?? { quoted: 0, filled: 0, edge: 0n, assetShare: 0 }), assetShare: Number(assetValue) / Number(me.stable + assetValue || 1n) };
    const llm = await this.paidLlm(f);
    // A bandit firm keeps its arm statistics across decisions; it never calls (or pays for) an LLM.
    const bandit = f.strategy.managed === "bandit" ? (this.bandits.get(f.id) ?? this.bandits.set(f.id, newBandit()).get(f.id)) : undefined;
    const decideWith = (m: Llm | null) => decide(m, f.strategy.name, this.paramsOf(f), r, me.policy.max_asset_bps / 10_000, bandit);
    // A failed or unreadable LLM answer is not retried: the rule decides this time.
    const d = await decideWith(llm).catch(() => decideWith(null));
    this.params.set(f.id, d.after);
    this.results.set(f.id, { quoted: 0, filled: 0, edge: 0n, assetShare: r.assetShare, orders: 0 });
    this.decisions.push(d);
    if (this.decisions.length > MAX_DECISIONS) this.decisions.splice(0, this.decisions.length - MAX_DECISIONS);
    const { signature, ...record } = d;
    this.decisionLog.append({ kind: "manager", market: this.asset.symbol, firmId: f.id, ...record }, signature ?? null, d.at);
    // The shadow rule arm decides too, from its own counterfactual results.
    const arm = this.ruleArm(f);
    arm.params = bound(rule(arm.params, arm.results).params, arm.params, me.policy.max_asset_bps / 10_000);
    arm.results = noResults();
    this.log(`  manager ${f.strategy.name} (${d.source}): spread ${d.before.spreadBps} -> ${d.after.spreadBps} bp, ${d.reason}`);
    return d;
  }

  /**
   * A call anyone may send (settle, epoch_tick), from the first firm's agent that can sign it: one out of gas,
   * or whose keys a takeover deleted, passes to the next. The contract's own refusal is the answer, not retried.
   */
  async keeper(method: string, args: Record<string, unknown> = {}) {
    let last: unknown = new Error("no firm");
    for (const f of this.firms) {
      try {
        return await call(f.agentTender, this.tender, method, args);
      } catch (e) {
        if (String((e as Error).message).startsWith(`${method}: `)) throw e;
        last = e;
      }
    }
    throw last;
  }

  /** epoch_tick, ignoring "epoch not over". */
  async tick(): Promise<boolean> {
    try {
      await this.keeper("epoch_tick");
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
