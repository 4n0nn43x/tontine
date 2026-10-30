import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Card, Countdown, Empty, EventFeed, FirmChip } from "../components/ui";
import { getConfig, type ChainEvent, type OrderState } from "../lib/api";
import { ago, bpOver, bpText, describe, gotText, paidText, priceOf, short, usdc } from "../lib/format";
import { useAppState, useChainNow, useConfig, useEvents, useFirmName, useWallet } from "../lib/hooks";
import { view } from "../lib/near";

function clientLabel(client: string, house: string | undefined, me: string | undefined) {
  if (me && client === me) return "you";
  if (house && client === house) return "house client";
  return short(client);
}

export function Orders() {
  const { data: state } = useAppState();
  const wallet = useWallet();
  const config = useConfig();
  const name = useFirmName(state);
  return (
    <div className="page-app">
      <div className="page-head">
        <div>
          <h1>Orders</h1>
          <p className="sub">Each order is a sealed-bid auction between the firms. The best quote wins and delivers the second best, and never less than the client's minimum, set at what NEAR Intents 1Click would give. No quote above it: the client is refunded.</p>
        </div>
        <Link className="btn primary" to="/app/trade">
          <i className="fa-solid fa-arrow-right-arrow-left" aria-hidden="true" /> Trade NEAR
        </Link>
      </div>
      <Card title={state ? `Latest ${state.orders.length} of ${state.totalOrders} orders` : undefined}>
        {!state ? (
          <Empty>Loading…</Empty>
        ) : !state.orders.length ? (
          <Empty>No order yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Side</th>
                  <th className="num">Pays</th>
                  <th className="num">At least</th>
                  <th>Client</th>
                  <th>Status</th>
                  <th>Winner</th>
                  <th className="num">Got</th>
                  <th className="num">Vs 1Click</th>
                </tr>
              </thead>
              <tbody>
                {state.orders.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link to={`/app/orders/${o.id}`}>#{o.id}</Link>
                    </td>
                    <td>
                      <Link to={`/app/orders/${o.id}`}>{o.side === "Buy" ? "Buy NEAR" : "Sell NEAR"}</Link>
                    </td>
                    <td className="num">{paidText(o.side, o.amount_in)}</td>
                    <td className="num">{gotText(o.side, o.min_out)}</td>
                    <td>{clientLabel(o.client, config?.houseClient, wallet?.accountId)}</td>
                    <td>
                      <Badge status={o.status} />
                    </td>
                    <td>{o.firm !== null ? <FirmChip id={o.firm} name={name(o.firm)} index={o.firm} /> : "–"}</td>
                    <td className="num">{o.out ? gotText(o.side, o.out) : "–"}</td>
                    <td className="num">{bpText(bpOver(o.out, o.reference_out))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/** The order, from the cached state while it is recent, else read from the chain. */
function useOrder(id: number): OrderState | null {
  const { data: state } = useAppState();
  const fromState = state?.orders.find((o) => o.id === id) ?? null;
  const [fetched, setFetched] = useState<OrderState | null>(null);
  useEffect(() => {
    if (fromState || !Number.isFinite(id)) return;
    let alive = true;
    (async () => {
      const c = await getConfig();
      const order = await view(c.tender, "get_order", { order_id: id });
      const auctionState = await view(c.tender, "get_auction", { auction_id: order.auction });
      if (alive) setFetched({ ...order, auctionState });
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, !!fromState]);
  return fromState ?? fetched;
}

export function OrderDetail() {
  const id = Number(useParams().id);
  const { data: state } = useAppState();
  const name = useFirmName(state);
  const now = useChainNow(state);
  const events = useEvents(500);
  const config = useConfig();
  const wallet = useWallet();
  const o = useOrder(id);
  if (!o) return <div className="page-app"><Empty>Loading order #{id}…</Empty></div>;

  const a = o.auctionState;
  const own = events.filter((e) => e.data?.order_id === id || (e.data?.auction_id === o.auction && e.event !== "liquidation_started"));
  const txs = new Set(own.map((e) => e.txHash));
  // The deposit and the keeper reward travel in the same transactions as the order's own events.
  const mine = events.filter((e) => txs.has(e.txHash));
  const filled = own.find((e) => e.event === "order_filled")?.data;
  const slashed = own.filter((e) => e.event === "slashed").map((e) => e.data.firm_id as number);
  // Best quote first; the sort is stable, so equal quotes keep commit order, as the contract breaks ties.
  const v = (b: { revealed: string | null }) => BigInt(b.revealed ?? -1);
  const bids = [...a.bids].sort((x, y) => (v(y) > v(x) ? 1 : v(y) < v(x) ? -1 : 0));
  const second = o.out && a.winner !== null ? bids.find((b) => b.firm_id !== a.winner && b.revealed === o.out) : undefined;
  const dividendBps = BigInt(config?.tenderConfig?.dividend_bps ?? 0);
  const edge = filled ? BigInt(filled.edge) : null;
  const minBidders = Math.max(1, Number(config?.tenderConfig?.min_bidders ?? 1));
  const side = o.side;

  return (
    <div className="page-app">
      <div className="page-head">
        <div>
          <p className="crumbs">
            <Link to="/app/orders">Orders</Link> / #{o.id}
          </p>
          <h1>
            Order #{o.id} <Badge status={o.status} />
          </h1>
          <p className="sub">
            {side === "Buy" ? `Buy NEAR with ${paidText(side, o.amount_in)}` : `Sell ${paidText(side, o.amount_in)} for USDC`}, at least {gotText(side, o.min_out)}. Client: {clientLabel(o.client, config?.houseClient, wallet?.accountId)}.
          </p>
        </div>
      </div>

      <div className="grid-2">
        <Card title="Auction">
          <dl className="facts">
            <dt>Escrowed by the client</dt>
            <dd>{paidText(side, o.amount_in)}</dd>
            <dt>Minimum (reserve)</dt>
            <dd>{gotText(side, o.min_out)}</dd>
            <dt>1Click reference</dt>
            <dd>{o.reference_out ? `${gotText(side, o.reference_out)}, what NEAR Intents 1Click quoted when the order was posted` : "none given"}</dd>
            <dt>Band anchor</dt>
            <dd>{(Number(o.price) / 1e6).toFixed(4)} USD per NEAR, tender's last clearing price when posted</dd>
            <dt>Commit phase</dt>
            <dd>{now < BigInt(a.commit_end) ? <>ends in <Countdown until={BigInt(a.commit_end)} now={now} /></> : "closed"}</dd>
            <dt>Reveal phase</dt>
            <dd>{now < BigInt(a.reveal_end) ? <>ends in <Countdown until={BigInt(a.reveal_end)} now={now} /></> : a.settled ? "closed, settled" : "closed, waiting for a settle"}</dd>
          </dl>
          <table className="table bids">
            <thead>
              <tr>
                <th>Firm</th>
                <th>Quote</th>
                <th className="num">Delivers</th>
                <th className="num">Vs 1Click</th>
              </tr>
            </thead>
            <tbody>
              {bids.length ? (
                bids.map((b) => (
                  <tr key={b.firm_id} className={a.winner === b.firm_id ? "winner" : ""}>
                    <td>
                      <FirmChip id={b.firm_id} name={name(b.firm_id)} index={b.firm_id} />
                    </td>
                    <td>
                      {b.revealed !== null
                        ? a.winner === b.firm_id
                          ? "best, wins"
                          : b === second
                            ? "second best, sets the fill"
                            : "revealed"
                        : a.settled
                          ? slashed.includes(b.firm_id)
                            ? "never revealed, bond slashed"
                            : "never revealed"
                          : "sealed"}
                    </td>
                    <td className="num">{b.revealed !== null ? gotText(side, b.revealed) : <span className="sealed">{b.hash.slice(0, 10)}…</span>}</td>
                    <td className="num">{b.revealed !== null ? bpText(bpOver(b.revealed, o.reference_out)) : "–"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4}>No bid yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>

        <Card title="Settlement">
          {o.status === "Open" ? (
            <Empty>{now < BigInt(a.commit_end) ? "Firms are sealing their quotes." : now < BigInt(a.reveal_end) ? "Firms are revealing their quotes." : "The auction is over: the next settle fills or refunds it."}</Empty>
          ) : o.status === "Refunded" ? (
            <Empty>
              No fill: fewer than {minBidders} quote{minBidders === 1 ? "" : "s"} at or above the minimum were revealed. The client got its {paidText(side, o.amount_in)} back.
            </Empty>
          ) : (
            <dl className="facts">
              <dt>Filled by</dt>
              <dd>{o.firm !== null ? <FirmChip id={o.firm} name={name(o.firm)} index={o.firm} /> : "–"}</dd>
              <dt>Client received</dt>
              <dd>
                {gotText(side, o.out)} {second ? "(the second best quote)" : a.bids.filter((b) => b.revealed !== null).length === 1 ? "(alone: the minimum)" : ""}
              </dd>
              <dt>Vs 1Click</dt>
              <dd className="good">{bpText(bpOver(o.out, o.reference_out))}</dd>
              <dt>Price</dt>
              <dd>{priceOf(side, o.amount_in, o.out!).toFixed(4)} USD per NEAR</dd>
              <dt>Tontine fee</dt>
              <dd>{filled ? `${paidText(side, filled.fee)}, taken from what the firm receives` : "–"}</dd>
              <dt>Firm's edge</dt>
              <dd>{edge !== null ? `${usdc(edge, 4)} USDC: what it received minus what it delivered, at the previous clearing price` : "not in the recent events"}</dd>
              <dt>To its shareholders</dt>
              <dd>{edge !== null ? `${usdc(edge > 0n ? (edge * dividendBps) / 10_000n : 0n, 4)} USDC (${Number(dividendBps) / 100}% of a positive edge)` : "–"}</dd>
            </dl>
          )}
        </Card>
      </div>

      <Card title="Transactions">
        <TxTable events={mine} name={name} side={side} />
      </Card>

      <Card title="Events, in words">
        <EventFeed events={mine} firm={name} limit={60} />
      </Card>
    </div>
  );
}

/** Explorer-style: every event of the order with its block, transaction and signer. */
function TxTable({ events, name, side }: { events: ChainEvent[]; name: (id: number) => string; side: "Buy" | "Sell" }) {
  if (!events.length) return <Empty>No event of this order in the recent history.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Event</th>
            <th>What happened</th>
            <th className="num">Block</th>
            <th>Transaction</th>
            <th>Signer</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td>
                <code>{e.event}</code>
              </td>
              <td>{describe(e, name, () => side)?.text ?? e.event.replace(/_/g, " ")}</td>
              <td className="num">{e.height}</td>
              <td>
                <code className="hash" title={e.txHash}>
                  {e.txHash.slice(0, 10)}…
                </code>
              </td>
              <td>{short(e.signer, 24)}</td>
              <td>{ago(e.time)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
