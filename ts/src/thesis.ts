// `make thesis`: "NEAR captures agent value through Intents-funded buybacks, not gas."
//
//   npx tsx src/thesis.ts snapshot   fetch DefiLlama, NEARBlocks and the buyback account's daily balances
//                                    (archival RPC) into data/snapshot.json
//   npx tsx src/thesis.ts freeze     compute P1-P3, P5, P6 from the snapshot, write thesis/predictions.json, print its sha256
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
const BUYBACKS = "buybacks.multisignature.near";
const ARCHIVAL = process.env.NEAR_ARCHIVAL_RPC ?? "https://archival-rpc.mainnet.fastnear.com";
const WINDOW_DAYS = 12;
// DefiLlama still revises the last day or two (2026-10-29 fees went from $8.8k to $199k within a day):
// the verdict is read on or after `read_from`.
const EVAL = { from: "2026-11-01", to: "2026-11-12", read_from: "2026-11-14" };
const P3_MIN_BP = 4.0;
// A day bringing in more than this is a one-off transfer, not buyback flow (502,793 NEAR from a DAO on
// 2026-09-09): P5's base rate leaves out the windows that contain one.
const ONE_OFF_NEAR = 200_000;
// The multisig pays the gas of its own confirmations: a daily drop above 1 NEAR is an outflow, not gas.
const P6_MAX_DROP_NEAR = 1;

type Series = [number, number][];
/** Balance of the buyback account (amount + locked, NEAR) at the first block of a UTC day. */
type Balance = { date: string; height: number; near: number };
type Snapshot = { fetched_at: string; sources: typeof SOURCES; volume: Series; intentsFees: Series; intentsRevenue: Series; nearFees: Series; near_price: number; total_supply_near: number; buybacks?: Balance[] };
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
    buybacks: await buybackBalances(),
  };
  mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify(snap) + "\n");
  console.log(`snapshot: ${snap.volume.length} days of volume, last ${days(snap).at(-1)?.date}, NEAR $${snap.near_price}`);
  console.log(`buybacks: ${snap.buybacks!.length} daily balances, ${snap.buybacks!.at(-1)!.date} ${snap.buybacks!.at(-1)!.near} NEAR`);
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** JSON-RPC on the archival node, paced under its free rate limit, with backoff on 429 and 5xx. */
async function rpc(method: string, params: unknown): Promise<any> {
  for (let i = 0; ; i++) {
    await sleep(400);
    const r = await fetch(ARCHIVAL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).catch(() => null);
    // A skipped block height answers 422 UNKNOWN_BLOCK: an answer, not a failure.
    if (r?.ok || r?.status === 422) return r.json();
    if ((r && r.status !== 429 && r.status < 500) || i === 6) throw new Error(`${ARCHIVAL} ${method} ${JSON.stringify(params)}: ${r?.status ?? "network error"} ${r ? (await r.text()).slice(0, 200) : ""}`);
    await sleep(5000 * 2 ** i);
  }
}

/** The first existing block at or after height `h` (heights can be skipped): [height, unix seconds]. */
async function blockFrom(h: number): Promise<[number, number]> {
  for (let k = 0; k < 100; k++) {
    const r = await rpc("block", { block_id: h + k });
    if (r.result) return [r.result.header.height, Number(BigInt(r.result.header.timestamp_nanosec) / 1_000_000n) / 1000];
  }
  throw new Error(`no block from height ${h}`);
}

