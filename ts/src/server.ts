// The hosted Tontine app in one process: a NEAR devnet with the contracts, the house swarm running for
// real (sealed quotes, fills, an AI manager, epochs, liquidations), a house client that keeps posting
// NEAR/USDC orders at the NEAR Intents 1Click price, a chain indexer, the JSON API, a filtered RPC proxy
// for visitors' wallets, and the website itself.
//
//   npx tsx src/server.ts          (PORT=8080 HOST=127.0.0.1 by default; see README "Run the app")
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, truncateSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";
import { account, call, sleep, view, USDC } from "./chain.ts";
import { DEVNET_CONFIG, NEAR_, startDevnet, type Devnet } from "./devnet.ts";
import { Indexer, type ChainEvent } from "./indexer.ts";
import { pageMeta, withMeta } from "./meta.ts";
import { makeLlm } from "./llm.ts";
import { candles, INTERVALS, reference, type Reference } from "./prices.ts";
import { Swarm, type FirmHandle } from "./swarm.ts";
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
const T = devnet.tender.accountId;
// The reference mid firms quote from: NEAR Intents 1Click, refreshed at most every 30 s.
let ref: Reference & { at: number } = { ...(await reference("Buy", USDC(100))), at: Date.now() };
async function mid(): Promise<number> {
  if (Date.now() - ref.at > 30_000) ref = { ...(await reference("Buy", USDC(100))), at: Date.now() };
  return ref.mid;
}
const swarm = new Swarm(provider, T, devnet.firms, makeLlm(), devnet.inference, mid, (s) => log(`swarm ${s.trim()}`));

const watched = new Set([T, ...devnet.firms.map((f) => f.account)]);
const indexer = new Indexer(devnet.rpcUrl, (c) => watched.has(c) || c.endsWith(`.${T}`));
await indexer.start();

// Firms that visitors launch. The server makes the two agent keys and keeps their private halves;
// the visitor's create_firm registers the public halves on the new firm account, and the swarm adopts
// the firm once its account exists, running the house strategy the visitor picked. Devnet only: on a
// real network the owner runs its own agent with its own keys.
const pendingAgents = new Map<string, { tender: KeyPair; firm: KeyPair; strategy: Strategy }>(); // by tender public key
async function adopt(firmId: number, firmAccount: string, owner: string) {
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
      devnet.firms.push(handle); // the swarm reads the same array
      watched.add(firmAccount);
      log(`adopted visitor firm #${firmId} ${agent.strategy.name} (${agent.strategy.author})`);
      return;
    }
    await sleep(1500);
  }
}
indexer.subscribe((e: ChainEvent) => {
  if (e.standard === "tontine" && e.event === "firm_registered" && !devnet.firms.some((f) => f.id === e.data?.firm_id)) {
    void adopt(e.data.firm_id, e.data.account, e.data.owner);
  }
  // A house firm that bought an empty shell absorbs it: its owner closes it, so the firm leaves the
  // market instead of being liquidated and bought again every few epochs.
  if (e.standard === "tontine" && e.event === "liquidated") {
    const buyer = devnet.firms.find((f) => f.id === e.data.buyer_firm_id);
    if (!buyer?.strategy.house) return;
    void (async () => {
      const treasury = BigInt(await view(provider, T, "balance_of", { account_id: (await view(provider, T, "get_firm", { firm_id: e.data.firm_id })).account }));
      if (treasury >= DEVNET_CONFIG.floor) return;
      await call(buyer.owner, T, "close_firm", { firm_id: e.data.firm_id }, 1n);
      log(`${buyer.strategy.name} closed the shell it bought (firm #${e.data.firm_id})`);
    })().catch((err) => log(`absorb: ${(err as Error).message}`));
  }
});

async function chainNow(): Promise<bigint> {
  const b: any = await provider.viewBlock({ finality: "optimistic" } as any);
  return BigInt(b.header.timestamp_nanosec ?? b.header.timestamp);
}

// ------------------------------------------------------------------ swarm loops

