import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CandleChart, type Fill } from "../components/Chart";
import { Badge, Card, Countdown, Empty, FirmChip, TxButton } from "../components/ui";
import { getCandles, getQuote, type AppState, type Candle, type ChainEvent, type Config, type Side } from "../lib/api";
import { bpOver, bpText, gotText, near, paidText, priceOf, toBase, usdc } from "../lib/format";
import { announceTx, useAppState, useBalances, useChainNow, useConfig, useEvents, useFirmName, useWallet } from "../lib/hooks";
import { createWallet, postOrder, type Balances, type Wallet } from "../lib/near";

const COMMIT_SECS = 8;
const REVEAL_SECS = 6;
const STEPS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 };
const CANDLE_SOURCE = { binance: "Binance NEAR/USDT", coinbase: "Coinbase NEAR/USD", replay: "replayed NEAR prices (offline)" };

type Candles = { source: keyof typeof CANDLE_SOURCE; candles: Candle[] };

/** Candles for one interval, refreshed every 30 s (the server caches them as long). */
function useCandles(interval: string, limit: number): { data: Candles | null; error: boolean } {
  const [data, setData] = useState<Candles | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    setData(null);
    const load = () =>
      getCandles(interval, limit).then(
        (d) => alive && (setData(d), setError(false)),
        () => alive && setError(true),
      );
    void load();
    const t = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [interval, limit]);
  return { data, error };
}

