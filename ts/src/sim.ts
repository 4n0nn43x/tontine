// `make sim SEED=1`: the swarm's market off chain, with the contract's rules (rules.ts) and the swarm's own
// quoting (strategy.ts), on NEAR's real price path (fixtures/near-usd-5m.json). No LLM: managed firms, the AI
// one included, use the manager's stated rule. Same seed, same result.
//
//   SEED=1 CLIENTS=20 EXTRA_FIRMS=6 DAYS=7 ORDERS_PER_HOUR=12 npx tsx src/sim.ts [--json]
import { pathToFileURL } from "node:url";
import { clear, edge as edgeOf, BPS } from "./rules.ts";
import { CLIENT_TOLERANCE_BPS, NEAR_UNIT, outAt, replayPrices, toBase } from "./prices.ts";
import { loadStrategies, safeQuote, type FirmCtx, type OrderView, type Params, type Strategy } from "./strategy.ts";
import { decide, newBandit, type BanditState, type Results } from "./manager.ts";
import { makeLlm, type Llm } from "./llm.ts";

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const NEAR = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Who retunes a firm's params each hour. "llm" is makeLlm(): the rule decides when no key is set. */
export type Manager = "fixed" | "rule" | "bandit" | "llm";

type Firm = FirmCtx & {
  name: string; strategy: Strategy; params: Params; dividends: bigint; below: number; volume: bigint; results: Results; manager: Manager; bandit: BanditState;
  start: { stable: bigint; asset: bigint }; quoted: number; llmDecisions: number; peak: number; drawdown: number;
};

/**
 * `managed: false` freezes the AI-managed firm's params (the ablation); rule-managed firms still adapt.
 * `managerFor` picks a firm's manager by name (undefined: from its strategy, the AI one on the rule).
 * `series` replaces the replayed 5-minute closes; `offset` starts the window at that bar (default: the last `days`).
 */
export type SimOptions = {
  seed: number; clients: number; extraFirms: number; days: number; ordersPerHour: number; managed?: boolean;
  managerFor?: (firm: string) => Manager | undefined; offset?: number; series?: { start_ms: number; prices: number[] };
};

