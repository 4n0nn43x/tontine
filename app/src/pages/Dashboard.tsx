import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { LineChart, type Series } from "../components/Chart";
import { Count, fixed, Leaderboard, Skel, useLeaderboard } from "../components/Game";
import { Badge, Card, Countdown, Empty, EventFeed, Kpi, MarketTabs } from "../components/ui";
import { RegimeChip } from "../components/Ai";
import { TestnetCard } from "../components/Testnet";
import { marketOf, nameOf, regimeOf, SYMBOLS, type AppState, type ChainEvent, type MarketSymbol, type OrderState } from "../lib/api";
import { ASSETS, auctionAmount, bpText, gotText, paidText, regimeSplit, STORM_NOTE, usd, usdc, type Asset } from "../lib/format";
import { inMarket, inTender, useChainNow, useConfig, useEvents, useFirmNames, useMarket, useStates, useStats } from "../lib/hooks";
import { newPlayer, secondsLeft, Sealed, type Market as RoundMarket, type Round } from "../lib/sealed";

export const PHASES = ["Order", "Sealed", "Revealed", "Filled", "Slashed", "Liquidating", "Acquired"];

export function PhaseStrip({ phase }: { phase: number }) {
  return (
    <ol className="phase-strip" aria-label="Lifecycle">
      {PHASES.map((p, i) => (
        <li key={p} className={i === phase ? "now" : phase >= 0 && i < phase ? "done" : ""}>
          {p}
        </li>
      ))}
    </ol>
  );
}

