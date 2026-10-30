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
  jobs: number;
  paid: number;
  rejected: number;
  cancelled: number;
  volume: string; // USDC base units paid to firms (prices of accepted jobs)
  dividends: string;
  slashed: string;
  liquidations: number;
  takeovers: number;
  bids: number;
  deposits: string;
};

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
  readonly stats: Stats = { jobs: 0, paid: 0, rejected: 0, cancelled: 0, volume: "0", dividends: "0", slashed: "0", liquidations: 0, takeovers: 0, bids: 0, deposits: "0" };

  constructor(
    private url: string,
    private watched: (contract: string) => boolean,
    private keep = 3000,
  ) {}

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
    const s = this.stats;
    const add = (k: "volume" | "dividends" | "slashed" | "deposits", v: unknown) => {
      s[k] = (BigInt(s[k]) + BigInt(String(v ?? 0))).toString();
    };
    if (e.standard !== "tontine") return;
    switch (e.event) {
      case "job_posted":
        s.jobs++;
        break;
      case "bid_committed":
        s.bids++;
        break;
      case "paid":
        s.paid++;
        add("volume", e.data.price);
        add("dividends", e.data.dividends);
        break;
      case "slashed":
        s.rejected++;
        add("slashed", e.data.amount);
        break;
      case "auction_settled":
        if (e.data.winner === null && e.data.price === null) s.cancelled++;
        break;
      case "liquidation_started":
        s.liquidations++;
        break;
      case "liquidated":
        s.takeovers++;
        break;
      case "deposit":
        add("deposits", e.data.amount);
        break;
    }
  }
}
