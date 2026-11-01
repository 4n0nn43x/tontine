// Turns chain events into the scene's story steps, so the city shows what really happens on chain, in every market.
import { getConfig, marketOf, nameOf, SYMBOLS, type AppState, type ChainEvent, type Config, type FirmState, type MarketSymbol, type Side } from "./api";
import { amount, ASSETS, auctionAmount, bpOver, bpText, clientOut, digitsOf, gotText, paidText, usdc, type Asset } from "./format";

type Scene = { act(step: Record<string, unknown>): void };

/** A firm's name in the city: NEAR firms keep theirs, the others carry their market's ticker. */
export const cityName = (name: string, symbol: string) => (symbol === "NEAR" ? name : `${name} · ${symbol}`);
/** A firm's id in the city: its chain id on NEAR, "ETH:3" on another market (ids repeat across tenders). */
export const cityId = (id: number, symbol: string): number | string => (symbol === "NEAR" ? id : `${symbol}:${id}`);
/** The firm page of a city id. */
export const cityLink = (id: number | string) => {
  const [s, n] = String(id).includes(":") ? String(id).split(":") : ["NEAR", String(id)];
  return s === "NEAR" ? `/app/firms/${n}` : `/app/firms/${n}?market=${s}`;
};

/** `firmName(id, contract)` resolves a firm on the tender that emitted the event. */
export function liveDriver(scene: Scene, firmName: (id: number, contract: string) => string) {
  const auctionTarget = new Map<string, number>(); // tender:liquidation auction id -> firm id
  const orders = new Map<string, { side: Side; ref: string | null }>(); // tender:order auction id -> its side and market reference
  const later = (ms: number, step: Record<string, unknown>) => setTimeout(() => scene.act(step), ms);
  let dividendBps = 0;
  let config: Config | null = null;
  getConfig().then((c) => ((config = c), (dividendBps = Number(c.tenderConfig?.dividend_bps ?? 0))), () => {});

  return (e: ChainEvent) => {
    if (e.standard !== "tontine") return;
    const d = e.data ?? {};
    const symbol = marketOf(config, e.contract)?.symbol ?? "NEAR";
    const a: Asset = ASSETS[symbol];
    const name = (id: number) => cityName(firmName(id, e.contract), symbol);
    const key = (id: number) => `${e.contract}:${id}`;
    switch (e.event) {
      case "order_posted":
        orders.set(key(d.auction_id), { side: d.side, ref: d.reference_out ?? null });
        scene.act({ do: "order", id: d.order_id, side: d.side, asset: symbol, amount: paidText(d.side, d.amount_in, a), min: gotText(d.side, d.min_out, a) });
        break;
      case "liquidation_started":
        auctionTarget.set(key(d.auction_id), d.firm_id);
        scene.act({ do: "epoch", firm: name(d.firm_id), liquidating: true });
        break;
      case "bid_committed": {
        const target = auctionTarget.get(key(d.auction_id));
        scene.act({ do: "commit", firm: name(d.firm_id), target: target === undefined ? undefined : name(target) });
        break;
      }
      case "bid_revealed": {
        const o = orders.get(key(d.auction_id));
        const vs = o ? bpOver(d.amount, o.ref) : null;
        scene.act({ do: "reveal", firm: name(d.firm_id), price: auctionAmount(d.amount, o?.side, a), note: vs === null ? undefined : `${bpText(vs)} vs market` });
        break;
      }
      case "auction_settled":
        if (d.winner !== null && !auctionTarget.has(key(d.auction_id))) scene.act({ do: "win", firm: name(d.winner), price: auctionAmount(d.price, orders.get(key(d.auction_id))?.side, a) });
        break;
      case "order_filled": {
        const edge = BigInt(d.edge ?? 0);
        const dividends = edge > 0n ? (edge * BigInt(dividendBps)) / 10_000n : 0n;
        // What the client received: the second best less Tontine's surplus share.
        scene.act({ do: "fill", firm: name(d.firm_id), price: gotText(d.side, clientOut(d), a), edge: usdc(edge, 4), dividends: usdc(dividends, 4) });
        later(2600, { do: "orderEnd" });
        break;
      }
      case "order_refunded":
        later(1200, { do: "orderEnd" });
        break;
      case "slashed":
        scene.act({ do: "slash", firm: name(d.firm_id), bond: usdc(d.amount) });
        break;
      case "firm_closed":
        scene.act({ do: "close", firm: name(d.firm_id), reason: d.reason });
        break;
      case "liquidated":
        scene.act({
          do: "takeover",
          buyer: name(d.buyer_firm_id),
          target: name(d.firm_id),
          price: `${usdc(d.price)} USDC`,
          fee: usdc(d.fee),
          holders: `${usdc(d.to_shareholders)} USDC`,
          near: BigInt(d.asset_to_shareholders ?? 0) > 0n ? amount(d.asset_to_shareholders, a.decimals, digitsOf(a)) : undefined,
          asset: symbol,
        });
        later(2500, { do: "keys", target: name(d.firm_id) });
        break;
    }
  };
}

/** Every market's firms as the city draws them: tower height follows value and fills, status drives its life stage. */
export function cityFirms(states: Partial<Record<MarketSymbol, AppState | null>>) {
  return SYMBOLS.flatMap((s) =>
    (states[s]?.firms ?? []).map((f: FirmState) => ({ id: cityId(f.id, s), name: cityName(nameOf(f), s), nav: Number(f.nav) / 1e6, fills: f.fills, status: f.status, takeovers: f.takeovers })),
  );
}

/** The NEAR price on the exchange's board: the last clearing price, else the market mid. */
export function cityMarket(state: AppState | null | undefined) {
  if (!state) return {};
  const last = Number(state.lastPrice) / 1e6;
  return { price: last > 0 ? last : state.reference?.mid };
}
