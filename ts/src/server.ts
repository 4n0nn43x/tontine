// The hosted Tontine app in one process: a NEAR devnet with one tender per market (NEAR, ETH and SOL
// against USDC), the house swarm running for real on each (sealed quotes, fills, managers, epochs,
// liquidations), a house client that keeps posting orders at the market price, a chain indexer, the JSON
// API, a filtered RPC proxy for visitors' wallets, and the website itself.
//
//   npx tsx src/server.ts          (PORT=8080 HOST=127.0.0.1 by default; see README "Run the app")
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, truncateSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";
import { account, call, sleep, view, TGAS, USDC } from "./chain.ts";
import { DEVNET_CONFIG, FAUCET, startDevnet, units, type DevMarket, type Devnet } from "./devnet.ts";
import { Indexer, type ChainEvent, type Stats } from "./indexer.ts";
import { pageMeta, withMeta } from "./meta.ts";
import { checkRelay, Payouts, RelayGate, submitRelay, type RelayTargets } from "./relay.ts";
import { makeLlm } from "./llm.ts";
import { fetchHeadlines, Guard, NEWS_EVERY_MS, RANK, type GuardState, type Headline, type Regime } from "./guard.ts";
import { MAX_TEXT } from "./mandate.ts";
import { factsFromFirm, firmScore, reportProse } from "./report.ts";
import { ARMS, DecisionLog } from "./shadow.ts";
import { candles, INTERVALS, marketMid, reference, type AssetSymbol, type Reference } from "./prices.ts";
import { dailyCapped, HOUSE_MANDATES, INFERENCE_COST, quietErrors, Swarm, type FirmHandle } from "./swarm.ts";
import type { Strategy } from "./strategy.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "127.0.0.1";
const DIST = process.env.APP_DIST ?? path.join(ROOT, "app", "dist");
const HOUSE_CLIENT_SECS = Number(process.env.HOUSE_CLIENT_SECS ?? 70);
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

// ------------------------------------------------------------------ chain

const devnet: Devnet = await startDevnet(log);
const { provider } = devnet;
const llm = makeLlm();

/** A market at run time: its tender, swarm, reference price and cached state. */
type Market = DevMarket & {
  T: string;
  swarm: Swarm;
  ref: Reference & { at: number };
  mid(): Promise<number>;
  nextOrder: number;
  running: Set<number>;
  liquidating: Set<number>;
  tenderConfig: any;
  state: any;
};

const markets: Market[] = [];
for (const m of devnet.markets) {
  const T = m.tender.accountId;
  const mk: Market = {
    ...m,
    T,
    // The reference mid firms quote from: the market mid (median of Binance, OKX, Coinbase), refreshed at most every 30 s.
    ref: { ...(await reference("Buy", USDC(100), -1, m.symbol)), at: Date.now() },
    async mid() {
      if (Date.now() - mk.ref.at > 30_000) mk.ref = { ...(await reference("Buy", USDC(100), -1, m.symbol)), at: Date.now() };
      return mk.ref.mid;
    },
    swarm: null as unknown as Swarm,
    nextOrder: 0,
    running: new Set(),
    liquidating: new Set(),
    tenderConfig: await view(provider, T, "get_config"),
    state: { firms: [], orders: [], updatedAt: 0 },
  };
  mk.swarm = new Swarm(provider, T, m.firms, llm, devnet.inference, () => mk.mid(), (s) => log(`swarm ${m.symbol} ${s.trim()}`), { symbol: m.symbol, unit: m.unit });
  markets.push(mk);
}
const NEAR_MARKET = markets[0];
/** The market a tender or one of its firm accounts (`wN.<tender>`) belongs to. */
const marketOf = (contract: string) => markets.find((m) => contract === m.T || contract.endsWith(`.${m.T}`));
const bySymbol = (s: string | null) => (s === null ? NEAR_MARKET : markets.find((m) => m.symbol === s.toUpperCase()));

const indexer = new Indexer(devnet.rpcUrl, (c) => !!marketOf(c), 3000, (c) => marketOf(c)?.unit ?? 10n ** 24n);
await indexer.start();

