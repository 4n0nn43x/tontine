import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CandleChart, type Fill } from "../components/Chart";
import { BalanceRows, ChainFunds, InMarkets, MoveFunds, plain, type Move, type TokenKey } from "../components/Funds";
import { ConnectWallet } from "../components/Wallets";
import { Badge, Card, Countdown, Empty, FirmChip, MarketTabs, Modal, Tabs, TxButton } from "../components/ui";
import { getCandles, getQuote, type AppState, type Candle, type ChainEvent, type Config, type MarketSource, type MarketSymbol, type Quote, type Side } from "../lib/api";
import { amount, bpOver, bpText, clientOut, digitsOf, gotText, paidText, priceOf, toBase, usd, usdc, wrapped, type Asset } from "../lib/format";
import { announceTx, inMarket, useAppState, useBalances, useChainNow, useConfig, useEvents, useFirmName, useMarket, useWallet } from "../lib/hooks";
import { createWallet, postOrder, type Balances, type Wallet } from "../lib/near";

const COMMIT_SECS = 8;
const REVEAL_SECS = 6;
const STEPS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 };
const candleSource = (src: Candles["source"], s: string) => ({ binance: `Binance ${s}/USDT`, coinbase: `Coinbase ${s}/USD`, replay: `replayed ${s} prices (offline)` })[src];
/** A sell's default size: about 10 to 20 USD of the asset. */
const SELL_DEFAULT: Record<string, string> = { NEAR: "5", ETH: "0.005", SOL: "0.1" };
const VENUE: Record<string, string> = { binance: "Binance", okx: "OKX", coinbase: "Coinbase" };

type Candles = { source: "binance" | "coinbase" | "replay"; candles: Candle[] };

/** Where the reference comes from: "Market mid, median of Binance, OKX, Coinbase", or the replay. */
export function referenceText(r: { source: string; sources?: MarketSource[] } | undefined): string {
  if (!r) return "";
  if (r.source !== "market") return "Replayed price: the venues are unreachable";
  const names = (r.sources ?? []).map((s) => VENUE[s.name] ?? s.name);
  return names.length > 1 ? `Market mid, median of ${names.join(", ")}` : `Market mid, ${names[0] ?? "live"}`;
}

/** Candles for one market and interval, refreshed every 30 s (the server caches them as long). */
function useCandles(interval: string, limit: number, market: string): { data: Candles | null; error: boolean } {
  const [data, setData] = useState<Candles | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    setData(null);
    const load = () =>
      getCandles(interval, limit, market).then(
        (d) => alive && (setData(d), setError(false)),
        () => alive && setError(true),
      );
    void load();
    const t = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [interval, limit, market]);
  return { data, error };
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB");