const running = new Set<number>();
let nextOrder = 0;
async function ordersLoop() {
  for (;;) {
    try {
      const fresh: any[] = await view(provider, T, "get_orders", { from: nextOrder, limit: 50 });
      nextOrder += fresh.length;
      const recent: any[] = await view(provider, T, "get_orders", { from: Math.max(0, nextOrder - 50), limit: 50 });
      const now = await chainNow();
      for (const o of recent) {
        if (o.status !== "Open" || running.has(o.id)) continue;
        const a = await view(provider, T, "get_auction", { auction_id: o.auction });
        if (BigInt(a.commit_end) > now) {
          running.add(o.id);
          // Auctions run concurrently; each account signs one transaction at a time (devnet.serialize).
          swarm
            .runOrder(o.id)
            .catch((e) => log(`order ${o.id} failed: ${(e as Error).message}`))
            .finally(() => running.delete(o.id));
        } else if (BigInt(a.reveal_end) < now && !a.settled) {
          await call(devnet.firms[0].agentTender, T, "settle", { auction_id: o.auction }).catch(() => {});
        }
      }
    } catch (e) {
      log(`orders loop: ${(e as Error).message}`);
    }
    await sleep(1000);
  }
}

// Managed firms (AI or rule) review their results and retune their quotes every few minutes.
async function managerLoop() {
  for (;;) {
    await sleep(Number(process.env.MANAGER_SECS ?? 180) * 1000);
    for (const f of devnet.firms.filter((x) => x.strategy.managed)) await swarm.manage(f).catch((e) => log(`manager ${f.strategy.name}: ${(e as Error).message}`));
  }
}

const liquidating = new Set<number>();
async function epochLoop() {
  for (;;) {
    await sleep((DEVNET_CONFIG.epochSecs + 1) * 1000);
    try {
      await swarm.tick();
      const firms: any[] = await view(provider, T, "get_firms");
      for (const f of firms) {
        if (f.status !== "Liquidating" || f.liquidation_auction === null || liquidating.has(f.liquidation_auction)) continue;
        liquidating.add(f.liquidation_auction);
        if (!devnet.firms.some((h) => h.id === f.id)) continue;
        swarm.runLiquidation(f.id).catch((e) => log(`liquidation ${f.id} failed: ${(e as Error).message}`));
      }
    } catch (e) {
      log(`epoch loop: ${(e as Error).message}`);
    }
  }
}

// A house client keeps the market busy: one order whenever none is open, buys and sells in turn, its
// minimum set at what NEAR Intents 1Click would give (orders are labelled as house orders in the app).
let houseIndex = 0;
async function houseClientLoop() {
  await sleep(4000);
  for (;;) {
    try {
      const recent: any[] = await view(provider, T, "get_orders", { from: Math.max(0, nextOrder - 10), limit: 10 });
      if (!recent.some((o) => o.status === "Open")) {
        const buy = houseIndex++ % 2 === 0;
        const side = buy ? "Buy" : "Sell";
        const amountIn = buy ? USDC(10 + Math.floor(Math.random() * 50)) : NEAR_(1 + Math.floor(Math.random() * 10));
        const q = await reference(side, amountIn);
        await devnet.deposit(
          devnet.houseClient,
          amountIn,
          { PostOrder: { side, amount_in: amountIn.toString(), min_out: q.out.toString(), reference_out: q.out.toString(), commit_secs: 8, reveal_secs: 6 } },
          buy ? "usdc" : "wnear",
        );
        log(`house client posted a ${side} order (${buy ? `${Number(amountIn) / 1e6} USDC` : `${Number(amountIn) / 1e24} NEAR`}, at least the 1Click quote, ${q.source})`);
      }
    } catch (e) {
      log(`house client: ${(e as Error).message}`);
    }
    await sleep(HOUSE_CLIENT_SECS * 1000);
  }
}

void ordersLoop();
void epochLoop();
void managerLoop();
void houseClientLoop();

// ------------------------------------------------------------------ cached state for the app