/** The first block at or after unix time `t`, searched from a block `from` near it (`secs` per block). */
async function firstBlockAt(t: number, from: [number, number], secs = 0.6): Promise<[number, number]> {
  let b = from;
  // Jump close, bracket, then bisect over heights.
  for (let i = 0; i < 6 && Math.abs(t - b[1]) > 30; i++) b = await blockFrom(Math.max(1, b[0] + Math.round((t - b[1]) / secs)));
  let lo = b, hi = b;
  for (let step = 10; lo[1] >= t; step *= 2) lo = await blockFrom(Math.max(1, lo[0] - step));
  for (let step = 10; hi[1] < t; step *= 2) hi = await blockFrom(hi[0] + step);
  // Invariant: lo is before t, hi at or after it, and no block exists in [top, hi).
  let top = hi[0];
  while (top - lo[0] > 1) {
    const mid = Math.floor((lo[0] + top) / 2);
    const m = await blockFrom(mid);
    if (m[0] >= top) top = mid;
    else if (m[1] >= t) [hi, top] = [m, m[0]];
    else lo = m;
  }
  return hi;
}

/** The buyback account's balance at the first block of each of the last 91 UTC days. */
async function buybackBalances(): Promise<Balance[]> {
  const head = (await rpc("block", { finality: "final" })).result.header;
  let b: [number, number] = [head.height, Number(BigInt(head.timestamp_nanosec) / 1_000_000n) / 1000];
  const last = Math.floor((b[1] - 60) / 86_400) * 86_400;
  const out: Balance[] = [];
  let secs = 0.6;
  for (let t = last; t >= last - 90 * 86_400; t -= 86_400) {
    const prev = b;
    b = await firstBlockAt(t, b, secs);
    // The last day's pace predicts the next jump to a few blocks.
    if (out.length) secs = 86_400 / (prev[0] - b[0]);
    const a = (await rpc("query", { request_type: "view_account", block_id: b[0], account_id: BUYBACKS })).result;
    if (!a) throw new Error(`view_account ${BUYBACKS} at ${b[0]} failed`);
    out.unshift({ date: new Date(t * 1000).toISOString().slice(0, 10), height: b[0], near: Number((BigInt(a.amount) + BigInt(a.locked)) / 10n ** 20n) / 1e4 });
    console.log(`  ${out[0].date} block ${b[0]}: ${out[0].near} NEAR`);
  }
  return out;
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
// Total gas fees, not the burnt share: the burn rate (70% today) has an approved move to 100%, and a
// ratio on fees stays comparable across that change.
const revOverGas = (d: Day[]) => sum(d, "rev") / sum(d, "gas");

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

/** Daily balance changes of the buyback account: flow[i] is what changed during day b[i]. */
const flows = (b: Balance[]) => b.slice(1).map((x, i) => x.near - b[i].near);

function computePredictions(s: Snapshot) {
  const d = days(s);
  const w = windows(d, WINDOW_DAYS, 90);
  const v = w.map(avgVol);
  const g = w.map(revOverGas);
  const flow = flows(s.buybacks ?? []);
  const b12 = flow
    .slice(0, Math.max(0, flow.length - WINDOW_DAYS + 1))
    .map((_, i) => flow.slice(i, i + WINDOW_DAYS))
    .filter((x) => x.every((f) => f <= ONE_OFF_NEAR))
    .map((x) => x.reduce((a, f) => a + f, 0));
  return {
    thesis: "NEAR captures agent value through Intents-funded buybacks, not gas.",
    created_at: new Date().toISOString(),
    data_through: d.at(-1)!.date,
    method:
      `80% intervals = 10th-90th percentile of ${w.length} rolling ${WINDOW_DAYS}-day windows over the last 90 days (DefiLlama). ` +
      `P5: the same over ${b12.length} rolling ${WINDOW_DAYS}-day balance changes of ${BUYBACKS} (first block of each UTC day, archival RPC), ` +
      `leaving out the windows with a day above ${ONE_OFF_NEAR.toLocaleString("en-US")} NEAR (a one-off: 502,793 NEAR from a DAO on 2026-09-09).`,
    window: EVAL,
    evaluation:
      `On or after ${EVAL.read_from} (UTC), fetch the same sources (below), keep the UTC days ${EVAL.from} to ${EVAL.to} inclusive present in all four series. ` +
      "P1 = mean of daily volume. P2 = sum(Intents revenue) / sum(NEAR gas fees). P3 = 10000 * sum(Intents revenue) / sum(volume). " +
      `On chain, B(day) = amount + locked of ${BUYBACKS} (view_account) at the first block at or after 00:00 UTC of that day, on an archival RPC. ` +
      `P5 = B(2026-11-13) - B(${EVAL.from}), in NEAR. P6 = the largest fall of B from one day to the next, ${EVAL.from} to 2026-11-13. ` +
      `A prediction is TRUE if the observed value lies in its interval (P3: at or above its minimum; P6: at most ${P6_MAX_DROP_NEAR} NEAR), FALSE otherwise. Fewer than 12 days: no verdict.`,
    sources: SOURCES,
    onchain: { rpc: ARCHIVAL, account: BUYBACKS },
    snapshot_sha256: createHash("sha256").update(readFileSync(SNAPSHOT)).digest("hex"),
    caveats: [
      "DefiLlama 'revenue' (equal to 'holdersRevenue') for near-intents is the NEAR sent to three wallets: buybacks.multisignature.near, fefundsadmin.sputnik-dao.near (a front-end fund DAO) and 1csfundsadmin.sputnik-dao.near. Over the 30 days to 2026-10-30 the buyback multisig received 65.6% of it (on-chain balance changes).",
      "Bought-back NEAR offsets emission only if it is burnt or locked. On 2026-10-30 buybacks.multisignature.near held 2.13M NEAR, none staked or locked, movable by 2 of its 4 keys: it offset nothing yet. P5 and P6 read that account on chain.",
    ],
    P1: { metric: "mean daily Intents volume (USD)", low: quantile(v, 0.1), central: quantile(v, 0.5), high: quantile(v, 0.9), kind: "base rate" },
    P2: { metric: "Intents revenue / NEAR gas fees (total, not only the burnt share)", low: quantile(g, 0.1), central: quantile(g, 0.5), high: quantile(g, 0.9), kind: "base rate" },
    P3: { metric: "protocol take rate = Intents revenue / volume (bp)", min: P3_MIN_BP, kind: "tests the thesis" },
    P5: { metric: `NEAR received by ${BUYBACKS} over the window (balance change)`, low: quantile(b12, 0.1), central: quantile(b12, 0.5), high: quantile(b12, 0.9), kind: "base rate, on chain" },
    P6: {
      metric: `largest daily fall of the ${BUYBACKS} balance (NEAR): the bought NEAR is not sent out`,
      max_drop_near: P6_MAX_DROP_NEAR,
      falls_in_history: flow.filter((f) => f < -P6_MAX_DROP_NEAR).length,
      history_days: flow.length,
      kind: "tests the thesis, on chain",
    },
  };
}

type Predictions = ReturnType<typeof computePredictions>;

const canonical = (x: unknown) => JSON.stringify(x, null, 2) + "\n";

function freeze() {
  if (existsSync(PREDICTIONS)) throw new Error(`${PREDICTIONS} exists: predictions are frozen once, delete it only if never published`);
  const snap = loadSnapshot();
  if (!snap.buybacks?.length) throw new Error("the snapshot has no buyback balances: run `npx tsx src/thesis.ts snapshot`");
  const p = computePredictions(snap);
  mkdirSync(path.dirname(PREDICTIONS), { recursive: true });
  const body = canonical(p);
  writeFileSync(PREDICTIONS, body);
  const h = createHash("sha256").update(body).digest("hex");
  console.log(body);
  console.log(`sha256 ${h}`);
  console.log(`Publish it (human, mainnet): a tx whose memo or args carry this hash, then put the tx link in CLAIMS.md.`);
  console.log(`Commit thesis/predictions.json with data/snapshot.json and tag it (git tag thesis-freeze): a later snapshot overwrites the file hashed above.`);
}

// ---------------------------------------------------------------- evaluate + HTML

const usd = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x).toLocaleString("en-US")}`);
const nearFmt = (x: number) => Math.round(x).toLocaleString("en-US");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function evaluate(p: Predictions, d: Day[], fetchedAt?: string) {
  const win = d.filter((x) => x.date >= p.window.from && x.date <= p.window.to);
  // ISO strings compare in time order; a read before read_from gives no verdict, as pre-registered.
  const early = !!fetchedAt && !!p.window.read_from && fetchedAt < p.window.read_from;
  const complete = win.length === WINDOW_DAYS && !early;
  const status = (ok: boolean) =>
    win.length < WINDOW_DAYS ? `pending (${win.length}/${WINDOW_DAYS} days)` : early ? `pending (read on or after ${p.window.read_from})` : ok ? "TRUE" : "FALSE";
  if (!win.length) return { complete, win, P1: { observed: null, status: status(false) }, P2: { observed: null, status: status(false) }, P3: { observed: null, status: status(false) } };
  const o1 = avgVol(win), o2 = revOverGas(win), o3 = bp(win);
  return {
    complete,
    win,
    P1: { observed: o1, status: status(o1 >= p.P1.low && o1 <= p.P1.high) },
    P2: { observed: o2, status: status(o2 >= p.P2.low && o2 <= p.P2.high) },
    P3: { observed: o3, status: status(o3 >= p.P3.min) },
  };
}

/** P5 and P6 from the buyback account's daily balances: B(from) to B(the day after `to`). */
export function evaluateBuybacks(p: { window: { from: string; to: string; read_from?: string }; P5: { low: number; high: number }; P6: { max_drop_near: number } }, b: Balance[], fetchedAt?: string) {
  const end = new Date(Date.parse(p.window.to) + 86_400_000).toISOString().slice(0, 10);
  const pts = b.filter((x) => x.date >= p.window.from && x.date <= end);
  const n = Math.max(0, pts.length - 1);
  const early = !!fetchedAt && !!p.window.read_from && fetchedAt < p.window.read_from;
  const status = (ok: boolean) => (n < WINDOW_DAYS ? `pending (${n}/${WINDOW_DAYS} days)` : early ? `pending (read on or after ${p.window.read_from})` : ok ? "TRUE" : "FALSE");
  if (pts.length < 2) return { P5: { observed: null, status: status(false) }, P6: { observed: null, status: status(false) } };
  const change = pts.at(-1)!.near - pts[0].near;
  const maxDrop = Math.max(0, ...flows(pts).map((f) => -f));
  return { P5: { observed: change, status: status(change >= p.P5.low && change <= p.P5.high) }, P6: { observed: maxDrop, status: status(maxDrop <= p.P6.max_drop_near) } };
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
  const e = evaluate(p, d, s.fetched_at);
  const eb = p.P5 && p.P6 ? evaluateBuybacks(p, s.buybacks ?? [], s.fetched_at) : null;

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
    P5: eb?.P5 ?? null,
    P6: eb?.P6 ?? null,
    buybacks_balance_near: s.buybacks?.at(-1)?.near ?? null,
    buybacks_through: s.buybacks?.at(-1)?.date ?? null,
    blocks: blocks.map((b) => ({ from: b[0].date, to: b.at(-1)!.date, bp: bp(b) })),
    sensitivity: sens.map((x) => ({ takeRateBp: x.t, emission: x.em, requiredPerDay: x.required, multiple: x.multiple })),
    near_price: s.near_price,
    avg_daily_volume_30d: base.avgDailyVol,
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
${p.P5 && eb ? row("P5 " + p.P5.kind, `${nearFmt(p.P5.low)} to ${nearFmt(p.P5.high)} NEAR (central ${nearFmt(p.P5.central)})`, eb.P5.observed === null ? "-" : `${nearFmt(eb.P5.observed)} NEAR`, eb.P5.status) : ""}
${p.P6 && eb ? row("P6 " + p.P6.kind, `no daily fall above ${p.P6.max_drop_near} NEAR`, eb.P6.observed === null ? "-" : `largest fall ${eb.P6.observed.toFixed(2)} NEAR`, eb.P6.status) : ""}
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