// Firms that visitors launch. The server makes the two agent keys and keeps their private halves;
// the visitor's create_firm registers the public halves on the new firm account, and the swarm of that
// market adopts the firm once its account exists, running the house strategy the visitor picked. Devnet
// only: on a real network the owner runs its own agent with its own keys.
const pendingAgents = new Map<string, { tender: KeyPair; firm: KeyPair; strategy: Strategy }>(); // by tender public key
async function adopt(m: Market, firmId: number, firmAccount: string, owner: string) {
  for (let i = 0; i < 20; i++) {
    const r: any = await provider.query({ request_type: "view_access_key_list", account_id: firmAccount, finality: "optimistic" } as any).catch(() => null);
    const agent = (r?.keys ?? []).map((k: any) => pendingAgents.get(k.public_key)).find(Boolean);
    if (agent) {
      pendingAgents.delete(agent.tender.getPublicKey().toString());
      const handle: FirmHandle = {
        id: firmId,
        account: firmAccount,
        owner: account(owner, provider, KeyPair.fromRandom("ed25519")), // never signs: visitor firms do not bid on takeovers
        agentTender: account(firmAccount, provider, agent.tender),
        agentFirm: account(firmAccount, provider, agent.firm),
        strategy: agent.strategy,
      };
      m.firms.push(handle); // the swarm reads the same array
      log(`adopted visitor firm #${firmId} on ${m.symbol} ${agent.strategy.name} (${agent.strategy.author})`);
      return;
    }
    await sleep(1500);
  }
}
indexer.subscribe((e: ChainEvent) => {
  const m = marketOf(e.contract);
  if (!m || e.standard !== "tontine" || e.contract !== m.T) return;
  if (e.event === "firm_registered" && !m.firms.some((f) => f.id === e.data?.firm_id)) {
    void adopt(m, e.data.firm_id, e.data.account, e.data.owner);
  }
  // A house firm that bought an empty shell absorbs it: its owner closes it, so the firm leaves the
  // market instead of being liquidated and bought again every few epochs.
  if (e.event === "liquidated") {
    const buyer = m.firms.find((f) => f.id === e.data.buyer_firm_id);
    if (!buyer?.strategy.house) return;
    void (async () => {
      const treasury = BigInt(await view(provider, m.T, "balance_of", { account_id: (await view(provider, m.T, "get_firm", { firm_id: e.data.firm_id })).account }));
      if (treasury >= DEVNET_CONFIG.floor) return;
      await call(buyer.owner, m.T, "close_firm", { firm_id: e.data.firm_id }, 1n);
      log(`${buyer.strategy.name} closed the shell it bought (${m.symbol} firm #${e.data.firm_id})`);
    })().catch((err) => log(`absorb: ${(err as Error).message}`));
  }
});

// ------------------------------------------------------------------ payout keeper
// A fill or a refund credits the client in that market's tender ledger. The keeper moves it back to the
// client's NEAR Intents account, its single trading balance, with `withdraw_to_intents` (anyone may call it;
// firm accounts are refused, and skipped here). The relayer pays the gas; jobs are queued and retried.
const payouts = new Payouts(
  (tender, client) => call(devnet.relayer, tender, "withdraw_to_intents", { account_id: client }, 0n, TGAS(100)),
  async (tender, client) => (await view(provider, tender, "firm_id_of", { account_id: client })) !== null,
  (s) => log(s),
);
indexer.subscribe((e: ChainEvent) => {
  const m = marketOf(e.contract);
  if (!m || e.standard !== "tontine" || e.contract !== m.T) return;
  if (e.event === "order_refunded") payouts.push(m.T, e.data.client);
  // order_filled has no client field: the order has it.
  if (e.event === "order_filled")
    void view(provider, m.T, "get_order", { order_id: e.data.order_id }).then(
      (o: any) => payouts.push(m.T, o.client),
      (err) => log(`payouts: order ${e.data.order_id} on ${m.symbol}: ${(err as Error).message}`),
    );
});

// Watchdog: the devnet node was once OOM-killed while this process kept serving a site whose every chain read
// failed. If the node stops answering for about 2 minutes, exit: Docker restarts the container (a fresh devnet).
let nodeDown = 0;
setInterval(() => {
  provider.viewBlock({ finality: "optimistic" } as any).then(
    () => (nodeDown = 0),
    (e) => {
      if (++nodeDown < 4) return;
      log(`devnet node unreachable for 2 minutes (${(e as Error).message}): exiting so the container restarts`);
      process.exit(1);
    },
  );
}, 30_000).unref();

async function chainNow(): Promise<bigint> {
  const b: any = await provider.viewBlock({ finality: "optimistic" } as any);
  return BigInt(b.header.timestamp_nanosec ?? b.header.timestamp);
}

// ------------------------------------------------------------------ swarm loops, one set per market

async function ordersLoop(m: Market) {
  for (;;) {
    try {
      const fresh: any[] = await view(provider, m.T, "get_orders", { from: m.nextOrder, limit: 50 });
      m.nextOrder += fresh.length;
      const recent: any[] = await view(provider, m.T, "get_orders", { from: Math.max(0, m.nextOrder - 50), limit: 50 });
      const now = await chainNow();
      for (const o of recent) {
        if (o.status !== "Open" || m.running.has(o.id)) continue;
        const a = await view(provider, m.T, "get_auction", { auction_id: o.auction });
        if (BigInt(a.commit_end) > now) {
          m.running.add(o.id);
          // Auctions run concurrently; each account signs one transaction at a time (devnet.serialize).
          m.swarm
            .runOrder(o.id)
            .catch((e) => log(`${m.symbol} order ${o.id} failed: ${(e as Error).message}`))
            .finally(() => m.running.delete(o.id));
        } else if (BigInt(a.reveal_end) < now && !a.settled) {
          await call(m.firms[0].agentTender, m.T, "settle", { auction_id: o.auction }).catch(() => {});
        }
      }
    } catch (e) {
      log(`${m.symbol} orders loop: ${(e as Error).message}`);
    }
    await sleep(1000);
  }
}

