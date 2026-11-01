// Shadow quotes: what a managed firm would have won had another manager set its bid, on the same auctions.
// And a signed decision log: every decision as JSON in a sha256 hash chain, with a daily Merkle root to publish.
import { createHash } from "node:crypto";
import { clear, edge as edgeOf, type Side } from "./rules.ts";

export type Arm = "actual" | "rule" | "fixed";
export const ARMS: Arm[] = ["actual", "rule", "fixed"];

/** One auction as the firm saw it when it committed, with each arm's bid (null: that arm passes). */
export type ShadowOrder = {
  auction: number;
  firmId: number;
  side: Side;
  amountIn: bigint;
  /** The client's minimum. */
  reserve: bigint;
  feeBps: number;
  /** Reference mid, stable base units per asset unit: the edge is valued at it. */
  ref: bigint;
  unit: bigint;
  bids: Record<Arm, bigint | null>;
};
export type Revealed = { firmId: number; amount: bigint };
export type Outcome = { won: boolean; out: bigint; edge: bigint };
/** Auctions the arm bid in, wins, what it delivered (stable base units at the reference) and its edge at the reference. */
export type ArmStats = { auctions: number; wins: number; delivered: bigint; edge: bigint };

/**
 * The second-price outcome with `bid` in place of `firmId`'s revealed bid (null: it passes). `revealed` is in
 * commit order, as get_auction lists it; clearing is rules.ts `clear` (the contract's clear_auction: highest
 * wins, earliest commit on ties, second best or the reserve). A bid under the reserve would be refused at
 * reveal, and settle fills only with `minBidders` revealed bids (the contract's min_bidders).
 * Other firms keep their bids: the counterfactual assumes no one reacts. A shadow bid the firm did not
 * reveal goes last, so it loses ties.
 */
export function counterfactual(revealed: Revealed[], firmId: number, bid: bigint | null, reserve: bigint, minBidders = 2): { winner: number; out: bigint } | null {
  const mine = bid !== null && bid >= reserve ? { firmId, amount: bid } : null;
  const at = revealed.findIndex((b) => b.firmId === firmId);
  const bids = revealed.filter((b) => b.firmId !== firmId);
  if (mine) bids.splice(at < 0 ? bids.length : at, 0, mine);
  if (bids.length < Math.max(1, minBidders)) return null;
  const r = clear(bids.map((b) => b.amount), reserve);
  return r && { winner: bids[r.winner].firmId, out: r.out };
}

const freshStats = (): Record<Arm, ArmStats> => Object.fromEntries(ARMS.map((a) => [a, { auctions: 0, wins: 0, delivered: 0n, edge: 0n }])) as Record<Arm, ArmStats>;

/** Records each arm's bid at commit, replays the auction once its bids are revealed. */
export class ShadowBook {
  private pending = new Map<number, ShadowOrder[]>();
  private stats = new Map<number, Record<Arm, ArmStats>>();
  constructor(readonly minBidders = 2) {}

  record(o: ShadowOrder) {
    this.pending.set(o.auction, [...(this.pending.get(o.auction) ?? []), o]);
  }

  /** Replays every recorded firm of the auction against its revealed bids; returns each arm's outcome. */
  settle(auction: number, revealed: Revealed[]): { firmId: number; outcomes: Record<Arm, Outcome> }[] {
    const os = this.pending.get(auction) ?? [];
    this.pending.delete(auction);
    return os.map((o) => {
      const s = this.stats.get(o.firmId) ?? freshStats();
      this.stats.set(o.firmId, s);
      const outcomes = {} as Record<Arm, Outcome>;
      for (const arm of ARMS) {
        const r = counterfactual(revealed, o.firmId, o.bids[arm], o.reserve, this.minBidders);
        const won = r?.winner === o.firmId;
        const out = won ? r!.out : 0n;
        const edge = won ? edgeOf(o.side, o.amountIn, out, o.feeBps, o.ref, o.unit) : 0n;
        outcomes[arm] = { won, out, edge };
        const a = s[arm];
        if (o.bids[arm] !== null) a.auctions++;
        if (won) {
          a.wins++;
          // A buy delivers the asset, a sell delivers stable: both counted in stable at the reference.
          a.delivered += o.side === "Buy" ? (out * o.ref) / o.unit : out;
          a.edge += edge;
        }
      }
      return { firmId: o.firmId, outcomes };
    });
  }

