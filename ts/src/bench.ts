// `make bench SEED=1`: is Atlas AI's manager worth having? The same weeks of NEAR prices and the same order flow
// run with Atlas on fixed params, the stated rule, a UCB1 bandit on its spread (manager.ts), and the LLM when a
// key is set. Only Atlas's manager changes between arms, so arms compare run by run. Without an LLM the result
// is the same for a seed; it is written to bench/result.json.
//
//   SEED=1 SEEDS=5 WINDOWS=14 DAYS=7 npx tsx src/bench.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeLlm } from "./llm.ts";
import { rng, simulate, type Manager } from "./sim.ts";

const FIRM = "Atlas AI";
const BAR_MS = 300_000;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const METRICS = ["pnl", "fills", "edge", "maxDrawdown", "winRate"] as const;
type Metric = (typeof METRICS)[number];

/** fixtures/near-usd-5m-history.json then fixtures/near-usd-5m.json: one series of 5-minute closes. */
export function history() {
  const [h, c] = ["near-usd-5m-history.json", "near-usd-5m.json"].map((f) => JSON.parse(readFileSync(path.join(root, "fixtures", f), "utf8")));
  if (h.start_ms + h.prices.length * BAR_MS !== c.start_ms) throw new Error("the history fixture does not end where near-usd-5m.json starts");
  return { start_ms: h.start_ms as number, prices: [...h.prices, ...c.prices] as number[] };
}

const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;

/** Mean and percentile bootstrap 90% interval over windows: 2000 resamples, the same draws for every statistic. */
function stat(xs: number[], seed: number) {
  const rand = rng(seed);
  const means = Array.from({ length: 2000 }, () => mean(xs.map(() => xs[Math.floor(rand() * xs.length)]))).sort((a, b) => a - b);
  return { mean: mean(xs), lo: means[100], hi: means[1899] };
}

export type BenchOptions = { seed: number; seeds: number; days: number; windows?: number; clients: number; extraFirms: number; ordersPerHour: number; llm: boolean };

export async function bench(o: BenchOptions) {
  const series = history();
  const len = o.days * 288;
  const n = Math.min(o.windows ?? Infinity, Math.floor(series.prices.length / len));
  // Back to back windows ending at the last bar, oldest first: the latest one is the window of `make sim`.
  const offsets = Array.from({ length: n }, (_, k) => series.prices.length - (n - k) * len);
  const seeds = Array.from({ length: o.seeds }, (_, k) => o.seed + k);
  const arms: Manager[] = ["fixed", "rule", "bandit", ...(o.llm ? (["llm"] as const) : [])];
  const runs: ({ window: number; seed: number; arm: Manager; llmDecisions: number } & Record<Metric, number>)[] = [];
  const windows = [];
  for (const [w, offset] of offsets.entries()) {
    for (const seed of seeds)
      for (const arm of arms) {
        const r = await simulate({ seed, clients: o.clients, extraFirms: o.extraFirms, days: o.days, ordersPerHour: o.ordersPerHour, offset, series, managerFor: (f) => (f === FIRM ? arm : undefined) });
        const f = r.firms.find((x) => x.name === FIRM)!;
        if (seed === o.seed && arm === "fixed") windows.push({ offset, ...r.window });
        runs.push({ window: w, seed, arm, pnl: f.pnlVsHoldUsdc, fills: f.fills, edge: f.edgeUsdc, maxDrawdown: f.maxDrawdownUsdc, winRate: f.quoted ? f.fills / f.quoted : 0, llmDecisions: f.llmDecisions });
      }
  }
  // One value per window and arm: the mean over seeds. Intervals resample windows.
  const perWindow = (arm: Manager, m: Metric) => offsets.map((_, w) => mean(runs.filter((r) => r.window === w && r.arm === arm).map((r) => r[m])));
  const fixed = perWindow("fixed", "pnl");
  const summary = Object.fromEntries(
    arms.map((arm) => [
      arm,
      {
        ...Object.fromEntries(METRICS.map((m) => [m, stat(perWindow(arm, m), o.seed)])),
        pnlVsFixed: stat(perWindow(arm, "pnl").map((x, w) => x - fixed[w]), o.seed),
      },
    ]),
  ) as Record<Manager, Record<Metric | "pnlVsFixed", ReturnType<typeof stat>>>;
  return {
    method:
      `${FIRM} under each manager arm, every other firm unchanged (rule firms on their rule). Same seed and window: same orders, ` +
      `so arms are paired. Per run: P&L against holding the starting inventory at the last mid (dividends count), fills, edge, ` +
      `largest fall of that P&L (hourly samples), win rate = fills / auctions bid in. Per window: mean over seeds. ` +
      `Mean over windows with a percentile bootstrap 90% interval (2000 resamples of windows, seed ${o.seed}). ` +
      `pnlVsFixed: the paired difference with the fixed arm. The llm arm pays no inference here (500 USDC base units a decision in the swarm).`,
    firm: FIRM,
    days: o.days,
    seeds,
    clients: o.clients,
    extraFirms: o.extraFirms,
    ordersPerHour: o.ordersPerHour,
    arms,
    skipped: o.llm ? [] : ["llm: no NEARAI_API_KEY or ANTHROPIC_API_KEY (or REPLAY=1)"],
    windows,
    summary,
    runs,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = (k: string, d: number) => Number(process.env[k] ?? d);
  const llm = makeLlm().live;
  const o: BenchOptions = { seed: env("SEED", 1), seeds: env("SEEDS", 5), days: env("DAYS", 7), windows: process.env.WINDOWS ? env("WINDOWS", 0) : undefined, clients: env("CLIENTS", 20), extraFirms: env("EXTRA_FIRMS", 6), ordersPerHour: env("ORDERS_PER_HOUR", 12), llm };
  if (llm) console.log(`llm arm live: one LLM call per hour simulated, ${o.days * 24} per run (WINDOWS and SEEDS cut it)`);
  const r = await bench(o);
  const w = r.windows;
  console.log(`${r.firm}, ${w.length} back to back windows of ${r.days} days (starting ${w[0].from} to ${w.at(-1)!.from}, NEAR ${w[0].nearStart} to ${w.at(-1)!.nearEnd}), seeds ${r.seeds.join(",")}`);
  console.log("mean over windows [bootstrap 90% interval]");
  const ci = (s: { mean: number; lo: number; hi: number }, d = 2) => `${s.mean.toFixed(d)} [${s.lo.toFixed(d)}, ${s.hi.toFixed(d)}]`.padEnd(24);
  console.log(`\n${"arm".padEnd(8)}${"P&L vs holding USDC".padEnd(24)}${"vs fixed USDC".padEnd(24)}${"fills".padStart(6)}${"edge USDC".padStart(11)}${"max DD USDC".padStart(13)}${"win rate".padStart(10)}`);
  for (const arm of r.arms) {
    const s = r.summary[arm];
    console.log(`${arm.padEnd(8)}${ci(s.pnl)}${ci(s.pnlVsFixed)}${s.fills.mean.toFixed(0).padStart(6)}${s.edge.mean.toFixed(2).padStart(11)}${s.maxDrawdown.mean.toFixed(2).padStart(13)}${(s.winRate.mean * 100).toFixed(1).padStart(9)}%`);
  }
  for (const s of r.skipped) console.log(`skipped ${s}`);
  mkdirSync(path.join(root, "bench"), { recursive: true });
  writeFileSync(path.join(root, "bench", "result.json"), JSON.stringify(r, null, 2) + "\n");
  console.log("\nbench/result.json written");
}
