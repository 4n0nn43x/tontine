import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { LineChart, type Series } from "../components/Chart";
import { SceneView, type SceneApi } from "../components/SceneView";
import { Badge, Card, Countdown, Empty, EventFeed, FirmChip, Kpi } from "../components/ui";
import { nameOf, type AppState, type ChainEvent, type OrderState } from "../lib/api";
import { bpText, gotText, near, paidText, usdc } from "../lib/format";
import { useAppState, useChainNow, useConfig, useEvents, useFirmName, useStats } from "../lib/hooks";
import { liveDriver } from "../lib/live";

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

/** What 1Click without a key costs on top of the mid: the server backs the mid out of its quotes the same way (ts/src/prices.ts). */
const ONECLICK_COST_BPS = 25n;

/** The 1Click mid behind an order's reference, and the clearing price of each fill, in USD per NEAR. */
function priceSeries(events: ChainEvent[], state: AppState | null): Series[] {
  const mid: Series["points"] = [];
  const fills: Series["points"] = [];
  for (const e of events) {
    const d = e.data ?? {};
    if (e.event === "order_posted" && d.reference_out) {
      const gross = Number((BigInt(d.reference_out) * 10_000n) / (10_000n - ONECLICK_COST_BPS));
      const inUnits = Number(d.amount_in);
      mid.push({ time: e.time / 1000, value: d.side === "Buy" ? inUnits / 1e6 / (gross / 1e24) : gross / 1e6 / (inUnits / 1e24) });
    }
    if (e.event === "order_filled") fills.push({ time: e.time / 1000, value: Number(d.price) / 1e6 });
  }
  if (state?.reference) mid.push({ time: state.reference.at / 1000, value: state.reference.mid });
  return [
    { name: "1Click mid", color: "#d7bcff", points: mid },
    { name: "Fill price", color: "#8ef0b3", points: fills, dots: true },
  ];
}

export function Dashboard() {
  const { data: state } = useAppState();
  const { data: stats } = useStats();
  const config = useConfig();
  const firmName = useFirmName(state);
  const scene = useRef<SceneApi | null>(null);
  const driver = useRef<((e: any) => void) | null>(null);
  const [phase, setPhase] = useState(-1);
  const events = useEvents(500, (e) => driver.current?.(e));
  const now = useChainNow(state);
  const firmNames = useMemo(() => state?.firms.map((f) => nameOf(f)) ?? null, [state?.firms.length]);
  // Recompute the chart only when an order event arrives or the reference moves, so a zoom survives the polls.
  const lastOrderEvent = events.reduce((k, e) => (e.event === "order_filled" || e.event === "order_posted" ? e.id : k), 0);
  const series = useMemo(() => priceSeries(events, state), [lastOrderEvent, state?.reference.at]);

  const open = state?.orders.filter((o) => o.status === "Open") ?? [];
  const avgBp = stats && stats.fills ? stats.improvementBps / stats.fills : null;
  const share = (config?.tenderConfig?.dividend_bps ?? 0) / 100;

  return (
    <div className="page-app">
      <div className="page-head">
        <div>
          <h1>Live market</h1>
          <p className="sub">Every figure on this page is read from the chain: the tender contract, the firm contracts and the events they emit.</p>
        </div>
        <Link className="btn primary" to="/app/trade">
          <i className="fa-solid fa-arrow-right-arrow-left" aria-hidden="true" /> Trade NEAR
        </Link>
      </div>

      <div className="kpis">
        <Kpi icon="fa-right-left" label="Orders filled" value={stats ? stats.fills : "…"} hint={stats ? `${stats.orders} posted, ${stats.refunded} refunded` : ""} />
        <Kpi icon="fa-coins" label="Volume" value={stats ? usdc(stats.volume) : "…"} unit="USDC" hint="notional of the fills" />
        <Kpi icon="fa-arrow-trend-up" label="Vs 1Click" value={stats ? bpText(avgBp) : "…"} hint="average per fill, over the NEAR Intents quote" />
        <Kpi icon="fa-hand-holding-dollar" label="Dividends" value={stats ? usdc(stats.dividends) : "…"} unit="USDC" hint={share ? `${share}% of each fill's edge` : "a share of each fill's edge"} />
        <Kpi icon="fa-scissors" label="Bonds slashed" value={stats ? usdc(stats.slashed) : "…"} unit="USDC" hint="quotes sealed, never revealed" />
        <Kpi icon="fa-handshake" label="Takeovers" value={stats ? stats.takeovers : "…"} hint={stats ? `${stats.liquidations} liquidation${stats.liquidations === 1 ? "" : "s"}` : ""} />
      </div>

      <div className="grid-main">
        <Card
          className="arena-card"
          title={
            <>
              <span className="live-dot" aria-hidden="true" /> The swarm, live
            </>
          }
          action={<PhaseStrip phase={phase} />}
        >
          <SceneView
            mode="live"
            className="arena"
            firmNames={firmNames}
            onReady={(api) => {
              scene.current = api;
              api.setExplore(true);
              driver.current = liveDriver(api, firmName);
            }}
            onPhase={setPhase}
            fallback={<Empty>The city view needs a canvas. The figures and the feed below are live anyway.</Empty>}
          />
          <p className="caption">Each building is a firm. An order is the airship: sealed bids fly to it, the winner lights up, coins carry the fill and the dividends to its shareholders. A firm in liquidation goes dark until a rival buys it and repaints it in its colours.</p>
        </Card>

        <Card title="Live feed" className="feed-card">
          <EventFeed events={events} firm={firmName} limit={40} />
        </Card>
      </div>

      <Card
        title="NEAR price, USD"
        action={
          state ? (
            <span className="card-note">
              1Click mid {state.reference.mid.toFixed(4)} ({state.reference.source === "1click" ? "live quote" : "replayed prices"}) · last clearing price {(Number(state.lastPrice) / 1e6).toFixed(4)}
            </span>
          ) : null
        }
      >
        <LineChart series={series} empty="No order in the recent events yet." />
        <p className="caption">The line is the NEAR Intents 1Click mid behind each order's reference quote. The dots are the prices orders filled at on tender, which also anchor the firms' price bands.</p>
      </Card>

      <Card title="Auctions in progress" action={<Link to="/app/orders">All orders</Link>}>
        {open.length ? <OpenOrders orders={open} now={now} /> : <Empty>No auction right now. The house client posts an order every minute or so, or trade yourself.</Empty>}
      </Card>

      <Card title="Firms" action={<Link to="/app/firms">Details</Link>}>
        <FirmsTable state={state} />
      </Card>
    </div>
  );
}