export async function simulate(o: SimOptions) {
  const rand = rng(o.seed);
  const series = o.series ?? replayPrices();
  const fx = series.prices;
  const bars = Math.min(fx.length - (o.offset ?? 0), o.days * 288);
  const from = o.offset ?? fx.length - bars;
  const floor = USDC(40);
  const feeBps = 2;
  const maxMove = 300n;
  const house = await loadStrategies();
  // The house firms, then extra makers with seeded spreads and inventory targets.
  const strategies: Strategy[] = [
    ...house,
    ...Array.from({ length: o.extraFirms }, (_, i) => ({
      name: `Maker ${i + 1}`,
      author: "sim",
      house: false,
      params: { spreadBps: 5 + Math.round(rand() * 35), targetAssetShare: 0.2 + rand() * 0.4, skewBps: Math.round(rand() * 40) },
    })),
  ];
  const firms: Firm[] = strategies.map((s, id) => {
    const gambler = s.name === "Gambler Inc";
    const stable = gambler ? USDC(60) : USDC(400);
    const asset = gambler ? NEAR(2) : NEAR(60);
    const manager = o.managerFor?.(s.name) ?? (!s.managed || (s.managed === true && o.managed === false) ? "fixed" : s.managed === "bandit" ? "bandit" : "rule");
    return {
      id, account: `w${id + 1}`, name: s.name, strategy: s, params: { ...s.params }, stable, asset, fills: 0, edge: 0n, status: "Solvent",
      policy: { max_asset_bps: gambler ? 10000 : 8000, band_bps: 1000, paused: false },
      dividends: 0n, below: 0, volume: 0n, results: { quoted: 0, filled: 0, orders: 0, edge: 0n, assetShare: 0 }, manager, bandit: newBandit(), start: { stable, asset },
      quoted: 0, llmDecisions: 0, peak: 0, drawdown: 0,
    };
  });
  const llm: Llm | null = firms.some((f) => f.manager === "llm") ? makeLlm() : null;
  let last = toBase(fx[from]);
  let anchor = last;
  const totals = { orders: 0, fills: 0, refunded: 0, improvement: 0, volume: 0n, liquidations: 0, takeovers: 0 };
  const events: string[] = [];

  for (let i = from; i < from + bars; i++) {
    const mid = fx[i];
    // Poisson-ish arrivals: each 5-minute bar gets ordersPerHour / 12 on average.
    let n = 0;
    for (let k = 0; k < 4; k++) if (rand() < o.ordersPerHour / 12 / 4) n++;
    for (let k = 0; k < n; k++) {
      totals.orders++;
      const side = rand() < 0.5 ? "Buy" : "Sell";
      const amountIn = side === "Buy" ? USDC(10 + Math.round(rand() * 190)) : NEAR(2 + Math.round(rand() * 38));
      // The client's minimum: the market reference (mid less the client tolerance).
      const minOut = outAt(side, amountIn, mid, CLIENT_TOLERANCE_BPS);
      const order: OrderView = { id: totals.orders, client: `c${Math.floor(rand() * o.clients)}`, side, amountIn, minOut, referenceOut: minOut };
      const market = { mid, last, unit: NEAR_UNIT };
      const bids: bigint[] = [];
      const who: Firm[] = [];
      for (const f of firms) {
        if (f.status !== "Solvent") continue;
        f.results.orders!++;
        const v = safeQuote(f.strategy, order, f, market, f.params);
        if (v === null) continue;
        f.results.quoted++;
        f.quoted++;
        bids.push(v);
        who.push(f);
      }
      const r = bids.length >= 2 ? clear(bids, minOut) : null;
      if (!r) {
        totals.refunded++;
        continue;
      }
      const w = who[r.winner];
      const out = r.out;
      const fee = (amountIn * BigInt(feeBps)) / BPS;
      const e = edgeOf(side, amountIn, out, feeBps, last, NEAR_UNIT);
      if (side === "Buy") {
        w.stable += amountIn - fee;
        w.asset -= out;
      } else {
        w.asset += amountIn - fee;
        w.stable -= out;
      }
      if (e > 0n) {
        const div = ((e * 3000n) / BPS) < w.stable ? (e * 3000n) / BPS : w.stable;
        w.stable -= div;
        w.dividends += div;
      }
      w.edge += e;
      w.fills++;
      w.results.filled++;
      w.results.edge += e;
      const notional = side === "Buy" ? amountIn : out;
      w.volume += notional;
      totals.volume += notional;
      totals.fills++;
      totals.improvement += (Number(out - minOut) / Number(minOut)) * 1e4;
      const price = side === "Buy" ? (amountIn * NEAR_UNIT) / out : (out * NEAR_UNIT) / amountIn;
      // As the contract: at most maxMove in total per hour, from the price the hour opened at.
      const lo = (anchor * (BPS - maxMove)) / BPS;
      const hi = (anchor * (BPS + maxMove)) / BPS;
      last = price < lo ? lo : price > hi ? hi : price;
    }
    // Hourly: epochs (cash floor, liquidations), the managers and a new price window.
    if ((i - from) % 12 === 11) {
      anchor = last;
      // Drawdown of P&L against holding, sampled hourly at the mid.
      for (const f of firms) {
        const pnl = Number(f.stable + f.dividends - f.start.stable + ((f.asset - f.start.asset) * toBase(mid)) / NEAR_UNIT) / 1e6;
        f.peak = Math.max(f.peak, pnl);
        f.drawdown = Math.max(f.drawdown, f.peak - pnl);
      }
      for (const f of firms.filter((x) => x.status === "Solvent" || x.status === "Illiquid")) {
        if (f.stable < floor) {
          f.below++;
          f.status = f.below >= 3 ? "Liquidating" : "Illiquid";
        } else {
          f.below = 0;
          f.status = "Solvent";
        }
        if (f.status !== "Liquidating") continue;
        totals.liquidations++;
        // Its cash and NEAR go to its shareholders; the best takeover bid buys the firm and closes it.
        const buyers = firms
          .filter((b) => b !== f && b.status === "Solvent" && b.strategy.takeover)
          .map((b) => ({ b, p: b.strategy.takeover!({ id: f.id, account: f.account, fills: f.fills, edge: f.edge, stable: f.stable, asset: f.asset, reserve: 1n }, b) }))
          .filter((x) => x.p !== null && x.p! <= x.b.stable)
          .sort((a, b) => (b.p! > a.p! ? 1 : -1));
        if (buyers.length) {
          const price = buyers.length > 1 ? buyers[1].p! : 1n;
          buyers[0].b.stable -= price;
          totals.takeovers++;
          events.push(`${new Date(series.start_ms + i * 300_000).toISOString().slice(0, 16)} ${f.name} liquidated, bought by ${buyers[0].b.name} for ${(Number(price) / 1e6).toFixed(2)} USDC`);
        } else events.push(`${f.name} liquidated, no buyer: wound up`);
        f.status = "Closed";
      }
      for (const f of firms.filter((x) => x.manager !== "fixed" && x.status === "Solvent")) {
        const value = (f.asset * toBase(mid)) / NEAR_UNIT;
        const r = { ...f.results, assetShare: Number(value) / Number(f.stable + value) };
        const decideWith = (m: Llm | null) => decide(m, f.name, f.params, r, f.policy.max_asset_bps / 10_000, f.manager === "bandit" ? f.bandit : undefined);
        // As the swarm: a failed LLM call leaves this decision to the rule.
        const d = await decideWith(f.manager === "llm" ? llm : null).catch(() => decideWith(null));
        if (d.source === "near-ai-cloud" || d.source === "anthropic") f.llmDecisions++;
        f.params = d.after;
        f.results = { quoted: 0, filled: 0, orders: 0, edge: 0n, assetShare: 0 };
      }
    }
  }
  const endMid = toBase(fx[from + bars - 1]);
  const nav = (f: { stable: bigint; asset: bigint }) => f.stable + (f.asset * endMid) / NEAR_UNIT;
  const hhi = firms.reduce((a, f) => a + (totals.fills ? (f.fills / totals.fills) ** 2 : 0), 0) * 10_000;
  return {
    seed: o.seed,
    window: { from: new Date(series.start_ms + from * 300_000).toISOString().slice(0, 10), days: o.days, nearStart: fx[from], nearEnd: fx[from + bars - 1] },
    orders: totals.orders,
    fillRate: totals.orders ? totals.fills / totals.orders : 0,
    refunded: totals.refunded,
    avgImprovementBps: totals.fills ? totals.improvement / totals.fills : 0,
    volumeUsdc: Number(totals.volume) / 1e6,
    liquidations: totals.liquidations,
    takeovers: totals.takeovers,
    hhi: Math.round(hhi),
    events,
    firms: firms.map((f) => ({
      name: f.name,
      status: f.status ?? "Solvent",
      fills: f.fills,
      share: totals.fills ? f.fills / totals.fills : 0,
      edgeUsdc: Number(f.edge) / 1e6,
      dividendsUsdc: Number(f.dividends) / 1e6,
      // P&L against holding its starting inventory, at the last mid (dividends paid count as earned).
      pnlVsHoldUsdc: (Number(nav(f) + f.dividends) - Number(nav(f.start))) / 1e6,
      spreadBps: f.params.spreadBps,
      ai: f.strategy.managed === true,
      /** Auctions it bid in, its worst fall of P&L against holding (hourly samples), its decisions made by an LLM. */
      quoted: f.quoted,
      maxDrawdownUsdc: f.drawdown,
      llmDecisions: f.llmDecisions,
    })),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = (k: string, d: number) => Number(process.env[k] ?? d);
  const opts = { seed: env("SEED", 1), clients: env("CLIENTS", 20), extraFirms: env("EXTRA_FIRMS", 6), days: env("DAYS", 7), ordersPerHour: env("ORDERS_PER_HOUR", 12) };
  const r = await simulate(opts);
  // Ablation: the same run with the AI-managed firm on fixed params.
  const fixed = await simulate({ ...opts, managed: false });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ...r, ablation: fixed.firms.filter((f) => f.ai) }, null, 2));
  } else {
    console.log(`seed ${r.seed}, ${r.window.days} days from ${r.window.from} (NEAR ${r.window.nearStart} -> ${r.window.nearEnd}), ${opts.clients} clients, ${r.firms.length} firms`);
    console.log(`orders ${r.orders}, filled ${(r.fillRate * 100).toFixed(1)}%, refunded ${r.refunded}, average ${r.avgImprovementBps.toFixed(1)} bp better than the market reference, volume ${r.volumeUsdc.toFixed(0)} USDC`);
    console.log(`liquidations ${r.liquidations}, takeovers ${r.takeovers}, concentration (HHI) ${r.hhi}`);
    for (const e of r.events) console.log(`  ${e}`);
    console.log("\nfirm                status       fills  share   edge USDC  dividends  P&L vs holding  spread");
    for (const f of r.firms)
      console.log(`${f.name.padEnd(19)} ${f.status.padEnd(11)} ${String(f.fills).padStart(6)} ${(f.share * 100).toFixed(1).padStart(5)}% ${f.edgeUsdc.toFixed(2).padStart(10)} ${f.dividendsUsdc.toFixed(2).padStart(10)} ${f.pnlVsHoldUsdc.toFixed(2).padStart(15)} ${String(f.spreadBps).padStart(6)} bp`);
    for (const m of r.firms.filter((f) => f.ai)) {
      const b = fixed.firms.find((x) => x.name === m.name)!;
      console.log(`\nablation, ${m.name}: managed (rule, no LLM) P&L ${m.pnlVsHoldUsdc.toFixed(2)} USDC on ${m.fills} fills, fixed params ${b.pnlVsHoldUsdc.toFixed(2)} USDC on ${b.fills} fills`);
    }
  }
}
