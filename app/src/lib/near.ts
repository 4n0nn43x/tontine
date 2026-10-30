// Chain access from the browser: view calls through the server's RPC proxy, and a demo account whose key
// is generated and kept in this browser (the server only creates and funds the account).
import { Account, JsonRpcProvider, KeyPair, actions, teraToGas, type KeyPairString } from "near-api-js";
import { createDemoAccount, getConfig } from "./api";

export const provider = new JsonRpcProvider({ url: `${location.origin}/rpc` });

export async function view<T = any>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}

// ------------------------------------------------------------------ wallet

const KEY = "tontine.wallet.v1";
export type Wallet = { accountId: string; privateKey: string };

export function loadWallet(): Wallet | null {
  try {
    const w = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return w && typeof w.accountId === "string" && typeof w.privateKey === "string" ? w : null;
  } catch {
    return null;
  }
}

const listeners = new Set<(w: Wallet | null) => void>();
export function onWallet(fn: (w: Wallet | null) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setWallet(w: Wallet | null) {
  try {
    if (w) localStorage.setItem(KEY, JSON.stringify(w));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the wallet lives for this page only */
  }
  for (const fn of listeners) fn(w);
}

export async function createWallet(): Promise<Wallet> {
  const kp = KeyPair.fromRandom("ed25519");
  const { accountId } = await createDemoAccount(kp.getPublicKey().toString());
  const w = { accountId, privateKey: kp.toString() };
  setWallet(w);
  return w;
}

export function forgetWallet() {
  setWallet(null);
}

function account(w: Wallet) {
  return new Account(w.accountId, provider, w.privateKey as KeyPairString);
}

// ------------------------------------------------------------------ transactions

export type TxResult = { hash: string; events: { standard: string; event: string; data: any[] }[] };

function failureText(f: unknown): string {
  const s = JSON.stringify(f);
  return s.match(/"(?:ExecutionError|FunctionCallError)"\s*:\s*"([^"]+)"/)?.[1]?.replace(/^Smart contract panicked: /, "") ?? s.slice(0, 200);
}

/** Sign and send one function call with the demo account; throws with the contract's message on failure. */
export async function tx(w: Wallet, contractId: string, method: string, args: Record<string, unknown>, depositYocto = 0n, tgas = 150): Promise<TxResult> {
  const res: any = await account(w).signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.functionCall(method, args, teraToGas(tgas), depositYocto)],
    waitUntil: "EXECUTED_OPTIMISTIC",
    throwOnFailure: false,
  });
  if (res.status?.Failure) throw new Error(failureText(res.status.Failure));
  const inner = (res.receipts_outcome ?? []).map((r: any) => r.outcome.status?.Failure).find(Boolean);
  if (inner) throw new Error(failureText(inner));
  const logs: string[] = (res.receipts_outcome ?? []).flatMap((r: any) => r.outcome.logs);
  const events = logs.filter((l) => l.startsWith("EVENT_JSON:")).map((l) => JSON.parse(l.slice(11)));
  return { hash: res.transaction.hash, events };
}

const ONE_YOCTO = 1n;

/** Deposit USDC from the wallet into tender: into intents.near, then mt_transfer_call to tender. */
export async function depositToTender(w: Wallet, amount: bigint, msg?: object) {
  const c = await getConfig();
  await tx(w, c.usdc, "ft_transfer_call", { receiver_id: c.intents, amount: amount.toString(), msg: "" }, ONE_YOCTO, 100);
  return tx(w, c.intents, "mt_transfer_call", { receiver_id: c.tender, token_id: c.token, amount: amount.toString(), approval: null, memo: null, msg: msg ? JSON.stringify(msg) : "" }, ONE_YOCTO, 250);
}

/** Pay a job: escrow `budget` in tender and open its sealed-bid auction. */
export function postJob(w: Wallet, budget: bigint, brief: string, commitSecs: number, revealSecs: number, deliverSecs: number) {
  return depositToTender(w, budget, { PostJob: { budget: budget.toString(), brief, commit_secs: commitSecs, reveal_secs: revealSecs, deliver_secs: deliverSecs } });
}

/** Ledger balance out of tender (to intents.near), then out of intents.near to the wallet. */
export async function withdrawToWallet(w: Wallet, amount: bigint) {
  const c = await getConfig();
  await tx(w, c.tender, "withdraw", { amount: amount.toString() }, ONE_YOCTO, 120);
  return tx(w, c.intents, "ft_withdraw", { token: c.usdc, receiver_id: w.accountId, amount: amount.toString(), memo: null, msg: null }, ONE_YOCTO, 120);
}

export async function tenderCall(w: Wallet, method: string, args: Record<string, unknown>) {
  const c = await getConfig();
  return tx(w, c.tender, method, args, ONE_YOCTO, 120);
}

export type Balances = { near: string; wallet: string; intents: string; tender: string; storage: string };

export async function balances(accountId: string): Promise<Balances> {
  const c = await getConfig();
  const [acct, wallet, intents, tender, storage] = await Promise.all([
    provider.viewAccount({ accountId } as any).catch((e) => {
      // The devnet starts fresh on every server restart: a demo account saved before it is gone.
      if (/does not exist/.test(String(e?.message)) && loadWallet()?.accountId === accountId) forgetWallet();
      return null;
    }) as Promise<any>,
    view<string>(c.usdc, "ft_balance_of", { account_id: accountId }).catch(() => "0"),
    view<string>(c.intents, "mt_balance_of", { account_id: accountId, token_id: c.token }).catch(() => "0"),
    view<string>(c.tender, "balance_of", { account_id: accountId }).catch(() => "0"),
    view<string>(c.tender, "storage_balance_of", { account_id: accountId }).catch(() => "0"),
  ]);
  return { near: String(acct?.amount ?? "0"), wallet, intents, tender, storage };
}
