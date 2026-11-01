// Chain access from the browser: view calls through the server's RPC proxy, and the account in use: a demo
// account whose key is generated and kept in this browser (the server only creates and funds it), or an
// Ethereum wallet whose 0x address is its NEAR Intents account (it signs intents, the server's relay pays the gas).
import { Account, JsonRpcProvider, KeyPair, actions, baseEncode, teraToGas, type KeyPairString } from "near-api-js";
import { createDemoAccount, getConfig, marketBySymbol, relayIntent, type Side } from "./api";

export const provider = new JsonRpcProvider({ url: `${location.origin}/rpc` });

export async function view<T = any>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}

// ------------------------------------------------------------------ wallet

const KEY = "tontine.wallet.v1";
/** A demo account (NEAR key in this browser) or an Ethereum wallet (`evm`, the 0x address, no NEAR key). */
export type Wallet = { accountId: string; privateKey: string; evm?: false } | { accountId: string; evm: true; privateKey?: undefined };

export function loadWallet(): Wallet | null {
  try {
    const w = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (w && typeof w.accountId === "string" && w.evm === true && /^0x[0-9a-f]{40}$/.test(w.accountId)) return { accountId: w.accountId, evm: true };
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
  if (w.evm) throw new Error("An Ethereum account trades from its trading balance only: create a demo account for this.");
  return new Account(w.accountId, provider, w.privateKey as KeyPairString);
}

// ------------------------------------------------------------------ Ethereum wallet (window.ethereum)

type Eip1193 = { request(a: { method: string; params?: unknown[] }): Promise<any> };
const ethereum = () => (window as unknown as { ethereum?: Eip1193 }).ethereum;
export const hasEthereum = () => !!ethereum();

/** Connect the browser's Ethereum wallet: its lower-case 0x address is its NEAR Intents account. */
export async function connectEthereum(): Promise<Wallet> {
  const eth = ethereum();
  if (!eth) throw new Error("No Ethereum wallet in this browser (window.ethereum).");
  const [address] = await eth.request({ method: "eth_requestAccounts" });
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("The wallet returned no account.");
  const w: Wallet = { accountId: address.toLowerCase(), evm: true };
  setWallet(w);
  return w;
}

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** NEAR Intents' versioned nonce V1, base64: magic 5628f6c6, version 0, salt, deadline (ns, i64 LE), 15 random bytes. */
function versionedNonce(saltHex: string, deadlineMs: number): string {
  const b = new Uint8Array(32);
  b.set([0x56, 0x28, 0xf6, 0xc6, 0]);
  b.set(saltHex.match(/../g)!.map((h) => parseInt(h, 16)), 5);
  new DataView(b.buffer).setBigInt64(9, BigInt(deadlineMs) * 1_000_000n, true);
  b.set(crypto.getRandomValues(new Uint8Array(15)), 17);
  return btoa(String.fromCharCode(...b));
}

/**
 * Sign one transfer intent to a tender with `personal_sign` (ERC-191) and post it to the relay. Same payload
 * as ts/src/relay.ts `orderPayload`: the order is the transfer's `msg`, tender's `mt_on_transfer` posts it.
 */
async function relayOrder(w: Wallet, tender: string, token: string, amount: bigint, order: object): Promise<TxResult> {
  const eth = ethereum();
  if (!eth) throw new Error("Connect your Ethereum wallet first.");
  const c = await getConfig();
  const deadlineMs = Date.now() + 5 * 60_000;
  const payload = JSON.stringify({
    signer_id: w.accountId,
    verifying_contract: c.intents,
    deadline: new Date(deadlineMs).toISOString(),
    nonce: versionedNonce(await view<string>(c.intents, "current_salt"), deadlineMs),
    intents: [{ intent: "transfer", receiver_id: tender, tokens: { [token]: amount.toString() }, msg: JSON.stringify({ PostOrder: order }), min_gas: "50000000000000" }],
  });
  const sig: string = await eth.request({ method: "personal_sign", params: [`0x${hexOf(new TextEncoder().encode(payload))}`, w.accountId] });
  // Wallets return r || s || v with v = 27 or 28; NEAR Intents wants v = 0 or 1, base58.
  const rsv = Uint8Array.from(sig.replace(/^0x/, "").match(/../g)!.map((h) => parseInt(h, 16)));
  if (rsv.length !== 65) throw new Error("The wallet returned a malformed signature.");
  if (rsv[64] >= 27) rsv[64] -= 27;
  const r = await relayIntent({ standard: "erc191", payload, signature: `secp256k1:${baseEncode(rsv)}` });
  return { hash: r.txHash, events: r.events };
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

/** USDC, or the asset of the market at hand (wNEAR, wETH or wSOL). */
export type TokenName = "usdc" | "asset";

/** The market a call goes to: by symbol, NEAR when absent. */
const marketFor = async (symbol?: string) => {
  const c = await getConfig();
  return { c, m: marketBySymbol(c, symbol)! };
};

/** Wallet to the trading balance (NEAR Intents), one transaction. `ft` is the token contract. */
export function depositToIntents(w: Wallet, amount: bigint, ft: string) {
  return getConfig().then((c) => tx(w, ft, "ft_transfer_call", { receiver_id: c.intents, amount: amount.toString(), msg: "" }, ONE_YOCTO, 100));
}

/** Trading balance (NEAR Intents) to the wallet, one transaction. */
export function withdrawToWallet(w: Wallet, amount: bigint, ft: string) {
  return getConfig().then((c) => tx(w, c.intents, "ft_withdraw", { token: ft, receiver_id: w.accountId, amount: amount.toString(), memo: null, msg: null }, ONE_YOCTO, 120));
}

/**
 * Move USDC or a market's asset into its tender with an optional tender message (`PostOrder`, `Credit`):
 * `mt_transfer_call` from the trading balance; what it lacks comes from the wallet first.
 */
export async function depositToTender(w: Wallet, amount: bigint, msg?: object, token: TokenName = "usdc", market?: string) {
  const { c, m } = await marketFor(market);
  const [ft, id] = token === "usdc" ? [c.usdc, c.token] : [m.ft, m.assetToken];
  const have = BigInt(await view<string>(c.intents, "mt_balance_of", { account_id: w.accountId, token_id: id }));
  if (have < amount) await depositToIntents(w, amount - have, ft);
  return tx(w, c.intents, "mt_transfer_call", { receiver_id: m.tender, token_id: id, amount: amount.toString(), approval: null, memo: null, msg: msg ? JSON.stringify(msg) : "" }, ONE_YOCTO, 250);
}

/** Make sure the account has `need` USDC in a market's tender ledger (shares, bonds, firm cash), moving the difference from the trading balance. */
export async function ensureLedger(w: Wallet, need: bigint, market?: string) {
  const { m } = await marketFor(market);
  const have = BigInt(await view<string>(m.tender, "balance_of", { account_id: w.accountId }));
  if (have < need) await depositToTender(w, need - have, undefined, "usdc", market);
}

/**
 * Post a swap order from the trading balance: one transfer to the market's tender whose msg opens the sealed
 * auction (`mt_transfer_call` for a demo account, a signed intent through the relay for an Ethereum wallet).
 * The fill or the refund comes back to the trading balance (the server's payout keeper).
 */
export async function postOrder(w: Wallet, side: Side, amountIn: bigint, minOut: bigint, referenceOut: bigint, commitSecs = 8, revealSecs = 6, market?: string) {
  const order = { side, amount_in: amountIn.toString(), min_out: minOut.toString(), reference_out: referenceOut.toString(), commit_secs: commitSecs, reveal_secs: revealSecs };
  const token: TokenName = side === "Buy" ? "usdc" : "asset";
  if (!w.evm) return depositToTender(w, amountIn, { PostOrder: order }, token, market);
  const { c, m } = await marketFor(market);
  return relayOrder(w, m.tender, token === "usdc" ? c.token : m.assetToken, amountIn, order);
}

/** A call to a market's tender (NEAR's by default), with the 1 yocto its payable methods ask. */
export async function tenderCall(w: Wallet, method: string, args: Record<string, unknown>, market?: string) {
  const { m } = await marketFor(market);
  return tx(w, m.tender, method, args, ONE_YOCTO, 120);
}

/** Every market whose tender still holds some of the account's money (dividends, share sales, a missed payout). */
export const inMarkets = (bal: Balances | null) => Object.entries(bal?.markets ?? {}).filter(([, b]) => b.usdc.tender !== "0" || b.asset.tender !== "0");

/** Those balances back to the trading balance: `withdraw_to_intents` on each tender (no deposit, gas only). */
export async function moveToTrading(w: Wallet, bal: Balances) {
  const c = await getConfig();
  for (const [s] of inMarkets(bal)) await tx(w, marketBySymbol(c, s)!.tender, "withdraw_to_intents", { account_id: w.accountId }, 0n, 100);
}

/** One token in its three places: the wallet, NEAR Intents (the trading balance) and a tender's ledger (base units). */
export type Spots = { wallet: string; intents: string; tender: string };
/** Per market: USDC (the wallet and NEAR Intents are shared, the ledger is its tender's) and its asset. */
export type MarketBalances = { usdc: Spots; asset: Spots };
/** `usdc` and `wnear` are the NEAR market's, as before; `markets` has every market by symbol. */
export type Balances = { near: string; storage: string; usdc: Spots; wnear: Spots; markets: Record<string, MarketBalances> };

export async function balances(accountId: string): Promise<Balances> {
  const c = await getConfig();
  // A failed view (network, rate limit) fails the whole read: the widgets keep the last balances instead of zeros.
  const v = (contract: string, method: string, args: Record<string, unknown> = { account_id: accountId }) => view<string>(contract, method, args);
  const evm = accountId.startsWith("0x");
  const [acct, storage, uw, ui] = await Promise.all([
    evm
      ? null
      : (provider.viewAccount({ accountId } as any).catch((e) => {
          // The devnet starts fresh on every server restart: a demo account saved before it is gone.
          if (/does not exist/.test(String(e?.message)) && loadWallet()?.accountId === accountId) forgetWallet();
          return null;
        }) as Promise<any>),
    v(c.tender, "storage_balance_of"),
    evm ? "0" : v(c.usdc, "ft_balance_of"),
    v(c.intents, "mt_balance_of", { account_id: accountId, token_id: c.token }),
  ]);
  const markets: Record<string, MarketBalances> = {};
  await Promise.all(
    c.markets.map(async (m) => {
      const [ut, aw, ai, at] = await Promise.all([
        v(m.tender, "balance_of"),
        evm ? "0" : v(m.ft, "ft_balance_of"),
        v(c.intents, "mt_balance_of", { account_id: accountId, token_id: m.assetToken }),
        v(m.tender, "asset_balance_of"),
      ]);
      markets[m.symbol] = { usdc: { wallet: uw, intents: ui, tender: ut }, asset: { wallet: aw, intents: ai, tender: at } };
    }),
  );
  const nearM = markets[c.markets[0].symbol];
  return { near: String(acct?.amount ?? "0"), storage, usdc: nearM.usdc, wnear: nearM.asset, markets };
}