const tenderConfig = await view(provider, T, "get_config");
let state: any = { firms: [], orders: [], updatedAt: 0 };
async function refreshState() {
  try {
    const firms: any[] = await view(provider, T, "get_firms");
    const withMoney = await Promise.all(
      firms.map(async (f) => {
        const house = devnet.firms.find((h) => h.id === f.id);
        return {
          ...f,
          treasury: await view(provider, T, "balance_of", { account_id: f.account }),
          inventory: await view(provider, T, "asset_balance_of", { account_id: f.account }),
          nav: await view(provider, T, "nav_of", { firm_id: f.id }),
          ownerBond: await view(provider, T, "bond_of", { account_id: f.owner }),
          strategy: house ? { name: house.strategy.name, author: house.strategy.author, house: house.strategy.house } : null,
        };
      }),
    );
    const from = Math.max(0, nextOrder - 40);
    const orders: any[] = await view(provider, T, "get_orders", { from, limit: 40 });
    const withAuctions = await Promise.all(orders.map(async (o) => ({ ...o, auctionState: await view(provider, T, "get_auction", { auction_id: o.auction }) })));
    state = {
      firms: withMoney,
      orders: withAuctions.reverse(),
      totalOrders: nextOrder,
      lastPrice: await view(provider, T, "get_last_price"),
      reference: { mid: ref.mid, source: ref.source, at: ref.at },
      params: Object.fromEntries(devnet.firms.map((f) => [f.id, swarm.paramsOf(f)])),
      chainTime: (await chainNow()).toString(),
      updatedAt: Date.now(),
    };
  } catch (e) {
    log(`state: ${(e as Error).message}`);
  }
}
await refreshState();
setInterval(refreshState, 2000);

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
    const meta = pageMeta(url.pathname, { state, stats: indexer.stats, thesis: thesis() });
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
      return json(res, 200, {
        network: "devnet",
        networkLabel: "Tontine devnet (NEAR sandbox, protocol 86)",
        rpc: "/rpc",
        tender: T,
        usdc: devnet.usdc.accountId,
        wnear: devnet.wnear.accountId,
        intents: devnet.intents,
        token: devnet.token,
        assetToken: devnet.assetToken,
        houseClient: devnet.houseClient.accountId,
        tenderConfig,
        firms: devnet.firms.map((f) => ({ id: f.id, account: f.account, owner: f.owner.accountId, strategy: f.strategy.name, author: f.strategy.author, house: f.strategy.house, managed: !!f.strategy.managed })),
        templates: devnet.strategies.map((s, i) => ({ index: i, name: s.name })),
      });
    }
    if (url.pathname === "/api/state") return json(res, 200, state);
    if (url.pathname === "/api/stats") {
      const dividends = state.firms.reduce((a: bigint, f: any) => a + BigInt(f.dividends), 0n).toString();
      return json(res, 200, { ...indexer.stats, dividends, firms: state.firms.length, totalOrders: state.totalOrders ?? 0 });
    }
    if (url.pathname === "/api/decisions") return json(res, 200, swarm.decisions.slice(-50).reverse());
    if (url.pathname === "/api/candles") {
      // NEAR candles for the trade chart (Binance, Coinbase, or the replay), cached 30 s per interval.
      if (!allow(ip, "candles", 60, 60_000)) return json(res, 429, { error: "slow down" });
      const interval = url.searchParams.get("interval") ?? "5m";
      if (!INTERVALS[interval]) return json(res, 400, { error: `interval: ${Object.keys(INTERVALS).join(", ")}` });
      const limit = Math.min(500, Math.max(10, Number(url.searchParams.get("limit") ?? 300) || 300));
      const key = `${interval}:${limit}`;
      const hit = candleCache.get(key);
      if (!hit || Date.now() - hit.at > 30_000) candleCache.set(key, { at: Date.now(), body: await candles(interval, limit) });
      return json(res, 200, candleCache.get(key)!.body);
    }
    if (url.pathname === "/api/quote") {
      // What NEAR Intents 1Click gives for an order: the client's minimum. Live, or the replay when offline.
      if (!allow(ip, "quote", 60, 60_000)) return json(res, 429, { error: "slow down" });
      const side = url.searchParams.get("side");
      const amount = url.searchParams.get("amount") ?? "";
      if ((side !== "Buy" && side !== "Sell") || !/^[1-9][0-9]{0,30}$/.test(amount)) return json(res, 400, { error: "side=Buy|Sell&amount=<base units>" });
      const q = await reference(side, BigInt(amount));
      return json(res, 200, { out: q.out.toString(), mid: q.mid, source: q.source });
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
      return json(res, 200, { accountId, near: "5", usdc: "100", wnear: "20" });
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
      if (typeof accountId !== "string" || !/^v[a-z0-9]+\.sandbox$/.test(accountId)) return json(res, 400, { error: "only demo accounts can use the faucet" });
      await devnet.mint(accountId, USDC(100));
      await devnet.mint(accountId, NEAR_(20), "wnear");
      return json(res, 200, { accountId, usdc: "100", wnear: "20" });
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