// Managed firms (AI, rule or bandit) review their results and retune their quotes every few minutes.
async function managerLoop() {
  for (;;) {
    await sleep(Number(process.env.MANAGER_SECS ?? 180) * 1000);
    for (const m of markets)
      for (const f of m.firms.filter((x) => x.strategy.managed)) await m.swarm.manage(f).catch((e) => log(`manager ${f.strategy.name}: ${(e as Error).message}`));
  }
}

async function epochLoop(m: Market) {
  for (;;) {
    await sleep((DEVNET_CONFIG.epochSecs + 1) * 1000);
    try {
      await m.swarm.tick();
      const firms: any[] = await view(provider, m.T, "get_firms");
      for (const f of firms) {
        if (f.status !== "Liquidating" || f.liquidation_auction === null || m.liquidating.has(f.liquidation_auction)) continue;
        m.liquidating.add(f.liquidation_auction);
        if (!m.firms.some((h) => h.id === f.id)) continue;
        m.swarm.runLiquidation(f.id).catch((e) => log(`${m.symbol} liquidation ${f.id} failed: ${(e as Error).message}`));
      }
    } catch (e) {
      log(`${m.symbol} epoch loop: ${(e as Error).message}`);
    }
  }
}

// A house client keeps the markets busy: it visits them in turn and posts one order on a market with none
// open, buys and sells in turn, its minimum set at the market mid less the client tolerance (orders are
// labelled as house orders in the app).
let houseIndex = 0;
async function houseClientLoop() {
  await sleep(4000);
  for (;;) {
    const m = markets[houseIndex % markets.length];
    try {
      const recent: any[] = await view(provider, m.T, "get_orders", { from: Math.max(0, m.nextOrder - 10), limit: 10 });
      if (!recent.some((o) => o.status === "Open")) {
        const buy = Math.floor(houseIndex / markets.length) % 2 === 0;
        const side = buy ? "Buy" : "Sell";
        // Buys of 10 to 59 USDC; sells of 3 to 24 USD of the asset.
        const amountIn = buy ? USDC(10 + Math.floor(Math.random() * 50)) : units((3 + Math.floor(Math.random() * 22)) / (await m.mid()), m.decimals);
        const q = await reference(side, amountIn, -1, m.symbol);
        await devnet.deposit(
          devnet.houseClient,
          amountIn,
          { PostOrder: { side, amount_in: amountIn.toString(), min_out: q.out.toString(), reference_out: q.out.toString(), commit_secs: 8, reveal_secs: 6 } },
          buy ? "usdc" : m.token,
          m.T,
        );
        const paid = buy ? `${Number(amountIn) / 1e6} USDC` : `${(Number(amountIn) / Number(m.unit)).toFixed(4)} ${m.symbol}`;
        log(`house client posted a ${m.symbol} ${side} order (${paid}, at least the market reference, ${q.source})`);
      }
    } catch (e) {
      log(`house client ${m.symbol}: ${(e as Error).message}`);
    }
    houseIndex++;
    await sleep(HOUSE_CLIENT_SECS * 1000);
  }
}

for (const m of markets) {
  void ordersLoop(m);
  void epochLoop(m);
}
void managerLoop();
void houseClientLoop();

// ------------------------------------------------------------------ AI: regime guard, mandates, shadow quotes, due diligence

// The LLM reads the owners' intent and the news, and explains; every decision goes to one hash chain.
// Budget: the guard rates the news at most every 10 minutes per market (432 calls a day at most), mandates
// and reports share AI_DAILY_CAP, managers have LLM_DAILY_CAP (swarm.ts). Provider errors stay in this log.
const aiLlm = dailyCapped(quietErrors(llm, log), Number(process.env.AI_DAILY_CAP ?? 500));
const decisionLog = new DecisionLog();
for (const m of markets) m.swarm.decisionLog = decisionLog;

type RegimeView = Omit<GuardState, "source"> & { source: GuardState["source"] | "forced" };
const regimes = new Map<string, RegimeView>(markets.map((m) => [m.symbol, { level: "calm", since: Date.now(), reasons: [], source: "volatility" }]));