/** "12.5" from base units, cut (never rounded up) to `digits` decimals: what an input accepts. */
function plain(base: bigint, decimals: number, digits = 6): string {
  const s = (base / 10n ** BigInt(decimals - digits)).toString().padStart(digits + 1, "0");
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`.replace(/\.?0+$/, "");
}

const fillsOf = (events: ChainEvent[]) => events.filter((e) => e.standard === "tontine" && e.event === "order_filled");
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB");

export function Trade() {
  const { data: state } = useAppState();
  const wallet = useWallet();
  const bal = useBalances(wallet?.accountId);
  const config = useConfig();
  const name = useFirmName(state);
  // A fill or a refund moves balances: refresh them as soon as the stream says so.
  const events = useEvents(500, (e) => (e.event === "order_filled" || e.event === "order_refunded") && announceTx());
  const [interval, setIv] = useState("5m");
  const chart = useCandles(interval, 300);
  const day = useCandles("1h", 24);
  const [tab, setTab] = useState<"trades" | "mine" | "balances">("trades");

  const fills = useMemo(() => fillsOf(events), [events]);
  const marks = useMemo<Fill[]>(() => fills.map((e) => ({ time: e.time / 1000, side: e.data.side })), [fills]);
  const mid = state?.reference.mid;

  return (
    <div className="trade">
      <MarketBar state={state} day={day.data} config={config} />

      <Card
        className="trade-chart"
        title="NEAR / USDC"
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
          line={mid ? { price: mid, title: "1Click mid" } : undefined}
          fitKey={interval}
          empty={chart.error ? "Candles are unavailable right now." : "Loading candles…"}
        />
        <p className="chart-legend">
          <span>Candles: {chart.data ? CANDLE_SOURCE[chart.data.source] : "…"}</span>
          <span>
            <i className="fa-solid fa-caret-up gain" aria-hidden="true" /> Tontine buy fill
          </span>
          <span>
            <i className="fa-solid fa-caret-down loss" aria-hidden="true" /> Tontine sell fill
          </span>
          <span>
            <span className="dash" aria-hidden="true" /> 1Click mid
          </span>
        </p>
      </Card>

      <Ticket wallet={wallet} bal={bal} config={config} state={state} />

      <Book state={state} name={name} />

      <Card className="trade-tabs">
        <div className="tabs" role="tablist">
          {(
            [
              ["trades", "Market trades"],
              ["mine", "My orders"],
              ["balances", "Balances"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
        {tab === "trades" ? <Tape fills={fills} name={name} /> : tab === "mine" ? <MyOrders state={state} wallet={wallet} /> : <BalanceTable bal={bal} wallet={wallet} />}
      </Card>

      <details className="card trade-how">
        <summary>How it works</summary>
        <ol className="steps">
          <li>
            What you pay goes from your wallet into NEAR Intents (<code>ft_transfer_call</code>).
          </li>
          <li>
            NEAR Intents sends it to tender with your order (<code>mt_transfer_call</code>, <code>PostOrder</code>), which escrows it and opens the auction.
          </li>
          <li>
            Firms seal their quotes for {COMMIT_SECS} s, reveal them for {REVEAL_SECS} s, then a settle fills you at the second-best quote, never under your minimum, or refunds you.
          </li>
          <li>
            What you receive lands in your Tontine balance; withdraw it to your wallet from the <Link to="/app/portfolio">portfolio</Link>.
          </li>
        </ol>
      </details>
    </div>
  );
}

function MarketBar({ state, day, config }: { state: AppState | null; day: Candles | null; config: Config | null }) {
  const c = day?.candles ?? [];
  const open = c[0]?.open;
  const last = c.at(-1)?.close;
  const change = open && last ? ((last - open) / open) * 100 : null;
  return (
    <div className="trade-bar">
      <span className="pair">NEAR / USDC</span>
      <div className="bar-stat">
        <span>Price</span>
        <span className="bar-price">{state ? state.reference.mid.toFixed(4) : "…"}</span>
        <span className="bar-src">{state ? (state.reference.source === "1click" ? "NEAR Intents 1Click mid" : "replayed price, 1Click unavailable") : ""}</span>
      </div>
      <div className="bar-stat">
        <span>24h change</span>
        <span className={change === null ? "" : change >= 0 ? "gain" : "loss"}>{change === null ? "…" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}</span>
      </div>
      <div className="bar-stat">
        <span>24h high</span>
        <span>{c.length ? Math.max(...c.map((k) => k.high)).toFixed(4) : "…"}</span>
      </div>
      <div className="bar-stat">
        <span>24h low</span>
        <span>{c.length ? Math.min(...c.map((k) => k.low)).toFixed(4) : "…"}</span>
      </div>
      <span className="bar-src">24h: {day ? CANDLE_SOURCE[day.source] : "…"}</span>
      <span className="badge" title={config?.networkLabel ?? "Tontine devnet"}>
        <span className="live-dot" aria-hidden="true" /> devnet
      </span>
    </div>
  );
}

function Ticket({ wallet, bal, config, state }: { wallet: Wallet | null; bal: Balances | null; config: Config | null; state: AppState | null }) {
  const [side, setSide] = useState<Side>("Buy");
  const [kind, setKind] = useState<"Market" | "Limit">("Market");
  const [amount, setAmount] = useState("40");
  const [price, setPrice] = useState("");
  const [quote, setQuote] = useState<{ out: string; mid: number; source: string } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<number | null>(null);

  const decimals = side === "Buy" ? 6 : 24;
  const payUnit = side === "Buy" ? "USDC" : "NEAR";
  let base = 0n;
  let amountError = "";
  try {
    base = toBase(amount, decimals);
    if (base <= 0n) amountError = "The amount must be above 0.";
  } catch {
    amountError = side === "Buy" ? "Enter an amount in USDC, like 40 or 12.50." : "Enter an amount in NEAR, like 2 or 0.5.";
  }

  // The 1Click quote for this exact order, fetched once the amount stops changing.
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (amountError) return;
    let alive = true;
    const t = setTimeout(() => {
      getQuote(side, base).then(
        (q) => alive && setQuote(q),
        (e) => alive && setQuoteError((e as Error).message),
      );
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [side, base.toString()]);

  // A limit is a price in USDC per NEAR; the minimum follows from it: amount / price NEAR, or amount * price USDC.
  let priceBase = 0n;
  let priceError = "";
  if (kind === "Limit") {
    try {
      priceBase = toBase(price, 6);
      if (priceBase <= 0n) priceError = "The price must be above 0.";
    } catch {
      priceError = "Enter a price in USDC per NEAR, like 2.45.";
    }
  }
  const minOut = kind === "Market" ? (quote ? BigInt(quote.out) : null) : priceError || amountError ? null : side === "Buy" ? (base * 10n ** 24n) / priceBase : (base * priceBase) / 10n ** 24n;

  const minOrder = BigInt(config?.tenderConfig?.min_order ?? 0);
  const notional = side === "Buy" ? (amountError ? null : base) : minOut;
  const tooSmall = notional !== null && notional < minOrder;
  const have = bal ? BigInt(side === "Buy" ? bal.usdc.wallet : bal.wnear.wallet) : null;
  const enough = have === null || have >= base;
  const fee = config?.tenderConfig?.order_fee_bps;
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
              setAmount(s === "Buy" ? "40" : "5");
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
              if (k === "Limit" && !price && state) setPrice(state.reference.mid.toFixed(4));
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
            <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-label="Limit price in USDC per NEAR" />
            <span>USDC / NEAR</span>
          </div>
          {priceError && <span className="tx-error">{priceError}</span>}
        </label>
      )}

      <label className="field">
        <span>{side === "Buy" ? "You pay" : "You sell"}</span>
        <div className="input-unit">
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label={`Amount in ${payUnit}`} />
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
      <p className="hint">
        In your wallet: {!wallet ? "no account yet" : bal ? (side === "Buy" ? `${usdc(bal.usdc.wallet)} USDC` : `${near(bal.wnear.wallet)} wNEAR`) : "…"}
      </p>

      <dl className="ticket-sum">
        <dt>You receive at least</dt>
        <dd>{minOut !== null ? gotText(side, minOut) : "–"}</dd>
        <dt>NEAR Intents 1Click gives</dt>
        <dd>{quote ? gotText(side, quote.out) : quoteError ? <span className="tx-error">{quoteError}</span> : amountError ? "–" : "asking 1Click…"}</dd>
        {kind === "Limit" && (
          <>
            <dt>Your limit vs 1Click</dt>
            <dd>{quote && minOut !== null ? bpText(bpOver(minOut, quote.out)) : "–"}</dd>
          </>
        )}
        <dt>Tontine fee</dt>
        <dd>{fee !== undefined ? `${fee} bp, paid by the winning firm` : "…"}</dd>
      </dl>
      {quote?.source === "replay" && <p className="fine">1Click is unreachable: the quote uses replayed prices.</p>}
      <p className="fine">
        Sealed auction, about {COMMIT_SECS + REVEAL_SECS + 1} s: filled at the second-best quote or refunded.
      </p>

      {!wallet ? (
        <TxButton className="btn big go" run={() => createWallet()}>
          <i className="fa-solid fa-wallet" aria-hidden="true" /> Create demo account
        </TxButton>
      ) : (
        <TxButton
          className={`btn big go ${side.toLowerCase()}`}
          disabled={!ready}
          run={() => postOrder(wallet, side, base, minOut!, BigInt(quote!.out), COMMIT_SECS, REVEAL_SECS)}
          onDone={(r: any) => {
            const posted = r?.events?.find((e: any) => e.event === "order_posted");
            if (posted) setOrderId(posted.data[0].order_id);
          }}
        >
          {side} NEAR
        </TxButton>
      )}
      {!wallet && <p className="fine">A devnet account with 100 test USDC and 20 test wNEAR; its key is generated in your browser and stays there.</p>}
      {tooSmall && <p className="tx-error">Below the smallest order: {usdc(minOrder)} USDC {side === "Buy" ? "paid" : "received"}.</p>}
      {!enough && <p className="tx-error">Not enough {side === "Buy" ? "USDC" : "wNEAR"} in your wallet: use the faucet in the account menu.</p>}

      {orderId !== null && <YourOrder id={orderId} />}
    </Card>
  );
}

/** Follows the order just posted until it fills or is refunded. */
function YourOrder({ id }: { id: number }) {
  const { data: state } = useAppState();
  const now = useChainNow(state);
  const o = state?.orders.find((x) => x.id === id);
  const a = o?.auctionState;
  return (
    <div className="order-status">
      <p className="order-status-head">
        <Link to={`/app/orders/${id}`}>Order #{id}</Link> {o && <Badge status={o.status} />}
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
          Filled: you received <b>{gotText(o.side, o.out)}</b> for {paidText(o.side, o.amount_in)}, <b>{bpText(bpOver(o.out, o.reference_out))}</b> vs 1Click.
        </p>
      ) : (
        <p className="result">Refunded: no quote reached your minimum. Your {paidText(o.side, o.amount_in)} is in your Tontine balance.</p>
      )}
    </div>
  );
}

/** Each solvent, unpaused firm at its own spread around the 1Click mid. Not its real quote: that one is sealed. */
function Book({ state, name }: { state: AppState | null; name: (id: number) => string }) {
  const mid = state?.reference.mid ?? 0;
  const quoting = state ? state.firms.filter((f) => f.status === "Solvent" && !f.policy.paused && state.params[f.id]) : [];
  const levels = (sign: 1 | -1) =>
    quoting
      .map((f) => ({ id: f.id, bps: state!.params[f.id].spreadBps, px: mid * (1 + (sign * state!.params[f.id].spreadBps) / 1e4) }))
      .sort((a, b) => b.px - a.px);
  const row = (l: { id: number; bps: number; px: number }, cls: string) => (
    <tr key={`${cls}${l.id}`} className={cls}>
      <td className="num">{l.px.toFixed(4)}</td>
      <td>
        <FirmChip id={l.id} name={name(l.id)} index={l.id} />
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
              <td className="num">{mid.toFixed(4)}</td>
              <td colSpan={2}>{state.reference.source === "1click" ? "1Click mid" : "replayed mid"}</td>
            </tr>
            {levels(-1).map((l) => row(l, "bid"))}
          </tbody>
        </table>
      )}
      <p className="fine">Indicative: firms seal their real quotes when you trade. Asks (red) are where a firm would sell you NEAR, bids (green) where it would buy yours.</p>
    </Card>
  );
}

function Tape({ fills, name }: { fills: ChainEvent[]; name: (id: number) => string }) {
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
            <th className="num">Vs 1Click</th>
            <th>Order</th>
          </tr>
        </thead>
        <tbody>
          {fills
            .slice(-50)
            .reverse()
            .map((e) => {
              const d = e.data;
              return (
                <tr key={e.id}>
                  <td>{clock(e.time)}</td>
                  <td className={d.side === "Buy" ? "gain" : "loss"}>{d.side}</td>
                  <td className="num">{priceOf(d.side, d.amount_in, d.out).toFixed(4)}</td>
                  <td className="num">{near(d.side === "Buy" ? d.out : d.amount_in)} NEAR</td>
                  <td>
                    <FirmChip id={d.firm_id} name={name(d.firm_id)} index={d.firm_id} />
                  </td>
                  <td className="num">{bpText(bpOver(d.out, d.reference_out))}</td>
                  <td>
                    <Link to={`/app/orders/${d.order_id}`}>#{d.order_id}</Link>
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}

function MyOrders({ state, wallet }: { state: AppState | null; wallet: Wallet | null }) {
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
            <th className="num">Vs 1Click</th>
          </tr>
        </thead>
        <tbody>
          {mine.map((o) => (
            <tr key={o.id}>
              <td>
                <Link to={`/app/orders/${o.id}`}>#{o.id}</Link>
              </td>
              <td className={o.side === "Buy" ? "gain" : "loss"}>{o.side}</td>
              <td className="num">{paidText(o.side, o.amount_in)}</td>
              <td className="num">{gotText(o.side, o.min_out)}</td>
              <td>
                <Badge status={o.status} />
              </td>
              <td className="num">{o.out ? gotText(o.side, o.out) : "–"}</td>
              <td className="num">{bpText(bpOver(o.out, o.reference_out))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BalanceTable({ bal, wallet }: { bal: Balances | null; wallet: Wallet | null }) {
  if (!wallet) return <Empty>Create a demo account to trade: your balances show here.</Empty>;
  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Token</th>
              <th className="num">Wallet</th>
              <th className="num">In NEAR Intents</th>
              <th className="num">In Tontine</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>USDC</td>
              <td className="num">{bal ? usdc(bal.usdc.wallet) : "…"}</td>
              <td className="num">{bal ? usdc(bal.usdc.intents) : "…"}</td>
              <td className="num">{bal ? usdc(bal.usdc.tender) : "…"}</td>
            </tr>
            <tr>
              <td>wNEAR</td>
              <td className="num">{bal ? near(bal.wnear.wallet) : "…"}</td>
              <td className="num">{bal ? near(bal.wnear.intents) : "…"}</td>
              <td className="num">{bal ? near(bal.wnear.tender) : "…"}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="fine">
        Orders pay from your wallet. Fills and refunds land in Tontine: withdraw them to your wallet from the <Link to="/app/portfolio">portfolio</Link>.
      </p>
    </>
  );
}
