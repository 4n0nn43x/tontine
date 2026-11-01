// SEALED, the game of /city: every live auction is a round. While the firms' bids are sealed, the visitor backs
// the firm they think will win, with play chips (no money, nothing on chain); the reveal settles it. Pure logic,
// no DOM: the page feeds it chain events and reads rounds and the player back. Tested in ts/src/sealed.test.ts.

export type Market = "NEAR" | "ETH" | "SOL";
export type Phase = "sealed" | "revealed" | "settled" | "refunded";
export type Bet = { firm: number; stake: number; odds: number };
export type Round = {
  key: string; // market:auction (ids repeat across markets)
  market: Market;
  auction: number;
  order: number;
  side: "Buy" | "Sell";
  client: string;
  at: number;
  bidders: number[];
  revealed: Record<number, string>;
  phase: Phase;
  winner: number | null;
  bet: Bet | null;
  /** Chips the bet paid back (stake included), once resolved: 0 if it lost. */
  paid: number | null;
};
export type Player = { chips: number; streak: number; best: number; calls: number; hits: number; pity: number; badges: string[]; day: string; today: number };
export type Ev = { event: string; market: Market; data: any };

export const START_CHIPS = 100;
/** Under PITY_BELOW after a loss, the player is topped back up to PITY_TO: a broke player keeps playing. */
export const PITY_BELOW = 10;
export const PITY_TO = 25;
export const STAKES = [10, 25, 50] as const;
const MAX_ODDS = 8;
const MIN_ODDS = 1.1;

export const newPlayer = (day: string): Player => ({ chips: START_CHIPS, streak: 0, best: 0, calls: 0, hits: 0, pity: 0, badges: [], day, today: 0 });

/**
 * Decimal odds for each bidder: its chance is its share of the bidders' past fills (plus one each, so a new firm
 * is not impossible), and the odds pay that chance back less 8%, between 1.1 and 8.
 */
export function oddsOf(bidders: number[], fills: (firm: number) => number): Map<number, number> {
  const w = bidders.map((b) => Math.max(0, fills(b)) + 1);
  const total = w.reduce((a, b) => a + b, 0);
  return new Map(bidders.map((b, i) => [b, Math.min(MAX_ODDS, Math.max(MIN_ODDS, Math.round((0.92 * total * 10) / w[i]) / 10))]));
}

export class Sealed {
  rounds = new Map<string, Round>();
  constructor(public player: Player, private now = () => Date.now()) {}

  /** Applies one chain event; returns the round it touched, if any. */
  apply(e: Ev): Round | null {
    const d = e.data ?? {};
    const key = `${e.market}:${d.auction_id}`;
    switch (e.event) {
      case "order_posted": {
        const r: Round = { key, market: e.market, auction: d.auction_id, order: d.order_id, side: d.side, client: d.client, at: this.now(), bidders: [], revealed: {}, phase: "sealed", winner: null, bet: null, paid: null };
        this.rounds.set(key, r);
        this.prune();
        return r;
      }
      case "bid_committed": {
        const r = this.rounds.get(key);
        if (!r || r.phase !== "sealed" || r.bidders.includes(d.firm_id)) return null;
        r.bidders.push(d.firm_id);
        return r;
      }
      case "bid_revealed": {
        const r = this.rounds.get(key);
        if (!r || (r.phase !== "sealed" && r.phase !== "revealed")) return null;
        r.phase = "revealed";
        r.revealed[d.firm_id] = String(d.amount);
        return r;
      }
      case "auction_settled": {
        const r = this.rounds.get(key);
        if (!r || r.phase === "settled" || r.phase === "refunded") return null;
        if (d.winner === null) return this.refund(r);
        r.phase = "settled";
        r.winner = d.winner;
        this.resolve(r);
        return r;
      }
      case "order_refunded": {
        const r = [...this.rounds.values()].find((x) => x.market === e.market && x.order === d.order_id);
        return r && r.phase !== "settled" && r.phase !== "refunded" ? this.refund(r) : null;
      }
    }
    return null;
  }

