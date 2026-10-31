// Turns chain events into the scene's story steps, so the city shows what really happens on chain.
import { getConfig, nameOf, type AppState, type ChainEvent, type Side } from "./api";
import { auctionAmount, bpOver, bpText, gotText, near, paidText, usdc } from "./format";

type Scene = { act(step: Record<string, unknown>): void };

export function liveDriver(scene: Scene, firmName: (id: number) => string) {
  const auctionTarget = new Map<number, number>(); // liquidation auction id -> firm id
  const orders = new Map<number, { side: Side; ref: string | null }>(); // order auction id -> its side and 1Click reference
  const later = (ms: number, step: Record<string, unknown>) => setTimeout(() => scene.act(step), ms);
  let dividendBps = 0;
  getConfig().then((c) => (dividendBps = Number(c.tenderConfig?.dividend_bps ?? 0)), () => {});

  return (e: ChainEvent) => {
    if (e.standard !== "tontine") return;
    const d = e.data ?? {};
    switch (e.event) {
      case "order_posted":
        orders.set(d.auction_id, { side: d.side, ref: d.reference_out ?? null });
        scene.act({ do: "order", id: d.order_id, side: d.side, amount: paidText(d.side, d.amount_in), min: gotText(d.side, d.min_out) });
        break;
      case "liquidation_started":
        auctionTarget.set(d.auction_id, d.firm_id);
        scene.act({ do: "epoch", firm: firmName(d.firm_id), liquidating: true });
        break;
      case "bid_committed": {
        const target = auctionTarget.get(d.auction_id);
        scene.act({ do: "commit", firm: firmName(d.firm_id), target: target === undefined ? undefined : firmName(target) });
        break;
      }
      case "bid_revealed": {
        const o = orders.get(d.auction_id);
        const vs = o ? bpOver(d.amount, o.ref) : null;
        scene.act({ do: "reveal", firm: firmName(d.firm_id), price: auctionAmount(d.amount, o?.side), note: vs === null ? undefined : `${bpText(vs)} vs 1Click` });
        break;
      }
      case "auction_settled":
        if (d.winner !== null && !auctionTarget.has(d.auction_id)) scene.act({ do: "win", firm: firmName(d.winner), price: auctionAmount(d.price, orders.get(d.auction_id)?.side) });
        break;
      case "order_filled": {
        const edge = BigInt(d.edge ?? 0);
        const dividends = edge > 0n ? (edge * BigInt(dividendBps)) / 10_000n : 0n;
        scene.act({ do: "fill", firm: firmName(d.firm_id), price: gotText(d.side, d.out), edge: usdc(edge, 4), dividends: usdc(dividends, 4) });
        later(2600, { do: "orderEnd" });
        break;
      }
      case "order_refunded":
        later(1200, { do: "orderEnd" });
        break;
      case "slashed":
        scene.act({ do: "slash", firm: firmName(d.firm_id), bond: usdc(d.amount) });
        break;
      case "firm_closed":
        scene.act({ do: "close", firm: firmName(d.firm_id), reason: d.reason });
        break;
      case "liquidated":
        scene.act({
          do: "takeover",
          buyer: firmName(d.buyer_firm_id),
          target: firmName(d.firm_id),
          price: `${usdc(d.price)} USDC`,
          fee: usdc(d.fee),
          holders: `${usdc(d.to_shareholders)} USDC`,
          near: BigInt(d.asset_to_shareholders ?? 0) > 0n ? near(d.asset_to_shareholders) : undefined,
        });
        later(2500, { do: "keys", target: firmName(d.firm_id) });
        break;
    }
  };
}

/** The firms as the city draws them: tower height follows value and fills, status drives its life stage. */
export function cityFirms(state: AppState) {
  return state.firms.map((f) => ({ id: f.id, name: nameOf(f), nav: Number(f.nav) / 1e6, fills: f.fills, status: f.status, takeovers: f.takeovers }));
}

/** The NEAR price on the exchange's board: the last clearing price, else the 1Click mid. */
export function cityMarket(state: AppState) {
  const last = Number(state.lastPrice) / 1e6;
  return { price: last > 0 ? last : state.reference?.mid };
}
