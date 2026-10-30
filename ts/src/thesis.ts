// `make thesis`: "NEAR captures agent value through Intents-funded buybacks, not gas."
//
//   npx tsx src/thesis.ts snapshot   fetch DefiLlama + NEARBlocks into data/snapshot.json
//   npx tsx src/thesis.ts freeze     compute P1-P3 from the snapshot, write thesis/predictions.json, print its sha256
//   npx tsx src/thesis.ts            (default) evaluate the frozen predictions on the snapshot, write thesis/index.html
//
// Only public endpoints, no key. Every number in the HTML comes from data/snapshot.json, so anyone can re-run it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SNAPSHOT = path.join(ROOT, "data", "snapshot.json");
const PREDICTIONS = path.join(ROOT, "thesis", "predictions.json");
const SWARM = path.join(ROOT, "data", "swarm-volume.json");

const LLAMA = "https://api.llama.fi/summary";
const SOURCES = {
  volume: `${LLAMA}/dexs/near-intents`,
  intentsFees: `${LLAMA}/fees/near-intents?dataType=dailyFees`,
  intentsRevenue: `${LLAMA}/fees/near-intents?dataType=dailyRevenue`,
  nearFees: `${LLAMA}/fees/near?dataType=dailyFees`,
  nearStats: "https://api.nearblocks.io/v1/stats",
};
/** Share of NEAR transaction fees burnt (the other 30% goes to contracts). */
const GAS_BURN_SHARE = 0.7;
const WINDOW_DAYS = 12;
const EVAL = { from: "2026-11-01", to: "2026-11-12" };
const P3_MIN_BP = 4.0;

type Series = [number, number][];
type Snapshot = { fetched_at: string; sources: typeof SOURCES; volume: Series; intentsFees: Series; intentsRevenue: Series; nearFees: Series; near_price: number; total_supply_near: number };
type Day = { ts: number; date: string; vol: number; rev: number; fees: number; gas: number };

// ---------------------------------------------------------------- data

async function snapshot() {
  const get = async (u: string) => {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`${u}: ${r.status}`);
    return r.json() as Promise<any>;
  };
  const [v, f, r, n, s] = await Promise.all(Object.values(SOURCES).map(get));
  const stats = s.stats[0];
  const snap: Snapshot = {
    fetched_at: new Date().toISOString(),
    sources: SOURCES,
    volume: v.totalDataChart,
    intentsFees: f.totalDataChart,
    intentsRevenue: r.totalDataChart,
    nearFees: n.totalDataChart,
    near_price: Number(stats.near_price),
    total_supply_near: Number(BigInt(stats.total_supply) / 10n ** 24n),
  };
  mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify(snap) + "\n");
  console.log(`snapshot: ${snap.volume.length} days of volume, last ${days(snap).at(-1)?.date}, NEAR $${snap.near_price}`);
}

function loadSnapshot(): Snapshot {
  if (!existsSync(SNAPSHOT)) throw new Error("no data/snapshot.json: run `npx tsx src/thesis.ts snapshot`");
  return JSON.parse(readFileSync(SNAPSHOT, "utf8"));
}

/** Days present in all four series, ascending. */
export function days(s: Pick<Snapshot, "volume" | "intentsFees" | "intentsRevenue" | "nearFees">): Day[] {
  const m = (x: Series) => new Map(x.map(([t, v]) => [t, v]));
  const [f, r, g] = [m(s.intentsFees), m(s.intentsRevenue), m(s.nearFees)];
  return s.volume
    .filter(([t]) => f.has(t) && r.has(t) && g.has(t))
    .map(([t, vol]) => ({ ts: t, date: new Date(t * 1000).toISOString().slice(0, 10), vol, rev: r.get(t)!, fees: f.get(t)!, gas: g.get(t)! }))
    .sort((a, b) => a.ts - b.ts);
}

const sum = (d: Day[], k: keyof Day) => d.reduce((a, x) => a + (x[k] as number), 0);
const bp = (d: Day[]) => (1e4 * sum(d, "rev")) / sum(d, "vol");
const avgVol = (d: Day[]) => sum(d, "vol") / d.length;
const revOverBurn = (d: Day[]) => sum(d, "rev") / (GAS_BURN_SHARE * sum(d, "gas"));

export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
}

/** Rolling windows of `n` days over the last `span` days. */
function windows(d: Day[], n: number, span: number): Day[][] {
  const tail = d.slice(-span);
  return tail.slice(0, tail.length - n + 1).map((_, i) => tail.slice(i, i + n));
}

// ---------------------------------------------------------------- the multiple

/**
 * Daily Intents volume needed for revenue (allocated to buybacks) to match NEAR emission in USD,
 * and its multiple of the current 30-day average. A buyback only offsets emission if the bought NEAR
 * is burnt or locked: stated as a condition, not assumed.
 */
