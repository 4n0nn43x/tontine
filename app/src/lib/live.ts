// Turns chain events into the scene's story steps, so the 3D swarm shows what really happens on chain.
import type { ChainEvent } from "./api";
import { usdc } from "./format";

type Scene = { act(step: Record<string, unknown>): void };

export function liveDriver(scene: Scene, firmName: (id: number) => string) {
  const auctionTarget = new Map<number, number>(); // liquidation auction id -> firm id
  const later = (ms: number, step: Record<string, unknown>) => setTimeout(() => scene.act(step), ms);

  return (e: ChainEvent) => {
    if (e.standard !== "tontine") return;
    const d = e.data ?? {};
    switch (e.event) {
      case "job_posted":
        scene.act({ do: "job", id: d.job_id, budget: usdc(d.budget), brief: String(d.brief ?? "").slice(0, 48) });
        break;
      case "liquidation_started":
        auctionTarget.set(d.auction_id, d.firm_id);
        scene.act({ do: "epoch", firm: firmName(d.firm_id), n: 2, liquidating: true });
        break;
      case "bid_committed": {
        const target = auctionTarget.get(d.auction_id);
        scene.act({ do: "commit", firm: firmName(d.firm_id), target: target === undefined ? undefined : firmName(target) });
        break;
      }
      case "bid_revealed":
        scene.act({ do: "reveal", firm: firmName(d.firm_id), price: usdc(d.amount) });
        break;
      case "auction_settled":
        if (d.winner !== null && !auctionTarget.has(d.auction_id)) {
          scene.act({ do: "win", firm: firmName(d.winner), price: usdc(d.price) });
          later(900, { do: "work", firm: firmName(d.winner) });
        }
        break;
      case "delivered":
        if (!d.result) scene.act({ do: "work", firm: firmName(d.firm_id), empty: true });
        break;
      case "paid":
        scene.act({ do: "verdict", firm: firmName(d.firm_id), accept: true });
        scene.act({ do: "pay", firm: firmName(d.firm_id), price: usdc(d.price), firmShare: usdc(d.to_firm), dividends: usdc(d.dividends) });
        later(2600, { do: "jobEnd" });
        break;
      case "slashed":
        scene.act({ do: "verdict", firm: firmName(d.firm_id), accept: false });
        scene.act({ do: "slash", firm: firmName(d.firm_id), bond: usdc(d.amount) });
        later(2600, { do: "jobEnd" });
        break;
      case "firm_closed":
        scene.act({ do: "close", firm: firmName(d.firm_id) });
        break;
      case "liquidated":
        scene.act({ do: "takeover", buyer: firmName(d.buyer_firm_id), target: firmName(d.firm_id), price: usdc(d.price), fee: usdc(d.fee), holders: usdc(d.to_shareholders) });
        later(2500, { do: "keys", target: firmName(d.firm_id) });
        break;
    }
  };
}