export function Trade() {
  const { symbol, asset, market, select } = useMarket();
  const { data: state } = useAppState(symbol);
  const wallet = useWallet();
  const bal = useBalances(wallet?.accountId);
  const config = useConfig();
  const name = useFirmName(state);
  // A fill or a refund, then its payout to the trading balance, move balances: refresh them as soon as the stream says so.
  const events = useEvents(500, (e) => ["order_filled", "order_refunded", "withdraw"].includes(e.event) && announceTx());
  const [interval, setIv] = useState("5m");
  const chart = useCandles(interval, 300, symbol);
  const day = useCandles("1h", 24, symbol);
  const [tab, setTab] = useState<"trades" | "mine" | "balances">("trades");
  const [funds, setFunds] = useState<{ move: Move; token: TokenKey } | null>(null);

  const fills = useMemo(() => events.filter((e) => e.standard === "tontine" && e.event === "order_filled" && e.contract === market?.tender), [events, market?.tender]);
  const marks = useMemo<Fill[]>(() => fills.map((e) => ({ time: e.time / 1000, side: e.data.side })), [fills]);
  const mid = state?.reference.mid;

  return (
    <div className="trade">
      <MarketBar state={state} day={day.data} config={config} symbol={symbol} onSelect={select} />

      <Card
        className="trade-chart"
        title={`${symbol} / USDC`}
        action={
          <div className="intervals" role="radiogroup" aria-label="Candle interval">
            {Object.keys(STEPS).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={interval === k} className={interval === k ? "on" : ""} onClick={() => setIv(k)}>
                {k}
              </button>
            ))}
          </div>
        }
      >
        <CandleChart
          candles={chart.data?.candles ?? []}
          step={STEPS[interval]}
          fills={marks}
          line={mid ? { price: mid, title: "Market mid" } : undefined}
          fitKey={`${symbol}:${interval}`}
          empty={chart.error ? "Candles are unavailable right now." : "Loading candles…"}
        />
        <p className="chart-legend">
          <span>Candles: {chart.data ? candleSource(chart.data.source, symbol) : "…"}</span>
          <span>
            <i className="fa-solid fa-caret-up gain" aria-hidden="true" /> Tontine buy fill
          </span>
          <span>
            <i className="fa-solid fa-caret-down loss" aria-hidden="true" /> Tontine sell fill
          </span>
          <span>
            <span className="dash" aria-hidden="true" /> Market mid
          </span>
        </p>
      </Card>

      <Ticket key={symbol} symbol={symbol} asset={asset} wallet={wallet} bal={bal} config={config} state={state} onFunds={(move, token) => setFunds({ move, token })} />

      <Book state={state} name={name} symbol={symbol} />

      <Card className="trade-tabs">
        <Tabs
          tabs={[
            ["trades", "Market trades"],
            ["mine", "My orders"],
            ["balances", "Balances"],
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === "trades" ? (
          <Tape fills={fills} name={name} asset={asset} />
        ) : tab === "mine" ? (
          <MyOrders state={state} wallet={wallet} asset={asset} />
        ) : (
          <BalanceTable bal={bal} wallet={wallet} symbol={symbol} onFunds={(move) => setFunds({ move, token: "USDC" })} />
        )}
      </Card>

      <details className="card trade-how">
        <summary>How it works</summary>
        <ol className="steps">
          <li>
            An order pays from your trading balance in NEAR Intents, in one transfer to the {symbol} market (<code>mt_transfer_call</code>, or an intent your wallet signs). If it is short, the difference comes from your wallet first.
          </li>
          <li>
            Firms seal their quotes for {COMMIT_SECS} s, reveal them for {REVEAL_SECS} s, then a settle fills you at the second-best quote, never under your minimum, or refunds you.
          </li>
          <li>What you receive, or a refund, is back in your trading balance within seconds (a keeper calls <code>withdraw_to_intents</code>). Withdraw it to your wallet any time.</li>
        </ol>
      </details>

      <Modal open={!!funds} onClose={() => setFunds(null)} title="Trading balance">
        {wallet && funds && (wallet.chain ? <ChainFunds wallet={wallet} /> : <MoveFunds wallet={wallet} bal={bal} move={funds.move} token={funds.token} onDone={() => setFunds(null)} />)}
      </Modal>
    </div>
  );
}

function MarketBar({ state, day, config, symbol, onSelect }: { state: AppState | null; day: Candles | null; config: Config | null; symbol: MarketSymbol; onSelect: (s: MarketSymbol) => void }) {
  const c = day?.candles ?? [];
  const open = c[0]?.open;
  const last = c.at(-1)?.close;
  const change = open && last ? ((last - open) / open) * 100 : null;
  return (
    <div className="trade-bar">
      <MarketTabs value={symbol} onChange={onSelect} />
      <span className="pair">{symbol} / USDC</span>
      <div className="bar-stat">
        <span>Price</span>
        <span className="bar-price">{state ? usd(state.reference.mid) : "…"}</span>
        <span className="bar-src">{referenceText(state?.reference)}</span>
      </div>
      <div className="bar-stat">
        <span>24h change</span>
        <span className={change === null ? "" : change >= 0 ? "gain" : "loss"}>{change === null ? "…" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}</span>
      </div>
      <div className="bar-stat">
        <span>24h high</span>
        <span>{c.length ? usd(Math.max(...c.map((k) => k.high))) : "…"}</span>
      </div>
      <div className="bar-stat">
        <span>24h low</span>
        <span>{c.length ? usd(Math.min(...c.map((k) => k.low))) : "…"}</span>
      </div>
      <span className="bar-src">24h: {day ? candleSource(day.source, symbol) : "…"}</span>
      <span className="badge" title={config?.networkLabel ?? "Tontine devnet"}>
        <span className="live-dot" aria-hidden="true" /> devnet
      </span>
    </div>
  );
}

