// Thin helpers over near-api-js 7: signed calls that return the decoded value and NEP-297 events.
import { Account, JsonRpcProvider, KeyPair, actions, teraToGas, type KeyPairString } from "near-api-js";

export type Event = { standard: string; event: string; data: any[] };
export type CallResult<T = unknown> = { value: T; events: Event[]; txHash: string };

export const TGAS = (n: number) => teraToGas(n);
export const USDC = (n: number) => BigInt(Math.round(n * 1e6));
export const fmt = (base: bigint | string | number) => (Number(BigInt(base)) / 1e6).toFixed(2);

export function account(id: string, provider: JsonRpcProvider, key: KeyPairString | KeyPair): Account {
  return new Account(id, provider, (typeof key === "string" ? key : key.toString()) as KeyPairString);
}

function decode(b64?: string): unknown {
  if (!b64) return undefined;
  const s = Buffer.from(b64, "base64").toString();
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function parseEvents(res: any): Event[] {
  const logs: string[] = [
    ...(res.transaction_outcome?.outcome?.logs ?? []),
    ...res.receipts_outcome.flatMap((r: any) => r.outcome.logs),
  ];
  return logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)));
}

/** Panics anywhere in the receipt tree, as readable strings. */
export function failures(res: any): string[] {
  return res.receipts_outcome
    .map((r: any) => r.outcome.status?.Failure)
    .filter(Boolean)
    .map((f: any) => JSON.stringify(f).match(/"(?:FunctionCallError|ExecutionError)".*?"([^"]+)"/)?.[1] ?? JSON.stringify(f));
}

export async function call<T = unknown>(
  signer: Account,
  contractId: string,
  methodName: string,
  args: Record<string, unknown> = {},
  deposit: bigint = 0n,
  gas = TGAS(150),
): Promise<CallResult<T>> {
  const res: any = await signer.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.functionCall(methodName, args, gas, deposit)],
    waitUntil: "EXECUTED_OPTIMISTIC",
    throwOnFailure: false,
  });
  const fail = res.status?.Failure;
  if (fail) {
    const msg = JSON.stringify(fail).match(/"ExecutionError":"([^"]+)"/)?.[1] ?? JSON.stringify(fail);
    throw new Error(`${methodName}: ${msg}`);
  }
  return { value: decode(res.status?.SuccessValue) as T, events: parseEvents(res), txHash: res.transaction.hash };
}

export async function view<T = any>(provider: JsonRpcProvider, contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The chain clock (ns), from the latest optimistic block. */
export async function chainTime(provider: JsonRpcProvider): Promise<bigint> {
  const b: any = await provider.viewBlock({ finality: "optimistic" } as any);
  return BigInt(b.header.timestamp_nanosec ?? b.header.timestamp);
}

/** Wait until the chain clock passes `ns` (block timestamps drive the auction phases). */
export async function waitUntilChainTime(provider: JsonRpcProvider, ns: bigint | number) {
  for (;;) {
    const b: any = await provider.viewBlock({ finality: "optimistic" } as any);
    if (BigInt(b.header.timestamp_nanosec ?? b.header.timestamp) >= BigInt(ns)) return;
    await sleep(300);
  }
}
