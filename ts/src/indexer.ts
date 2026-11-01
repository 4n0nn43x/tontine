// Reads every final block of the chain and keeps the NEP-297 events (EVENT_JSON logs) emitted by the
// contracts we care about. Feeds the live feed and the aggregate figures of the app.

export type ChainEvent = {
  id: number;
  height: number;
  time: number; // ms since epoch, from the block timestamp
  txHash: string;
  signer: string;
  contract: string;
  standard: string;
  event: string;
  data: any;
};

export type Stats = {
  orders: number;
  fills: number;
  refunded: number;
  volume: string; // stable notional of filled orders (USDC base units)
  edge: string; // sum of the fills' edges (can be negative)
  /** Sum over fills of what the client received beyond its market reference, in bp of the reference. */
  improvementBps: number;
  /** Tontine's revenue on fills: order fees plus surplus shares, valued in USDC at each fill's price. */
  revenue: string;
  slashed: string;
  liquidations: number;
  takeovers: number;
  bids: number;
  deposits: string;
};

const emptyStats = (): Stats => ({ orders: 0, fills: 0, refunded: 0, volume: "0", edge: "0", improvementBps: 0, revenue: "0", slashed: "0", liquidations: 0, takeovers: 0, bids: 0, deposits: "0" });

async function rpc<T = any>(url: string, method: string, params: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "idx", method, params }),
  });
  const j: any = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result as T;
}

export class Indexer {
  events: ChainEvent[] = [];
  private listeners = new Set<(e: ChainEvent) => void>();
  private next = 0;
  private seq = 0;
  private stopped = false;
  /** Totals over every watched contract, and per contract (one tender per market). */
  readonly stats: Stats = emptyStats();
  readonly byContract = new Map<string, Stats>();

  constructor(
    private url: string,
    private watched: (contract: string) => boolean,
    private keep = 3000,
    /** Base units of one asset token on a tender, to value fees paid in the asset. */
    private unitOf: (contract: string) => bigint = () => 10n ** 24n,
  ) {}

  statsOf(contract: string): Stats {
    return this.byContract.get(contract) ?? emptyStats();
  }

  subscribe(fn: (e: ChainEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async start(fromHeight?: number) {
    const head: any = await rpc(this.url, "block", { finality: "final" });
    this.next = fromHeight ?? head.header.height;
    void this.loop();
  }

  stop() {
    this.stopped = true;
  }

  private async loop() {
    while (!this.stopped) {
      try {
        const head: any = await rpc(this.url, "block", { finality: "final" });
        while (this.next <= head.header.height && !this.stopped) {
          await this.block(this.next);
          this.next++;
        }
      } catch (e) {
        console.warn("indexer:", (e as Error).message);
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  private async block(height: number) {
    let block: any;
    try {
      block = await rpc(this.url, "block", { block_id: height });
    } catch {
      return; // skipped height
    }
    const time = Math.floor(Number(block.header.timestamp_nanosec) / 1e6);
    for (const ch of block.chunks) {
      if (ch.tx_root === "11111111111111111111111111111111") continue; // no transactions
      const chunk: any = await rpc(this.url, "chunk", { chunk_id: ch.chunk_hash });
      for (const tx of chunk.transactions) {
        const status: any = await rpc(this.url, "EXPERIMENTAL_tx_status", { tx_hash: tx.hash, sender_account_id: tx.signer_id, wait_until: "FINAL" });
        for (const ro of status.receipts_outcome ?? []) {
          const contract = ro.outcome.executor_id;
          if (!this.watched(contract)) continue;
          for (const line of ro.outcome.logs ?? []) {
            if (!line.startsWith("EVENT_JSON:")) continue;
            let parsed: any;
            try {
              parsed = JSON.parse(line.slice(11));
            } catch {
              continue;
            }
            for (const data of parsed.data ?? [null]) {
              this.emit({ id: ++this.seq, height, time, txHash: tx.hash, signer: tx.signer_id, contract, standard: parsed.standard, event: parsed.event, data });
            }
          }
        }
      }
    }
  }

  private emit(e: ChainEvent) {
    this.count(e);
    this.events.push(e);
    if (this.events.length > this.keep) this.events.splice(0, this.events.length - this.keep);
    for (const fn of this.listeners) fn(e);
  }

  private count(e: ChainEvent) {
    if (e.standard !== "tontine") return;
    if (!this.byContract.has(e.contract)) this.byContract.set(e.contract, emptyStats());
    this.countInto(this.stats, e);
    this.countInto(this.byContract.get(e.contract)!, e);
  }

  private countInto(s: Stats, e: ChainEvent) {
    const add = (k: "volume" | "edge" | "slashed" | "deposits" | "revenue", v: unknown) => {
      s[k] = (BigInt(s[k]) + BigInt(String(v ?? 0))).toString();
    };
    switch (e.event) {
      case "order_posted":
        s.orders++;
        break;
      case "bid_committed":
        s.bids++;
        break;
      case "order_filled": {
        s.fills++;
        // `out` is what the firm delivered; the client received it less Tontine's surplus share.
        const d = e.data;
        const surplus = BigInt(d.surplus_fee ?? 0);
        add("volume", d.side === "Buy" ? d.amount_in : d.out);
        add("edge", d.edge);
        const ref = BigInt(d.reference_out ?? 0);
        if (ref > 0n) s.improvementBps += Number(((BigInt(d.out) - surplus - ref) * 10_000n) / ref);
        // A buy pays its fee in USDC and its surplus in the asset, a sell the other way round.
        const asset = (v: bigint) => (v * BigInt(d.price ?? 0)) / this.unitOf(e.contract);
        const fee = BigInt(d.fee ?? 0);
        add("revenue", d.side === "Buy" ? fee + asset(surplus) : asset(fee) + surplus);
        break;
      }
      case "order_refunded":
        s.refunded++;
        break;
      case "slashed":
        add("slashed", e.data.amount);
        break;
      case "liquidation_started":
        s.liquidations++;
        break;
      case "liquidated":
        s.takeovers++;
        break;
      case "deposit":
        if (e.data.token !== "asset") add("deposits", e.data.amount); // USDC only: asset units differ per market
        break;
    }
  }
}