/** Dev only, off by default: GUARD_FORCE=storm forces every market, GUARD_FORCE=NEAR:storm,ETH:alert some of them. */
function forcedRegime(symbol: string): Regime | null {
  for (const part of (process.env.GUARD_FORCE ?? "").split(",")) {
    const [a, b] = part.trim().split(":");
    const level = b ?? a;
    if (Object.hasOwn(RANK, level) && (b === undefined || a.toUpperCase() === symbol)) return level as Regime;
  }
  return null;
}

/** One Guard per market every minute, on its mid history (8 days kept); the headlines, shared, every 10 minutes. */
async function guardLoop() {
  const guards = new Map(markets.map((m) => [m.symbol, new Guard(llm, m.symbol as AssetSymbol)]));
  // 5-minute closes (about 41 h), so the volatility baseline (24 h at least) holds from the start.
  for (const m of markets) {
    const c = await candles("5m", 500, m.symbol as AssetSymbol).catch(() => null);
    if (c && c.source !== "replay") m.swarm.series.push(...c.candles.map((k) => ({ t: k.time * 1000, mid: k.close })));
  }
  let headlines: Headline[] = [];
  let newsAt = 0;
  for (;;) {
    const now = Date.now();
    if (now - newsAt >= NEWS_EVERY_MS) [headlines, newsAt] = [await fetchHeadlines().catch(() => headlines), now];
    for (const m of markets) {
      try {
        const s = m.swarm.series;
        const mid = await marketMid(m.symbol as AssetSymbol).then((x) => x.mid, () => null);
        if (mid && (s.at(-1)?.t ?? 0) < now) s.push({ t: now, mid });
        while (s.length && s[0].t < now - 8 * 86_400_000) s.shift();
        const prev = regimes.get(m.symbol)!;
        const forced = forcedRegime(m.symbol);
        const next: RegimeView = forced
          ? { level: forced, since: prev.source === "forced" && prev.level === forced ? prev.since : now, reasons: ["forced by GUARD_FORCE (dev only)"], source: "forced" }
          : await guards.get(m.symbol)!.update(now, s, headlines);
        regimes.set(m.symbol, next);
        m.swarm.regime = next.level;
        if (next.level !== prev.level) {
          log(`guard ${m.symbol}: ${prev.level} -> ${next.level} (${next.source}: ${next.reasons[0] ?? ""})`);
          decisionLog.append({ kind: "regime", market: m.symbol, ...next });
        }
      } catch (e) {
        log(`guard ${m.symbol}: ${(e as Error).message}`);
      }
    }
    await sleep(60_000);
  }
}
void guardLoop();

// Each house owner publishes its firm's default mandate in its profile, as any owner does, then it is compiled.
void (async () => {
  for (const m of markets)
    for (const f of m.firms.filter((x) => x.strategy.house && HOUSE_MANDATES[x.strategy.name])) {
      const text = HOUSE_MANDATES[f.strategy.name];
      try {
        await call(f.owner, m.T, "set_firm_profile", { firm_id: f.id, profile: JSON.stringify({ ...f.strategy.spec, mandate: text }) }, 1n);
        await m.swarm.setMandate(aiLlm, f, text);
      } catch (e) {
        log(`house mandate ${m.symbol} ${f.strategy.name}: ${(e as Error).message}`);
      }
    }
})();

/** A firm's mandate as the API shows it: its text and compile, and its rules against the market now. */
async function mandateView(m: Market, f: FirmHandle) {
  const md = m.swarm.mandates.get(f.id);
  const [me, mk] = await Promise.all([m.swarm.ctx(f), m.swarm.market()]);
  return { text: md?.text ?? "", source: md?.source ?? "none", dropped: md?.dropped ?? [], compiledAt: md?.compiledAt ?? null, signed: !!md?.signature, regime: m.swarm.regime, ...m.swarm.mandateNow(f, me, mk.mid) };
}

/** Due-diligence reports per market and firm, kept 10 minutes (the LLM writes at most one per firm in that time). */
const reports = new Map<string, { at: number; body: Promise<unknown> }>();

// ------------------------------------------------------------------ cached state for the app