export function multiple(o: { supply: number; price: number; emission: number; takeRateBp: number; avgDailyVol: number; internalShare?: number }) {
  const emissionPerDay = (o.supply * o.price * o.emission) / 365;
  // Volume settled internally (mt_transfer between agents) pays no Intents fee.
  const feeBearing = 1 - (o.internalShare ?? 0);
  const required = emissionPerDay / (o.takeRateBp / 1e4) / feeBearing;
  return { emissionPerDay, required, multiple: required / o.avgDailyVol };
}

// ---------------------------------------------------------------- predictions

function computePredictions(s: Snapshot) {
  const d = days(s);
  const w = windows(d, WINDOW_DAYS, 90);
  const v = w.map(avgVol);
  const g = w.map(revOverBurn);
  return {
    thesis: "NEAR captures agent value through Intents-funded buybacks, not gas.",
    created_at: new Date().toISOString(),
    data_through: d.at(-1)!.date,
    method: `80% intervals = 10th-90th percentile of ${w.length} rolling ${WINDOW_DAYS}-day windows over the last 90 days (DefiLlama).`,
    window: EVAL,
    P1: { metric: "mean daily Intents volume (USD)", low: quantile(v, 0.1), central: quantile(v, 0.5), high: quantile(v, 0.9), kind: "base rate" },
    P2: { metric: `Intents revenue / NEAR gas burnt (${GAS_BURN_SHARE * 100}% of fees)`, low: quantile(g, 0.1), central: quantile(g, 0.5), high: quantile(g, 0.9), kind: "base rate" },
    P3: { metric: "protocol take rate = Intents revenue / volume (bp)", min: P3_MIN_BP, kind: "tests the thesis" },
  };
}

type Predictions = ReturnType<typeof computePredictions>;

const canonical = (x: unknown) => JSON.stringify(x, null, 2) + "\n";

function freeze() {
  if (existsSync(PREDICTIONS)) throw new Error(`${PREDICTIONS} exists: predictions are frozen once, delete it only if never published`);
  const p = computePredictions(loadSnapshot());
  mkdirSync(path.dirname(PREDICTIONS), { recursive: true });
  const body = canonical(p);
  writeFileSync(PREDICTIONS, body);
  const h = createHash("sha256").update(body).digest("hex");
  console.log(body);
  console.log(`sha256 ${h}`);
  console.log(`Publish it (human, mainnet): a tx whose memo or args carry this hash, then put the tx link in CLAIMS.md.`);
}

// ---------------------------------------------------------------- evaluate + HTML

const usd = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x).toLocaleString("en-US")}`);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function evaluate(p: Predictions, d: Day[]) {
  const win = d.filter((x) => x.date >= p.window.from && x.date <= p.window.to);
  const complete = win.length === WINDOW_DAYS;
  const status = (ok: boolean) => (complete ? (ok ? "TRUE" : "FALSE") : `pending (${win.length}/${WINDOW_DAYS} days)`);
  if (!win.length) return { complete, win, P1: { observed: null, status: status(false) }, P2: { observed: null, status: status(false) }, P3: { observed: null, status: status(false) } };
  const o1 = avgVol(win), o2 = revOverBurn(win), o3 = bp(win);
  return {
    complete,
    win,
    P1: { observed: o1, status: status(o1 >= p.P1.low && o1 <= p.P1.high) },
    P2: { observed: o2, status: status(o2 >= p.P2.low && o2 <= p.P2.high) },
    P3: { observed: o3, status: status(o3 >= p.P3.min) },
  };
}

function report() {
  const s = loadSnapshot();
  const d = days(s);
  const p: Predictions = existsSync(PREDICTIONS) ? JSON.parse(readFileSync(PREDICTIONS, "utf8")) : computePredictions(s);
  const frozen = existsSync(PREDICTIONS);
  const hash = frozen ? createHash("sha256").update(readFileSync(PREDICTIONS)).digest("hex") : null;
  const last30 = d.slice(-30);
  const base = { supply: s.total_supply_near, price: s.near_price, avgDailyVol: avgVol(last30) };
  const tr = bp(last30);
  const m25 = multiple({ ...base, emission: 0.025, takeRateBp: tr });
  const m16 = multiple({ ...base, emission: 0.016, takeRateBp: tr });
  const e = evaluate(p, d);

  // 12-day blocks of the take rate since July: the regime change P3 bets on.
  const since = d.filter((x) => x.date >= "2026-07-01");
  const blocks = Array.from({ length: Math.floor(since.length / WINDOW_DAYS) }, (_, i) => since.slice(i * WINDOW_DAYS, (i + 1) * WINDOW_DAYS));

  // P4: value the swarm settles internally, priced at the protocol take rate it does not pay.
  const swarm = existsSync(SWARM) ? JSON.parse(readFileSync(SWARM, "utf8")) : { volume_usd: 0, fees_usd: 0, source: "none yet" };
  const swarmBp = swarm.volume_usd ? (1e4 * swarm.fees_usd) / swarm.volume_usd : 0;
  const leak = (swarm.volume_usd * (tr - swarmBp)) / 1e4;

  const sens = [2.5, 4, 5.41, 7].flatMap((t) => [0.025, 0.016].map((em) => ({ t, em, ...multiple({ ...base, emission: em, takeRateBp: t }) })));
  const out = {
    data_through: d.at(-1)!.date,
    fetched_at: s.fetched_at,
    take_rate_30d_bp: tr,
    multiple_2_5: m25.multiple,
    multiple_1_6: m16.multiple,
    predictions_sha256: hash,
    P1: e.P1,
    P2: e.P2,
    P3: e.P3,
    P4_leak_usd: leak,
  };
  const row = (id: string, pr: string, ob: string, st: string) => `<tr><td>${id}</td><td>${esc(pr)}</td><td>${esc(ob)}</td><td><b>${esc(st)}</b></td></tr>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tontine thesis</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 16px;background:#fff;color:#111}table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}code{font-size:13px}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}td,th{border-color:#444}}</style></head><body>
