// The contract between a firm and the swarm. Third parties add a firm by PR of one file in strategies/.
import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import type { Llm } from "./llm.ts";

export type JobView = { id: number; client: string; budget: bigint; brief: string };

export type FirmCtx = {
  id: number;
  account: string;
  /** Firm treasury in the tender ledger (USDC base units). */
  treasury: bigint;
  delivered: number;
  rejected: number;
  /** "Solvent", "Illiquid", "Liquidating" or "Closed". */
  status?: string;
};

export type TargetView = { id: number; account: string; delivered: number; rejected: number; revenue: bigint; treasury: bigint };

export interface Strategy {
  name: string;
  author: string;
  /** House firms are labelled as such everywhere (README, dashboard). */
  house: boolean;
  /** Sealed price for a job (reverse auction), or null to pass. Must be <= job.budget. */
  bid(job: JobView, me: FirmCtx): bigint | null;
  /** Produce the deliverable for a job this firm won. */
  work(job: JobView, llm: Llm): Promise<string>;
  /** Optional: sealed price to buy a firm in liquidation (forward auction), paid from the treasury. */
  takeover?(target: TargetView, me: FirmCtx): bigint | null;
  /** Optional: vote on a disputed delivery when this firm sits on the panel (true accepts it).
   * Default: `evaluate` in judge.ts (empty fails, the client's criteria checks, then the LLM judge). */
  evaluate?(job: JobView & { criteria: string }, result: string, llm: Llm): Promise<boolean>;
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "strategies");

/** Load every strategy in strategies/, sorted by file name. */
export async function loadStrategies(): Promise<Strategy[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".ts")).sort();
  const out: Strategy[] = [];
  for (const f of files) {
    const s = (await import(pathToFileURL(path.join(dir, f)).href)).default as Strategy;
    if (!s?.name || typeof s.bid !== "function" || typeof s.work !== "function") throw new Error(`strategies/${f}: not a Strategy`);
    out.push(s);
  }
  return out;
}

/** Clamp a strategy's answer to what the contract accepts. A bad strategy passes, it never crashes the swarm. */
export function safeBid(s: Strategy, job: JobView, me: FirmCtx): bigint | null {
  try {
    const v = s.bid(job, me);
    return v === null || v <= 0n || v > job.budget ? null : v;
  } catch {
    return null;
  }
}