async function refreshState(m: Market) {
  try {
    const firms: any[] = await view(provider, m.T, "get_firms");
    const withMoney = await Promise.all(
      firms.map(async (f) => {
        const house = m.firms.find((h) => h.id === f.id);
        return {
          ...f,
          treasury: await view(provider, m.T, "balance_of", { account_id: f.account }),
          inventory: await view(provider, m.T, "asset_balance_of", { account_id: f.account }),
          nav: await view(provider, m.T, "nav_of", { firm_id: f.id }),
          ownerBond: await view(provider, m.T, "bond_of", { account_id: f.owner }),
          strategy: house ? { name: house.strategy.name, author: house.strategy.author, house: house.strategy.house } : null,
        };
      }),
    );
    const from = Math.max(0, m.nextOrder - 40);
    const orders: any[] = await view(provider, m.T, "get_orders", { from, limit: 40 });
    const withAuctions = await Promise.all(orders.map(async (o) => ({ ...o, auctionState: await view(provider, m.T, "get_auction", { auction_id: o.auction }) })));
    m.state = {
      firms: withMoney,
      orders: withAuctions.reverse(),
      totalOrders: m.nextOrder,
      lastPrice: await view(provider, m.T, "get_last_price"),
      reference: { mid: m.ref.mid, source: m.ref.source, sources: m.ref.sources, at: m.ref.at },
      params: Object.fromEntries(m.firms.map((f) => [f.id, m.swarm.paramsOf(f)])),
      chainTime: (await chainNow()).toString(),
      updatedAt: Date.now(),
    };
  } catch (e) {
    log(`${m.symbol} state: ${(e as Error).message}`);
  }
}
await Promise.all(markets.map(refreshState));
setInterval(() => markets.forEach(refreshState), 2000);

/** Stats of one market, or of all, with the dividends its firms paid and Tontine's revenue. */
function statsOf(m: Market | null) {
  const list = m ? [m] : markets;
  const base: Stats = m ? indexer.statsOf(m.T) : indexer.stats;
  const dividends = list.flatMap((x) => x.state.firms).reduce((a: bigint, f: any) => a + BigInt(f.dividends), 0n).toString();
  const sum = (k: "firms" | "totalOrders") => list.reduce((a, x) => a + (k === "firms" ? x.state.firms.length : (x.state.totalOrders ?? 0)), 0);
  return { ...base, dividends, firms: sum("firms"), totalOrders: sum("totalOrders") };
}

// The sandbox's RocksDB info log never rolls (about 140 MB an hour here) and nothing reads it: keep it
// small so the devnet can run for weeks. RocksDB keeps writing at its offset, so check allocated blocks.
const rocksLog = path.join(devnet.sandbox.homeDir, "data", "LOG");
setInterval(() => {
  try {
    if (statSync(rocksLog).blocks * 512 > 32 * 2 ** 20) truncateSync(rocksLog, 0);
  } catch {}
}, 60_000);

// ------------------------------------------------------------------ HTTP

const RPC_METHODS = new Set(["query", "block", "chunk", "tx", "EXPERIMENTAL_tx_status", "status", "gas_price", "send_tx", "broadcast_tx_commit", "broadcast_tx_async", "EXPERIMENTAL_receipt"]);
const limits = new Map<string, { n: number; reset: number }>();

function allow(ip: string, bucket: string, max: number, windowMs: number) {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const l = limits.get(key);
  if (!l || l.reset < now) {
    limits.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  return ++l.n <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, l] of limits) if (l.reset < now) limits.delete(k);
}, 600_000);

function ipOf(req: IncomingMessage) {
  const fwd = TRUST_PROXY ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
  return fwd || req.socket.remoteAddress || "?";
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, max = 256 * 1024): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

/** What the faucet gives, in whole tokens: { usdc: "100", wnear: "20", weth: "0.04", wsol: "1" }. */
const faucetBody = () => Object.fromEntries(Object.entries(FAUCET).map(([k, v]) => [k, String(v)]));

// ------------------------------------------------------------------ relay
// An EVM user's signed intent (one transfer to a tender with a PostOrder msg, ts/src/relay.ts) is submitted
// with `execute_intents` by the relayer, which pays the gas and 0.05 NEAR of tender storage when the 0x
// account has under 0.01 NEAR there. Abuse limits: 30 intents per IP per 10 minutes, one at a time per
// account, each signed intent once; orders under the tender's min_order refused before any gas; storage only
// for an intent that intents.near simulates (valid signature, unused nonce, enough balance), 0.3 NEAR per
// account at most, 3 deposits an hour per IP and 40 across the server (2 NEAR an hour at most).
const relayTargets: RelayTargets = {
  intents: devnet.intents,
  tenders: Object.fromEntries(markets.map((m) => [m.T, [devnet.token, m.assetToken]])),
  minOrder: Object.fromEntries(markets.map((m) => [m.T, BigInt(m.tenderConfig.min_order ?? 0)])),
};
const relayGate = new RelayGate();
// The relayer also signs the payout keeper's calls: on the devnet, root tops it up when it falls under 50 NEAR.
setInterval(
  () =>
    devnet.fundRelayer().then(
      (sent) => sent > 0n && log(`warning: the relayer fell under 50 NEAR, root sent it ${Number(sent / 10n ** 21n) / 1000} NEAR`),
      (e) => log(`relayer top-up: ${(e as Error).message}`),
    ),
  60_000,
);
const EVM_FAUCET_USDC = 100;

const candleCache = new Map<string, { at: number; body: unknown }>();
const sseClients = new Set<ServerResponse>();
indexer.subscribe((e: ChainEvent) => {
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of sseClients) res.write(line);
});
setInterval(() => {
  for (const res of sseClients) res.write(": ping\n\n");
}, 20000);