<h1>NEAR captures agent value through Intents-funded buybacks, not gas</h1>
<p>Data through ${d.at(-1)!.date} (snapshot ${s.fetched_at}). Sources: ${Object.values(SOURCES).map((u) => `<code>${esc(u)}</code>`).join(", ")}. Re-run: <code>make thesis</code>.</p>
<h2>The multiple</h2>
<p>Intents volume needed for buybacks to match NEAR emission: <b>${m25.multiple.toFixed(1)}x</b> the 30-day average at 2.5% emission (${m16.multiple.toFixed(1)}x at 1.6%).
Required ${usd(m25.required)}/day vs ${usd(base.avgDailyVol)}/day, take rate ${tr.toFixed(2)} bp, NEAR $${s.near_price}, supply ${(s.total_supply_near / 1e9).toFixed(2)}B.
A buyback offsets emission only if the bought NEAR is burnt or locked.</p>
<table><tr><th>take rate (bp)</th><th>emission</th><th>required volume/day</th><th>multiple</th></tr>${sens.map((x) => `<tr><td>${x.t}</td><td>${x.em * 100}%</td><td>${usd(x.required)}</td><td>${x.multiple.toFixed(1)}x</td></tr>`).join("")}</table>
<h2>Pre-registered predictions, ${p.window.from} to ${p.window.to}</h2>
<p>${frozen ? `Frozen file <code>thesis/predictions.json</code>, sha256 <code>${hash}</code>.` : "<b>Not frozen yet</b>: values below are computed live and prove nothing until hashed on-chain."} ${esc(p.method)}</p>
<table><tr><th></th><th>predicted</th><th>observed</th><th>status</th></tr>
${row("P1 " + p.P1.kind, `${usd(p.P1.low)} to ${usd(p.P1.high)} (central ${usd(p.P1.central)})`, e.P1.observed === null ? "-" : usd(e.P1.observed), e.P1.status)}
${row("P2 " + p.P2.kind, `${p.P2.low.toFixed(1)} to ${p.P2.high.toFixed(1)} (central ${p.P2.central.toFixed(1)})`, e.P2.observed === null ? "-" : e.P2.observed.toFixed(1), e.P2.status)}
${row("P3 " + p.P3.kind, `>= ${p.P3.min} bp`, e.P3.observed === null ? "-" : `${e.P3.observed.toFixed(2)} bp`, e.P3.status)}
${row("P4 measure", "swarm value leak = swarm volume x (protocol bp - swarm bp)", `${usd(leak)} on ${usd(swarm.volume_usd)} (${esc(swarm.source)})`, swarm.volume_usd ? "measured" : "no swarm volume yet")}
</table>
<h2>Take rate by ${WINDOW_DAYS}-day block since July</h2>
<table><tr><th>from</th><th>to</th><th>bp</th></tr>${blocks.map((b) => `<tr><td>${b[0].date}</td><td>${b.at(-1)!.date}</td><td>${bp(b).toFixed(2)}</td></tr>`).join("")}</table>
</body></html>
`;
  mkdirSync(path.join(ROOT, "thesis"), { recursive: true });
  writeFileSync(path.join(ROOT, "thesis", "index.html"), html);
  writeFileSync(path.join(ROOT, "thesis", "result.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
  console.log("wrote thesis/index.html");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2] ?? "report";
  if (cmd === "snapshot") await snapshot();
  else if (cmd === "freeze") freeze();
  else if (cmd === "report") report();
  else throw new Error(`unknown command ${cmd}`);
}
