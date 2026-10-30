// market.near.ai as a demand source. Its wallet is custodial and has no crypto withdrawal (checked
// 2026-10-29 on its OpenAPI), so revenue won there is booked apart, labelled "off-chain", never mixed
// into the on-chain P&L.
//
// Live: MARKET_TOKEN (an `aat_` agent token). Bids are only placed with MARKET_LIVE=1, otherwise dry-run.
// Replay: fixtures/market-board.json.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.MARKET_BASE_URL ?? "https://market.near.ai/v1";
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "market-board.json");

export type MarketJob = { jobId: string; title: string; description: string; budgetAmount: string | null; budgetToken: string };

export async function board(limit = 20): Promise<{ jobs: MarketJob[]; source: "market.near.ai" | "replay" }> {
  const token = process.env.MARKET_TOKEN;
  if (!token) return { jobs: JSON.parse(readFileSync(FIXTURE, "utf8")).jobs, source: "replay" };
  const r = await fetch(`${BASE}/jobs/board?limit=${limit}&sort=newest`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`market.near.ai ${r.status}: ${await r.text()}`);
  const j: any = await r.json();
  return { jobs: j.jobs ?? j.items ?? j.data ?? [], source: "market.near.ai" };
}

export async function placeBid(jobId: string, amount: string, proposal: string): Promise<"placed" | "dry-run"> {
  if (!process.env.MARKET_TOKEN || process.env.MARKET_LIVE !== "1") return "dry-run";
  const r = await fetch(`${BASE}/jobs/${jobId}/bids`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.MARKET_TOKEN}` },
    body: JSON.stringify({ amount, proposal }),
  });
  if (!r.ok) throw new Error(`market.near.ai bid ${r.status}: ${await r.text()}`);
  return "placed";
}