function thesis() {
  const read = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
  const predPath = path.join(ROOT, "thesis", "predictions.json");
  return {
    result: read(path.join(ROOT, "thesis", "result.json")),
    predictions: read(predPath),
    predictionsSha256: existsSync(predPath) ? createHash("sha256").update(readFileSync(predPath)).digest("hex") : null,
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const clean = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = path.join(DIST, clean);
  if (!file.startsWith(DIST)) return json(res, 403, { error: "forbidden" });
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(DIST, "index.html"); // SPA routes
  if (!existsSync(file)) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    return res.end("The app is not built yet: run `make app` (or `cd app && npm run build`).");
  }
  const ext = path.extname(file);
  let body: Buffer | string = readFileSync(file);
  if (file === path.join(DIST, "index.html")) {
    // Link previews: crawlers do not run the app, so each page's title and Open Graph tags are written here.
    const proto = TRUST_PROXY ? String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0].trim() : "http";
    const m = bySymbol(url.searchParams.get("market")) ?? NEAR_MARKET;
    const meta = pageMeta(url.pathname, { state: m.state, stats: statsOf(null), thesis: thesis(), asset: { symbol: m.symbol, decimals: m.decimals } });
    body = withMeta(body.toString(), meta, `${proto}://${req.headers.host ?? `${HOST}:${PORT}`}`, url.pathname);
  }
  res.writeHead(200, {
    "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "Cache-Control": file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const ip = ipOf(req);
  try {
    if (url.pathname === "/rpc" && req.method === "POST") {
      if (!allow(ip, "rpc", 600, 60_000)) return json(res, 429, { error: "slow down" });
      const body = await readBody(req);
      if (!RPC_METHODS.has(body?.method)) return json(res, 403, { jsonrpc: "2.0", id: body?.id ?? null, error: { message: "method not allowed" } });
      const r = await fetch(devnet.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      res.writeHead(r.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(await r.text());
    }
    if (url.pathname === "/api/config") {
      const firmsOf = (m: Market) =>
        m.firms.map((f) => ({ id: f.id, account: f.account, owner: f.owner.accountId, strategy: f.strategy.name, author: f.strategy.author, house: f.strategy.house, managed: !!f.strategy.managed }));
      return json(res, 200, {
        network: "devnet",
        networkLabel: "Tontine devnet (NEAR sandbox, protocol 86)",
        rpc: "/rpc",
        tender: NEAR_MARKET.T,
        usdc: devnet.usdc.accountId,
        wnear: devnet.wnear.accountId,
        intents: devnet.intents,
        token: devnet.token,
        assetToken: devnet.assetToken,
        houseClient: devnet.houseClient.accountId,
        tenderConfig: NEAR_MARKET.tenderConfig,
        firms: firmsOf(NEAR_MARKET),
        templates: devnet.strategies.map((s, i) => ({ index: i, name: s.name, llm: s.managed === true })),
        inferenceCost: INFERENCE_COST.toString(),
        // Every market: one tender each, its mock asset token (wallet), its intents.near token id.
        markets: markets.map((m) => ({
          symbol: m.symbol,
          tender: m.T,
          ft: m.ft.accountId,
          assetToken: m.assetToken,
          decimals: m.decimals,
          color: m.color,
          faucet: FAUCET[m.token],
          tenderConfig: m.tenderConfig,
          firms: firmsOf(m),
        })),
      });
    }
    // Per market, NEAR when `market` is absent.
    const market = bySymbol(url.searchParams.get("market"));
    if (url.pathname.startsWith("/api/") && !market) return json(res, 400, { error: `market: ${markets.map((m) => m.symbol).join(", ")}` });
    const m = market!;
    if (url.pathname === "/api/state")
      return json(res, 200, { ...m.state, regime: regimes.get(m.symbol), firms: (m.state.firms ?? []).map((f: any) => ({ ...f, weathered: m.swarm.weathered.get(f.id) ?? 0 })) });
    // Across every market unless `market` is given.
    if (url.pathname === "/api/stats") return json(res, 200, statsOf(url.searchParams.has("market") ? m : null));
    if (url.pathname === "/api/decisions") return json(res, 200, markets.flatMap((x) => x.swarm.decisions.slice(-50)).sort((a, b) => b.at - a.at).slice(0, 50));
    // AI endpoints: mandates, shadow quotes, the decision log, due diligence (see the AI section).
    const firmId = /^\d{1,9}$/.test(url.searchParams.get("firmId") ?? "") ? Number(url.searchParams.get("firmId")) : null;
    const run = m.firms.find((f) => f.id === firmId);
    if (url.pathname === "/api/mandate" && req.method === "POST") {
      if (!allow(ip, "mandate", 10, 3_600_000)) return json(res, 429, { error: "Too many mandate changes from this address, try again in an hour." });
      const body = await readBody(req, 4096);
      const mk = bySymbol(typeof body.market === "string" ? body.market : null);
      const f = mk?.firms.find((x) => x.id === Number(body.firmId));
      if (!mk || !f || typeof body.text !== "string" || body.text.length > MAX_TEXT)
        return json(res, 400, { error: `market, firmId of a firm this devnet runs, and text of at most ${MAX_TEXT} characters` });
      // Only the owner may write the firm's profile (set_firm_profile): what is compiled is what it published there.
      let published = "";
      try {
        const p = JSON.parse((await view(provider, mk.T, "get_firm", { firm_id: f.id })).profile ?? "{}");
        if (typeof p.mandate === "string") published = p.mandate;
      } catch {}
      if (published.trim() !== body.text.trim()) return json(res, 403, { error: "Publish this mandate in the firm's profile first: set_firm_profile, which only its owner can call." });
      await mk.swarm.setMandate(aiLlm, f, published);
      return json(res, 200, await mandateView(mk, f));
    }
    if (url.pathname === "/api/mandate") {
      if (!allow(ip, "mandate-get", 120, 60_000)) return json(res, 429, { error: "slow down" });
      // null for a firm this devnet does not run (its owner runs the agent): no mandate to enforce here.
      return json(res, 200, run ? await mandateView(m, run) : null);
    }
    if (url.pathname === "/api/shadow") {
      if (!run) return json(res, 200, null);
      const s = m.swarm.shadow.summary(run.id);
      const manager = run.strategy.managed === true ? (llm.live ? "llm" : "rule") : (run.strategy.managed || "none");
      return json(res, 200, { manager, arms: Object.fromEntries(ARMS.map((k) => [k, { ...s[k], delivered: s[k].delivered.toString(), edge: s[k].edge.toString() }])) });
    }
    if (url.pathname === "/api/log") {
      if (!allow(ip, "log", 30, 60_000)) return json(res, 429, { error: "slow down" });
      const day = url.searchParams.get("day") || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(res, 400, { error: "day: YYYY-MM-DD (UTC)" });
      const from = Math.max(0, Number(url.searchParams.get("from")) || 0);
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit")) || 500));
      // In memory: the last 7 days (shadow.ts); older days keep their root.
      const entries = decisionLog.day(day);
      return json(res, 200, { day, total: entries.length, root: decisionLog.merkleRoot(day), entries: entries.slice(from, from + limit) });
    }
    if (url.pathname === "/api/report") {
      if (!allow(ip, "report", 30, 60_000)) return json(res, 429, { error: "slow down" });
      const f = m.state.firms.find((x: any) => x.id === firmId);
      if (!f) return json(res, 404, { error: "firmId: a firm of this market" });
      const key = `${m.symbol}:${f.id}`;
      const hit = reports.get(key);
      if (!hit || Date.now() - hit.at > 600_000) {
        const facts = factsFromFirm(f, Number(m.tenderConfig.treasury_floor) / 1e6);
        const score = firmScore(facts);
        // The LLM writes only for firms this server runs; anyone can register a firm, so the others get the template.
        const writer = m.firms.some((h) => h.id === f.id) ? aiLlm : null;
        reports.set(key, { at: Date.now(), body: reportProse(writer, facts, score).then((r) => ({ ...score, ...r, at: Date.now() })) });
      }
      return json(res, 200, await reports.get(key)!.body);
    }
    if (url.pathname === "/api/candles") {
      // Candles for the trade chart (Binance, Coinbase, or the replay), cached 30 s per market and interval.
      if (!allow(ip, "candles", 60, 60_000)) return json(res, 429, { error: "slow down" });
      const interval = url.searchParams.get("interval") ?? "5m";
      if (!INTERVALS[interval]) return json(res, 400, { error: `interval: ${Object.keys(INTERVALS).join(", ")}` });
      const limit = Math.min(500, Math.max(10, Number(url.searchParams.get("limit") ?? 300) || 300));
      const key = `${m.symbol}:${interval}:${limit}`;
      const hit = candleCache.get(key);
      if (!hit || Date.now() - hit.at > 30_000) candleCache.set(key, { at: Date.now(), body: await candles(interval, limit, m.symbol as AssetSymbol) });
      return json(res, 200, candleCache.get(key)!.body);
    }
    if (url.pathname === "/api/quote") {
      // The market reference for an order (mid less the client tolerance): the client's minimum. Live, or the replay when offline.
      if (!allow(ip, "quote", 60, 60_000)) return json(res, 429, { error: "slow down" });
      const side = url.searchParams.get("side");
      const amount = url.searchParams.get("amount") ?? "";
      if ((side !== "Buy" && side !== "Sell") || !/^[1-9][0-9]{0,30}$/.test(amount)) return json(res, 400, { error: "side=Buy|Sell&amount=<base units>" });
      const q = await reference(side, BigInt(amount), -1, m.symbol);
      return json(res, 200, { out: q.out.toString(), mid: q.mid, source: q.source, sources: q.sources });
    }
    if (url.pathname === "/api/events") {
      const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 100));
      return json(res, 200, indexer.events.slice(-limit));
    }
    if (url.pathname === "/api/thesis") return json(res, 200, thesis());
    if (url.pathname === "/api/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write("retry: 3000\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (url.pathname === "/api/account" && req.method === "POST") {
      if (!allow(ip, "account", 5, 3_600_000)) return json(res, 429, { error: "Too many demo accounts from this address, try again in an hour." });
      const { publicKey } = await readBody(req, 4096);
      if (typeof publicKey !== "string" || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(publicKey)) return json(res, 400, { error: "publicKey must be an ed25519 public key" });
      const accountId = await devnet.createVisitor(publicKey);
      log(`visitor account ${accountId}`);
      return json(res, 200, { accountId, near: "5", ...faucetBody() });
    }
    if (url.pathname === "/api/agent" && req.method === "POST") {
      if (!allow(ip, "agent", 5, 3_600_000)) return json(res, 429, { error: "Too many firms from this address, try again in an hour." });
      const { name, strategy } = await readBody(req, 4096);
      const template = devnet.strategies[Number(strategy)];
      if (typeof name !== "string" || !/^[A-Za-z0-9 &.'-]{2,32}$/.test(name.trim()) || !template) return json(res, 400, { error: "name: 2 to 32 letters, digits, spaces or & . ' -; strategy: a template index" });
      const keys = { tender: KeyPair.fromRandom("ed25519"), firm: KeyPair.fromRandom("ed25519") };
      // House strategy, visitor's name; no takeover bids, which the owner would have to sign itself.
      const s: Strategy = { ...template, name: name.trim(), author: "visitor", house: false, takeover: undefined };
      pendingAgents.set(keys.tender.getPublicKey().toString(), { ...keys, strategy: s });
      return json(res, 200, { agentKeys: [keys.tender.getPublicKey().toString(), keys.firm.getPublicKey().toString()] });
    }
    if (url.pathname === "/api/faucet" && req.method === "POST") {
      if (!allow(ip, "faucet", 10, 3_600_000)) return json(res, 429, { error: "Faucet limit reached for this address, try again in an hour." });
      const { accountId } = await readBody(req, 4096);
      // An Ethereum account gets test USDC in NEAR Intents: a simulated Base deposit (on mainnet, 1Click or the bridge).
      if (typeof accountId === "string" && /^0x[0-9a-f]{40}$/.test(accountId)) {
        await devnet.credit(accountId, USDC(EVM_FAUCET_USDC));
        return json(res, 200, { accountId, usdc: String(EVM_FAUCET_USDC), source: "simulated Base deposit" });
      }
      if (typeof accountId !== "string" || !/^v[a-z0-9]+\.sandbox$/.test(accountId)) return json(res, 400, { error: "only demo accounts and 0x accounts can use the faucet" });
      await devnet.drip(accountId);
      return json(res, 200, { accountId, ...faucetBody() });
    }
    if (url.pathname === "/api/relay" && req.method === "POST") {
      if (!allow(ip, "relay", 30, 600_000)) return json(res, 429, { error: "Too many intents from this address, try again in a few minutes." });
      const { signed } = await readBody(req, 8192);
      try {
        const order = checkRelay(signed, relayTargets);
        const budget = () => allow(ip, "relay-storage-ip", 3, 3_600_000) && allow("server", "relay-storage", 40, 3_600_000);
        const r = await relayGate.run(signed, order.signer, () =>
          submitRelay(devnet.relayer, provider, devnet.intents, signed, order, () => relayGate.fundStorage(order.signer, budget)),
        );
        log(`relay: ${order.signer} posted order #${r.orderId} on ${marketOf(order.tender)?.symbol}${r.storagePaid ? " (storage paid)" : ""}`);
        return json(res, 200, { txHash: r.txHash, orderId: r.orderId, events: r.events });
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
    }
    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
    return serveStatic(req, res);
  } catch (e) {
    log(`http ${url.pathname}: ${(e as Error).message}`);
    if (!res.headersSent) json(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, HOST, () => log(`Tontine app on http://${HOST}:${PORT}`));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log("shutting down");
    // While the swarm loops keep calling its RPC, neard does not exit on SIGTERM and sandbox.tearDown() never
    // returns (seen on 2.13.4). The devnet is thrown away anyway: kill it and delete its data.
    (devnet.sandbox as any).childProcess.kill("SIGKILL");
    rmSync(devnet.sandbox.homeDir, { recursive: true, force: true });
    process.exit(0);
  });
}