function OpenOrders({ orders, now }: { orders: OrderState[]; now: bigint }) {
  return (
    <div className="active-orders">
      {orders.map((o) => {
        const a = o.auctionState;
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
          <Link key={o.id} className="order-row" to={`/app/orders/${o.id}`}>
            <span className="order-id">#{o.id}</span>
            <span className="order-what">{o.side === "Buy" ? `Buy NEAR with ${paidText(o.side, o.amount_in)}` : `Sell ${paidText(o.side, o.amount_in)}`}</span>
            <span className="order-amount">at least {gotText(o.side, o.min_out)}</span>
            <span className="order-phase">{phase}</span>
            <Badge status={o.status} />
          </Link>
        );
      })}
    </div>
  );
}

export function FirmsTable({ state }: { state: AppState | null }) {
  if (!state) return <Empty>Loading the firms…</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Firm</th>
            <th>Status</th>
            <th className="num">Cash</th>
            <th className="num">NEAR</th>
            <th className="num">NAV</th>
            <th className="num">Fills</th>
            <th className="num">Volume</th>
            <th className="num">Edge</th>
            <th className="num">Dividends</th>
            <th className="num">Owner bond</th>
            <th className="num">Holders</th>
          </tr>
        </thead>
        <tbody>
          {state.firms.map((f, i) => (
            <tr key={f.id}>
              <td>
                <FirmChip id={f.id} name={nameOf(f)} index={i} />
              </td>
              <td>
                <Badge status={f.status} />
              </td>
              <td className="num">{usdc(f.treasury)}</td>
              <td className="num">{near(f.inventory)}</td>
              <td className="num">{usdc(f.nav)}</td>
              <td className="num">{f.fills}</td>
              <td className="num">{usdc(f.volume)}</td>
              <td className="num">{usdc(f.edge, 4)}</td>
              <td className="num">{usdc(f.dividends, 4)}</td>
              <td className="num">{usdc(f.ownerBond)}</td>
              <td className="num">{f.holdings.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