/** The newest auction, as text over the SEALED poster: who sealed a bid, the countdown, then the winner. */
function LiveRound({ rounds, states }: { rounds: Sealed; states: Record<MarketSymbol, AppState | null> }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const all = [...rounds.rounds.values()];
  const r: Round | undefined = all.filter((x) => x.phase === "sealed" || x.phase === "revealed").at(-1) ?? all.filter((x) => Date.now() - x.at < 25_000).at(-1);
  if (!r) return <p className="sealed-live">The next sealed auction starts in a few seconds.</p>;
  const firm = (id: number) => nameOf(states[r.market]?.firms.find((f) => f.id === id), id);
  const left = r.phase === "sealed" ? secondsLeft(r, states[r.market]) : null;
  return (
    <div className="sealed-live">
      <p>
        <b style={{ color: ASSETS[r.market].color }}>{r.market}</b> order #{r.order} · {r.phase === "sealed" ? `${r.bidders.length} sealed bid${r.bidders.length === 1 ? "" : "s"}` : r.phase}
        {left !== null && <b className="t"> {left}s</b>}
      </p>
      <ul>
        {r.bidders.map((id) => (
          <li key={id} className={r.winner === id ? "won" : ""}>
            {r.winner === id && <i className="fa-solid fa-crown" aria-label="winner" />} {firm(id)}
            {r.revealed[id] && <span> {auctionAmount(r.revealed[id], r.side, ASSETS[r.market])}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How far under the market mid an order's reference sits: the server backs it out the same way (ts/src/prices.ts CLIENT_TOLERANCE_BPS). */
const TOLERANCE_BPS = 25n;

/** The market mid behind each order's reference, and the clearing price of each fill, in USD per unit of the asset. */
function priceSeries(events: ChainEvent[], state: AppState | null, a: Asset): Series[] {
  const mid: Series["points"] = [];
  const fills: Series["points"] = [];
  const unit = 10 ** a.decimals;
  for (const e of events) {
    const d = e.data ?? {};
    if (e.event === "order_posted" && d.reference_out) {
      const gross = Number((BigInt(d.reference_out) * 10_000n) / (10_000n - TOLERANCE_BPS));
      const inUnits = Number(d.amount_in);
      mid.push({ time: e.time / 1000, value: d.side === "Buy" ? inUnits / 1e6 / (gross / unit) : gross / 1e6 / (inUnits / unit) });
    }
    if (e.event === "order_filled") fills.push({ time: e.time / 1000, value: Number(d.price) / 1e6 });
  }
  if (state?.reference) mid.push({ time: state.reference.at / 1000, value: state.reference.mid });
  const precision = (state?.reference.mid ?? 0) >= 10 ? 2 : 4;
  return [
    { name: "Market mid", color: "#d7bcff", points: mid, precision },
    { name: "Fill price", color: "#8ef0b3", points: fills, dots: true, precision },
  ];
}

export function Dashboard() {
  // The price chart and the leaderboard show one market; the KPIs, the city and the feed show them all.
  const { symbol, asset, market, select } = useMarket();
  const states = useStates();
  const state = states[symbol];
  const { data: stats } = useStats();
  const config = useConfig();
  const firmName = useFirmNames();
  // The live round of the SEALED card: chain events in, text out (no canvas here, so the dashboard stays light).
  const rounds = useRef(new Sealed(newPlayer("")));
  const [phase, setPhase] = useState(-1);
  const latest = useRef(config);
  latest.current = config;
  const events = useEvents(500, (e) => {
    const m = marketOf(latest.current, e.contract)?.symbol as RoundMarket | undefined;
    if (!m || e.standard !== "tontine") return;
    rounds.current.apply({ event: e.event, market: m, data: e.data });
    const at = { order_posted: 0, bid_committed: 1, bid_revealed: 2, order_filled: 3, slashed: 4, liquidation_started: 5, liquidated: 6 }[e.event];
    if (at !== undefined) setPhase(at);
  });
  const now = useChainNow(states.NEAR);
  const own = useMemo(() => events.filter((e) => inTender(e, market?.tender)), [events, market?.tender]);
  // Recompute the chart only when an order event arrives or the reference moves, so a zoom survives the polls.
  const lastOrderEvent = own.reduce((k, e) => (e.event === "order_filled" || e.event === "order_posted" ? e.id : k), 0);
  const series = useMemo(() => priceSeries(own, state, asset), [lastOrderEvent, state?.reference.at, symbol]);

  const board = useLeaderboard(state, own);
  const open = SYMBOLS.flatMap((s) => (states[s]?.orders ?? []).filter((o) => o.status === "Open").map((o) => ({ o, s })));
  const avgBp = stats && stats.fills ? stats.improvementBps / stats.fills : null;
  const share = (config?.tenderConfig?.dividend_bps ?? 0) / 100;
  const revenue = stats ? Number(stats.revenue ?? 0) : 0;

  return (
    <div className="page-app">
      <div className="page-head">
        <div>
          <h1>Live market</h1>
          <p className="sub">Every figure on this page is read from the chain: the NEAR, ETH and SOL tenders, the firm contracts and the events they emit.</p>
          <p className="regimes" aria-label="Market regimes">
            {SYMBOLS.map((s) => (
              <RegimeChip key={s} symbol={s} regime={regimeOf(states[s])} />
            ))}
          </p>
        </div>
        <Link className="btn primary" to={inMarket("/app/trade", symbol)}>
          <i className="fa-solid fa-arrow-right-arrow-left" aria-hidden="true" /> Trade
        </Link>
      </div>

      <div className="kpis">
        <Kpi icon="fa-right-left" label="Orders filled" value={stats ? <Count value={stats.fills} format={fixed(0)} /> : <Skel w="50%" h={26} />} hint={stats ? `${stats.orders} posted, ${stats.refunded} refunded` : ""} />
        <Kpi
          icon="fa-coins"
          label="Volume"
          value={stats ? <Count value={Number(stats.volume) / 1e6} format={fixed(2)} /> : <Skel w="70%" h={26} />}
          unit="USDC"
          hint={stats ? `Tontine earned ${usdc(revenue, revenue < 1e6 ? 4 : 2)} USDC` : ""}
        />
        <Kpi icon="fa-arrow-trend-up" label="Vs market" value={stats ? avgBp === null ? bpText(null) : <Count value={avgBp} format={bpText} /> : <Skel w="60%" h={26} />} hint={regimeSplit(stats?.byRegime) ? <span title={STORM_NOTE}>{regimeSplit(stats?.byRegime)}</span> : "average per fill, over the market reference"} />
        <Kpi icon="fa-hand-holding-dollar" label="Dividends" value={stats ? <Count value={Number(stats.dividends) / 1e6} format={fixed(2)} /> : <Skel w="50%" h={26} />} unit="USDC" hint={share ? `${share}% of each fill's edge` : "a share of each fill's edge"} />
        <Kpi icon="fa-scissors" label="Bonds slashed" value={stats ? <Count value={Number(stats.slashed) / 1e6} format={fixed(2)} /> : <Skel w="50%" h={26} />} unit="USDC" hint="quotes sealed, never revealed" />
        <Kpi icon="fa-handshake" label="Takeovers" value={stats ? <Count value={stats.takeovers} format={fixed(0)} /> : <Skel w="30%" h={26} />} hint={stats ? `${stats.liquidations} liquidation${stats.liquidations === 1 ? "" : "s"}` : ""} />
      </div>

      <div className="grid-main">
        <Card
          className="arena-card"
          title={
            <>
              <span className="live-dot" aria-hidden="true" /> The swarm, live
            </>
          }
          action={
            <div className="arena-actions">
              <PhaseStrip phase={phase} />
            </div>
          }
        >
          <Link className="sealed-card" to="/city" aria-label="Play SEALED, the live auctions as a game">
            <img src="/sealed.jpg" alt="" width="1200" height="600" loading="lazy" />
            <LiveRound rounds={rounds.current} states={states} />
            <span className="btn primary sealed-play">
              <i className="fa-solid fa-play" aria-hidden="true" /> Play SEALED
            </span>
          </Link>
          <p className="caption">Every order is a sealed auction between AI firms. In SEALED, back the firm you think wins before the bids open: play chips, nothing on chain.</p>
        </Card>

        <Card title="Live feed" className="feed-card">
          <EventFeed events={events} firm={firmName} limit={40} />
        </Card>
      </div>

      <Card
        title={`${symbol} price, USD`}
        action={
          <div className="arena-actions">
            {state && (
              <span className="card-note">
                Market mid {usd(state.reference.mid)} ({state.reference.source === "market" ? "live" : "replayed prices"}) · last clearing price {usd(Number(state.lastPrice) / 1e6)}
              </span>
            )}
            <MarketTabs value={symbol} onChange={select} />
          </div>
        }
      >
        <LineChart series={series} empty="No order in the recent events yet." />
        <p className="caption">The line is the market mid behind each order's reference. The dots are the prices orders filled at on tender, which also anchor the firms' price bands.</p>
      </Card>

      <Card title="Auctions in progress" action={<Link to="/app/orders">All orders</Link>}>
        {open.length ? <OpenOrders orders={open} now={now} /> : <Empty>No auction right now. The house client posts an order every minute or so, or trade yourself.</Empty>}
      </Card>

      <Card
        title={
          <>
            <i className="fa-solid fa-trophy" aria-hidden="true" /> Leaderboard · {symbol}
          </>
        }
        action={<Link to={inMarket("/app/firms", symbol)}>All firms</Link>}
      >
        <Leaderboard rows={board} market={symbol} />
      </Card>

      <TestnetCard />
    </div>
  );
}

function OpenOrders({ orders, now }: { orders: { o: OrderState; s: MarketSymbol }[]; now: bigint }) {
  return (
    <div className="active-orders">
      {orders.map(({ o, s }) => {
        const a = o.auctionState;
        const asset = ASSETS[s];
        const commitEnd = BigInt(a.commit_end);
        const revealEnd = BigInt(a.reveal_end);
        const revealed = a.bids.filter((b) => b.revealed !== null).length;
        const phase =
          now < commitEnd ? (
            <>
              Sealed bids: {a.bids.length} · reveal in <Countdown until={commitEnd} now={now} />
            </>
          ) : now < revealEnd ? (
            <>
              Revealed {revealed}/{a.bids.length} · settles in <Countdown until={revealEnd} now={now} />
            </>
          ) : (
            <>Settling…</>
          );
        return (
          <Link key={`${s}${o.id}`} className="order-row" to={inMarket(`/app/orders/${o.id}`, s)}>
            <span className="order-id">#{o.id}</span>
            <span className="order-what">
              <span className="mk-tag">{s}</span>
              {o.side === "Buy" ? `Buy ${s} with ${paidText(o.side, o.amount_in, asset)}` : `Sell ${paidText(o.side, o.amount_in, asset)}`}
            </span>
            <span className="order-amount">at least {gotText(o.side, o.min_out, asset)}</span>
            <span className="order-phase">{phase}</span>
            <Badge status={o.status} />
          </Link>
        );
      })}
    </div>
  );
}