  summary(firmId: number): Record<Arm, ArmStats> {
    return this.stats.get(firmId) ?? freshStats();
  }
}

export type LogEntry = { seq: number; at: number; prev: string; hash: string; json: string };
export const GENESIS = "0".repeat(64);
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest();
const plain = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

/** Binary SHA-256 Merkle root of hex leaves: parent = sha256(left || right) on raw bytes, the last leaf doubled when odd. */
export function merkle(leaves: string[]): string | null {
  if (!leaves.length) return null;
  let level: Buffer[] = leaves.map((h) => Buffer.from(h, "hex"));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha(Buffer.concat([level[i], level[i + 1] ?? level[i]])));
    level = next;
  }
  return level[0].toString("hex");
}

const dayOf = (e: LogEntry) => new Date(e.at).toISOString().slice(0, 10);

/**
 * Decisions as JSON, chained: entry n hashes {seq, at, prev, record, signature} with prev = entry n-1's hash.
 * `signature` is the LLM's signature payload (NEAR AI Cloud TEE), null for a rule or a bandit. Pass stored
 * entries to the constructor to reload a log.
 *
 * Memory keeps the last `keepDays` UTC days of entries (by `at`, appended in time order); a dropped day keeps
 * its Merkle root. The window's first entry has seq > 0 then, and its `prev` is the hash of the last entry
 * dropped: the chain verifies from there, and that link checks against the dropped day's entries, wherever
 * they were kept.
 */
export class DecisionLog {
  private days = new Map<string, LogEntry[]>();
  /** Roots by day, computed once per change of the day; kept for dropped days. */
  private roots = new Map<string, string | null>();

  constructor(readonly entries: LogEntry[] = [], readonly keepDays = 7) {
    for (const e of entries) this.bucket(e);
  }

  private bucket(e: LogEntry) {
    const day = dayOf(e);
    const es = this.days.get(day);
    if (es) es.push(e);
    else this.days.set(day, [e]);
    this.roots.delete(day);
  }

  append(record: unknown, signature: unknown = null, at = Date.now()): LogEntry {
    const last = this.entries.at(-1);
    const seq = last ? last.seq + 1 : 0;
    const prev = last?.hash ?? GENESIS;
    const json = JSON.stringify({ seq, at, prev, record, signature }, plain);
    const e = { seq, at, prev, hash: sha(json).toString("hex"), json };
    this.entries.push(e);
    this.bucket(e);
    if (this.days.size > this.keepDays) {
      const cutoff = [...this.days.keys()].sort().at(-this.keepDays)!;
      for (const d of [...this.days.keys()]) {
        if (d >= cutoff) continue;
        this.roots.set(d, this.merkleRoot(d));
        this.days.delete(d);
      }
      // A prefix only, so the window stays one unbroken run of the chain.
      this.entries.splice(0, Math.max(0, this.entries.findIndex((x) => dayOf(x) >= cutoff)));
    }
    return e;
  }

  /** Every hash recomputed and every link checked, from the window's first entry; `bad` is the first broken entry. */
  verifyChain(): { ok: boolean; bad?: number } {
    const first = this.entries[0];
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      let j: any;
      try {
        j = JSON.parse(e.json);
      } catch {
        return { ok: false, bad: i };
      }
      const seq = first.seq + i;
      const prev = i ? this.entries[i - 1].hash : first.seq === 0 ? GENESIS : e.prev;
      if (e.seq !== seq || e.prev !== prev || j.seq !== seq || j.at !== e.at || j.prev !== prev || sha(e.json).toString("hex") !== e.hash) return { ok: false, bad: i };
    }
    return { ok: true };
  }

  /** The kept entries dated `dayUtc` (YYYY-MM-DD), in log order. */
  day(dayUtc: string): LogEntry[] {
    return this.days.get(dayUtc) ?? [];
  }

  /** Merkle root of the hashes of the entries dated `dayUtc`, in log order, dropped days included; null for none. */
  merkleRoot(dayUtc: string): string | null {
    const es = this.days.get(dayUtc);
    if (es && !this.roots.has(dayUtc)) this.roots.set(dayUtc, merkle(es.map((e) => e.hash)));
    return this.roots.get(dayUtc) ?? null;
  }
}