function Ticket({
  symbol,
  asset,
  wallet,
  bal,
  config,
  state,
  onFunds,
}: {
  symbol: MarketSymbol;
  asset: Asset;
  wallet: Wallet | null;
  bal: Balances | null;
  config: Config | null;
  state: AppState | null;
  onFunds: (m: Move, t: TokenKey) => void;
}) {
  const [side, setSide] = useState<Side>("Buy");
  const [kind, setKind] = useState<"Market" | "Limit">("Market");
  const [amountText, setAmount] = useState("40");
  const [price, setPrice] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<number | null>(null);

  const unitBase = 10n ** BigInt(asset.decimals);
  const decimals = side === "Buy" ? 6 : asset.decimals;
  const payUnit = side === "Buy" ? "USDC" : symbol;
  let base = 0n;
  let amountError = "";
  try {
    base = toBase(amountText, decimals);
    if (base <= 0n) amountError = "The amount must be above 0.";
  } catch {
    amountError = side === "Buy" ? "Enter an amount in USDC, like 40 or 12.50." : `Enter an amount in ${symbol}, like ${SELL_DEFAULT[symbol]}.`;
  }

  // The market reference for this exact order, fetched once the amount stops changing.
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (amountError) return;
    let alive = true;
    const t = setTimeout(() => {
      getQuote(side, base, symbol).then(
        (q) => alive && setQuote(q),
        (e) => alive && setQuoteError((e as Error).message),
      );
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [side, base.toString(), symbol]);

  // A limit is a price in USDC per unit of the asset; the minimum follows: amount / price, or amount * price.
  let priceBase = 0n;
  let priceError = "";
  if (kind === "Limit") {
    try {
      priceBase = toBase(price, 6);
      if (priceBase <= 0n) priceError = "The price must be above 0.";
    } catch {
      priceError = `Enter a price in USDC per ${symbol}, like ${state ? usd(state.reference.mid) : "2.45"}.`;
    }
  }
  const minOut = kind === "Market" ? (quote ? BigInt(quote.out) : null) : priceError || amountError ? null : side === "Buy" ? (base * unitBase) / priceBase : (base * priceBase) / unitBase;

  const minOrder = BigInt(config?.tenderConfig?.min_order ?? 0);
  const notional = side === "Buy" ? (amountError ? null : base) : minOut;
  const tooSmall = notional !== null && notional < minOrder;
  // What the order pays from: the trading balance (NEAR Intents) first, the wallet for the rest.
  const token: TokenKey = side === "Buy" ? "USDC" : symbol;
  const tokenUnit = side === "Buy" ? "USDC" : wrapped(asset);
  const spot = side === "Buy" ? bal?.usdc : bal?.markets[symbol]?.asset;
  const have = spot ? BigInt(spot.intents) : null;
  const inWallet = spot ? BigInt(spot.wallet) : null;
  const shortfall = have !== null && base > have ? base - have : 0n;
  // A wallet of another chain has no NEAR wallet: only its trading balance pays.
  const enough = inWallet === null || shortfall <= (wallet?.chain ? 0n : inWallet);
  const fmt = (v: bigint | null) => (v === null ? "…" : side === "Buy" ? usdc(v) : amount(v, asset.decimals, digitsOf(asset)));
  const fee = config?.tenderConfig?.order_fee_bps;
  const surplus = config?.markets.find((m) => m.symbol === symbol)?.tenderConfig?.surplus_bps;
  const ready = !amountError && !priceError && !!quote && minOut !== null && minOut > 0n && !tooSmall && enough;

  return (
    <Card className="ticket">
      <div className="segmented sides" role="radiogroup" aria-label="Side">
        {(["Buy", "Sell"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={side === s}
            className={`${s.toLowerCase()} ${side === s ? "on" : ""}`}
            onClick={() => {
              if (s === side) return;
              setSide(s);
              setAmount(s === "Buy" ? "40" : SELL_DEFAULT[symbol]);
            }}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="segmented small" role="radiogroup" aria-label="Order type">
        {(["Market", "Limit"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            className={kind === k ? "on" : ""}
            onClick={() => {
              setKind(k);
              if (k === "Limit" && !price && state) setPrice(usd(state.reference.mid));
            }}
          >
            {k}
          </button>
        ))}
      </div>

      {kind === "Limit" && (
        <label className="field">
          <span>Limit price</span>
          <div className="input-unit">
            <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-label={`Limit price in USDC per ${symbol}`} />
            <span>USDC / {symbol}</span>
          </div>
          {priceError && <span className="tx-error">{priceError}</span>}
        </label>
      )}

      <label className="field">
        <span>{side === "Buy" ? "You pay" : "You sell"}</span>
        <div className="input-unit">
          <input inputMode="decimal" value={amountText} onChange={(e) => setAmount(e.target.value)} aria-label={`Amount in ${payUnit}`} />
          <span>{payUnit}</span>
        </div>
        {amountError && <span className="tx-error">{amountError}</span>}
      </label>
      <div className="pcts">
        {[25n, 50n, 75n, 100n].map((p) => (
          <button key={p} type="button" className="btn small" disabled={!have} onClick={() => have && setAmount(plain((have * p) / 100n, decimals))}>
            {p.toString()}%
          </button>
        ))}
      </div>
      {wallet && (
        <div className="avail">
          <span className="muted">Available</span>
          <b>
            {fmt(have)} {tokenUnit}
          </b>
          <button type="button" className="link" onClick={() => onFunds("deposit", token)}>
            {wallet.chain ? "Add funds" : "Deposit"}
          </button>
          {!wallet.chain && (
            <button type="button" className="link" onClick={() => onFunds("withdraw", token)}>
              Withdraw
            </button>
          )}
          {!wallet.chain && (
            <span className="avail-wallet">
              Wallet {fmt(inWallet)} {tokenUnit}
            </span>
          )}
        </div>
      )}

      <dl className="ticket-sum">
        <dt>You receive at least</dt>
        <dd>{minOut !== null ? gotText(side, minOut, asset) : "–"}</dd>
        <dt>Market reference</dt>
        <dd>{quote ? gotText(side, quote.out, asset) : quoteError ? <span className="tx-error">{quoteError}</span> : amountError ? "–" : "pricing…"}</dd>
        {kind === "Limit" && (
          <>
            <dt>Your limit vs market</dt>
            <dd>{quote && minOut !== null ? bpText(bpOver(minOut, quote.out)) : "–"}</dd>
          </>
        )}
        <dt>Tontine fee</dt>
        <dd>{fee !== undefined ? `${fee} bp from the firm${surplus ? `, ${surplus / 100}% of your gain` : ""}` : "…"}</dd>
      </dl>
      {quote && <p className="fine">Reference: {referenceText(quote)}, less 25 bp.</p>}
      <p className="fine">
        Sealed auction, about {COMMIT_SECS + REVEAL_SECS + 1} s: filled at the second-best quote or refunded.
      </p>

      {!wallet ? (
        <>
          <TxButton className="btn big go" run={() => createWallet()}>
            <i className="fa-solid fa-wallet" aria-hidden="true" /> Create demo account
          </TxButton>
          <ConnectWallet />
        </>
      ) : (
        <TxButton
          className={`btn big go ${side.toLowerCase()}`}
          disabled={!ready}
          run={() => postOrder(wallet, side, base, minOut!, BigInt(quote!.out), COMMIT_SECS, REVEAL_SECS, symbol)}
          onDone={(r: any) => {
            const posted = r?.events?.find((e: any) => e.event === "order_posted");
            if (posted) setOrderId(posted.data[0].order_id);
          }}
        >
          {shortfall > 0n && !wallet.chain ? `Deposit ${plain(shortfall, decimals)} ${tokenUnit} from your wallet and ${side.toLowerCase()}` : `${side} ${symbol}${wallet.chain ? ", sign in your wallet" : ""}`}
        </TxButton>
      )}
      {!wallet && <p className="fine">A devnet account with test USDC, wNEAR, wETH and wSOL; its key is generated in your browser and stays there.</p>}
      {tooSmall && <p className="tx-error">Below the smallest order: {usdc(minOrder)} USDC {side === "Buy" ? "paid" : "received"}.</p>}
      {!enough && (
        <p className="tx-error">
          {wallet?.chain
            ? `Not enough ${tokenUnit}: ${fmt(have)} available. ${side === "Buy" ? "Simulate a deposit in the account menu." : `Buy ${symbol} first.`}`
            : `Not enough ${tokenUnit}: ${fmt(have)} available, ${fmt(inWallet)} in your wallet. Use the faucet in the account menu.`}
        </p>
      )}

      {orderId !== null && <YourOrder id={orderId} symbol={symbol} asset={asset} />}
    </Card>
  );
}

/** Follows the order just posted until it fills or is refunded. */
function YourOrder({ id, symbol, asset }: { id: number; symbol: MarketSymbol; asset: Asset }) {
  const { data: state } = useAppState(symbol);
  const now = useChainNow(state);
  const o = state?.orders.find((x) => x.id === id);
  const a = o?.auctionState;
  return (
    <div className="order-status">
      <p className="order-status-head">
        <Link to={inMarket(`/app/orders/${id}`, symbol)}>Order #{id}</Link> {o && <Badge status={o.status} />}
      </p>
      {!o || !a ? (
        <p>Waiting for the chain…</p>
      ) : o.status === "Open" ? (
        <p>
          {now < BigInt(a.commit_end) ? (
            <>
              Sealed: {a.bids.length} quote{a.bids.length === 1 ? "" : "s"} so far · reveal in <Countdown until={BigInt(a.commit_end)} now={now} />
            </>
          ) : now < BigInt(a.reveal_end) ? (
            <>
              Revealing: {a.bids.filter((b) => b.revealed !== null).length} of {a.bids.length} quotes · settles in <Countdown until={BigInt(a.reveal_end)} now={now} />
            </>
          ) : (
            "Settling…"
          )}
        </p>
      ) : o.status === "Filled" ? (
        <p className="result good">
          Filled: you received <b>{gotText(o.side, o.out, asset)}</b> for {paidText(o.side, o.amount_in, asset)}, <b>{bpText(bpOver(o.out, o.reference_out))}</b> vs market.
        </p>
      ) : (
        <p className="result">Refunded: no quote reached your minimum. Your {paidText(o.side, o.amount_in, asset)} is back in your trading balance.</p>
      )}
    </div>
  );
}

/** Each solvent, unpaused firm at its own spread around the market mid. Not its real quote: that one is sealed. */
function Book({ state, name, symbol }: { state: AppState | null; name: (id: number) => string; symbol: MarketSymbol }) {
  const mid = state?.reference.mid ?? 0;
  const quoting = state ? state.firms.filter((f) => f.status === "Solvent" && !f.policy.paused && state.params[f.id]) : [];
  const levels = (sign: 1 | -1) =>
    quoting
      .map((f) => ({ id: f.id, bps: state!.params[f.id].spreadBps, px: mid * (1 + (sign * state!.params[f.id].spreadBps) / 1e4) }))
      .sort((a, b) => b.px - a.px);
  const row = (l: { id: number; bps: number; px: number }, cls: string) => (
    <tr key={`${cls}${l.id}`} className={cls}>
      <td className="num">{usd(l.px)}</td>
      <td>
        <FirmChip id={l.id} name={name(l.id)} index={l.id} market={symbol} />
      </td>
      <td className="num">{+l.bps.toFixed(1)} bp</td>
    </tr>
  );
  return (
    <Card className="book" title="Firms quoting">
      {!state ? (
        <Empty>Loading the firms…</Empty>
      ) : !quoting.length ? (
        <Empty>No solvent firm is quoting right now.</Empty>
      ) : (
        <table className="table book-table">
          <thead>
            <tr>
              <th className="num">Price</th>
              <th>Firm</th>
              <th className="num">Spread</th>
            </tr>
          </thead>
          <tbody>
            {levels(1).map((l) => row(l, "ask"))}
            <tr className="mid">
              <td className="num">{usd(mid)}</td>
              <td colSpan={2}>{state.reference.source === "market" ? "market mid" : "replayed mid"}</td>
            </tr>
            {levels(-1).map((l) => row(l, "bid"))}
          </tbody>
        </table>
      )}
      <p className="fine">Indicative: firms seal their real quotes when you trade. Asks (red) are where a firm would sell you {symbol}, bids (green) where it would buy yours.</p>
    </Card>
  );
}

function Tape({ fills, name, asset }: { fills: ChainEvent[]; name: (id: number) => string; asset: Asset }) {
  if (!fills.length) return <Empty>No fill in the recent events yet.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Side</th>
            <th className="num">Price</th>
            <th className="num">Size</th>
            <th>Firm</th>
            <th className="num">Vs market</th>
            <th>Order</th>
          </tr>
        </thead>
        <tbody>
          {fills
            .slice(-50)
            .reverse()
            .map((e) => {
              const d = e.data;
              // What the client received: the second best less Tontine's surplus share.
              const got = clientOut(d);
              return (
                <tr key={e.id}>
                  <td>{clock(e.time)}</td>
                  <td className={d.side === "Buy" ? "gain" : "loss"}>{d.side}</td>
                  <td className="num">{usd(priceOf(d.side, d.amount_in, got, asset.decimals))}</td>
                  <td className="num">
                    {amount(d.side === "Buy" ? got : d.amount_in, asset.decimals, digitsOf(asset))} {asset.symbol}
                  </td>
                  <td>
                    <FirmChip id={d.firm_id} name={name(d.firm_id)} index={d.firm_id} market={asset.symbol} />
                  </td>
                  <td className="num">{bpText(bpOver(got, d.reference_out))}</td>
                  <td>
                    <Link to={inMarket(`/app/orders/${d.order_id}`, asset.symbol)}>#{d.order_id}</Link>
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}

function MyOrders({ state, wallet, asset }: { state: AppState | null; wallet: Wallet | null; asset: Asset }) {
  if (!wallet) return <Empty>Create a demo account to trade: your orders show here.</Empty>;
  const mine = state?.orders.filter((o) => o.client === wallet.accountId) ?? [];
  if (!mine.length) return <Empty>No order of yours among the latest {state?.orders.length ?? 0}.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Side</th>
            <th className="num">Paid</th>
            <th className="num">At least</th>
            <th>Status</th>
            <th className="num">Got</th>
            <th className="num">Vs market</th>
          </tr>
        </thead>
        <tbody>
          {mine.map((o) => (
            <tr key={o.id}>
              <td>
                <Link to={inMarket(`/app/orders/${o.id}`, asset.symbol)}>#{o.id}</Link>
              </td>
              <td className={o.side === "Buy" ? "gain" : "loss"}>{o.side}</td>
              <td className="num">{paidText(o.side, o.amount_in, asset)}</td>
              <td className="num">{gotText(o.side, o.min_out, asset)}</td>
              <td>
                <Badge status={o.status} />
              </td>
              <td className="num">{o.out ? gotText(o.side, o.out, asset) : "–"}</td>
              <td className="num">{bpText(bpOver(o.out, o.reference_out))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BalanceTable({ bal, wallet, symbol, onFunds }: { bal: Balances | null; wallet: Wallet | null; symbol: MarketSymbol; onFunds: (m: Move) => void }) {
  if (!wallet) return <Empty>Create a demo account to trade: your balances show here.</Empty>;
  return (
    <>
      <BalanceRows bal={bal} tokens={["USDC", symbol]} wallet={!wallet.chain} />
      <div className="balance-foot">
        <p className="fine">Trading balance: held in NEAR Intents, one for every market.</p>
        <div className="actions-row">
          <button type="button" className="btn small primary" onClick={() => onFunds("deposit")}>
            <i className="fa-solid fa-arrow-down" aria-hidden="true" /> {wallet.chain ? "Add funds" : "Deposit"}
          </button>
          {!wallet.chain && (
            <button type="button" className="btn small" onClick={() => onFunds("withdraw")}>
              <i className="fa-solid fa-arrow-up" aria-hidden="true" /> Withdraw
            </button>
          )}
        </div>
      </div>
      <InMarkets wallet={wallet} bal={bal} />
    </>
  );
}