  /** Backs a sealed bidder of an open round with `stake` chips at the odds of the moment. */
  back(key: string, firm: number, stake: number, odds: Map<number, number>): string | null {
    const r = this.rounds.get(key);
    if (!r || r.phase !== "sealed") return "The bids are already revealed.";
    if (r.bet) return "You already backed a firm in this round.";
    if (!r.bidders.includes(firm)) return "That firm has no sealed bid here.";
    if (!(stake > 0) || stake > this.player.chips) return "Not enough chips.";
    r.bet = { firm, stake, odds: odds.get(firm) ?? MIN_ODDS };
    this.player.chips -= stake;
    return null;
  }

  private refund(r: Round): Round {
    r.phase = "refunded";
    if (r.bet && r.paid === null) {
      r.paid = r.bet.stake;
      this.player.chips += r.bet.stake;
    }
    return r;
  }

  private resolve(r: Round) {
    const b = r.bet;
    if (!b || r.paid !== null) return;
    const p = this.player;
    p.calls++;
    if (b.firm === r.winner) {
      r.paid = Math.round(b.stake * b.odds);
      p.chips += r.paid;
      p.hits++;
      p.streak++;
      p.best = Math.max(p.best, p.streak);
      p.today += r.paid - b.stake;
      this.badge("first-call", p.hits >= 1);
      this.badge("hat-trick", p.streak >= 3);
      this.badge("oracle", p.hits >= 10);
      this.badge("longshot", b.odds >= 3);
    } else {
      r.paid = 0;
      p.streak = 0;
      p.today -= b.stake;
      if (p.chips < PITY_BELOW) {
        p.pity++;
        p.chips = PITY_TO;
      }
    }
    this.badge("high-roller", b.stake >= 50);
  }

  private badge(id: string, earned: boolean) {
    if (earned && !this.player.badges.includes(id)) this.player.badges.push(id);
  }

  /** Keeps the last 30 rounds. */
  private prune() {
    const keys = [...this.rounds.keys()];
    for (const k of keys.slice(0, Math.max(0, keys.length - 30))) this.rounds.delete(k);
  }
}

export const BADGES: Record<string, { label: string; icon: string; tip: string }> = {
  "first-call": { label: "First call", icon: "fa-bullseye", tip: "Backed the winner once" },
  "hat-trick": { label: "Hat trick", icon: "fa-fire", tip: "Three winners in a row" },
  oracle: { label: "Oracle", icon: "fa-eye", tip: "Ten winners called" },
  longshot: { label: "Longshot", icon: "fa-rocket", tip: "Won at odds of 3 or more" },
  "high-roller": { label: "High roller", icon: "fa-coins", tip: "Staked 50 chips on one call" },
};

/** The player from localStorage (a new one each day keeps the badges and the best streak). */
export function loadPlayer(raw: string | null, day: string): Player {
  try {
    const p = { ...newPlayer(day), ...JSON.parse(raw ?? "null") } as Player;
    return p.day === day ? p : { ...newPlayer(day), best: p.best, badges: p.badges, chips: Math.max(p.chips, START_CHIPS) };
  } catch {
    return newPlayer(day);
  }
}

/** Seconds left to back a firm: the order's commit end against the chain clock the market state last saw. */
export function secondsLeft(r: Round, s: { orders: { id: number; auctionState: { commit_end: number | string } }[]; chainTime: string; updatedAt: number } | null | undefined): number | null {
  const o = s?.orders.find((x) => x.id === r.order);
  if (!o || !s) return null;
  const now = BigInt(s.chainTime) + BigInt(Date.now() - s.updatedAt) * 1_000_000n;
  return Math.max(0, Math.ceil(Number(BigInt(o.auctionState.commit_end) - now) / 1e9));
}
