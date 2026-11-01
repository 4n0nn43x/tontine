// Chain access from the browser: view calls through the server's RPC proxy, and the account in use: a demo
// account whose key is generated and kept in this browser (the server only creates and funds it), or a wallet
// of another chain (EVM, Solana, Tron, TON, Stellar, a passkey) whose implicit NEAR Intents account is derived
// from its key (it signs intents in its own standard, the server's relay pays the gas).
import { p256 } from "@noble/curves/nist.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { Account, JsonRpcProvider, KeyPair, actions, baseDecode, baseEncode, teraToGas, type KeyPairString } from "near-api-js";
import { createDemoAccount, getConfig, marketBySymbol, relayIntent, type Side, type SignedIntent } from "./api";

export const provider = new JsonRpcProvider({ url: `${location.origin}/rpc` });

export async function view<T = any>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}

// ------------------------------------------------------------------ wallet

const KEY = "tontine.wallet.v1";
/** A wallet of another chain: it signs NEAR Intents messages in its own standard; its NEAR Intents account is implicit, derived from its key. */
export type Chain = "evm" | "solana" | "tron" | "ton" | "stellar" | "passkey";
/** A demo account (NEAR key in this browser) or a wallet of another chain (`chain`, no NEAR key: the relay pays the gas). */
export type Wallet =
  | { accountId: string; privateKey: string; chain?: undefined }
  | { accountId: string; chain: Chain; publicKey?: string; address?: string; credentialId?: string; bridge?: string; privateKey?: undefined };
type ChainWallet = Extract<Wallet, { chain: Chain }>;

/** Each chain: its name, where a deposit comes from, the wallets that work (marks in components/Wallets.tsx). */
export const CHAINS: Record<Chain, { name: string; from: string; wallets: string }> = {
  evm: { name: "Ethereum or Base", from: "Base", wallets: "MetaMask, Rabby, Coinbase Wallet" },
  solana: { name: "Solana", from: "Solana", wallets: "Phantom, Solflare, Backpack" },
  tron: { name: "Tron", from: "Tron", wallets: "TronLink" },
  ton: { name: "TON", from: "TON", wallets: "Tonkeeper, MyTonWallet" },
  stellar: { name: "Stellar", from: "Stellar", wallets: "Freighter" },
  passkey: { name: "Passkey", from: "another chain", wallets: "Face ID, Touch ID, Windows Hello: no wallet to install" },
};
/** The implicit account of each chain's key: secp256k1 and P-256 keys give 0x + 40 hex, Ed25519 keys 64 hex. */
const ACCOUNT: Record<Chain, RegExp> = { evm: /^0x[0-9a-f]{40}$/, tron: /^0x[0-9a-f]{40}$/, passkey: /^0x[0-9a-f]{40}$/, solana: /^[0-9a-f]{64}$/, ton: /^[0-9a-f]{64}$/, stellar: /^[0-9a-f]{64}$/ };

export function loadWallet(): Wallet | null {
  try {
    const w = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!w || typeof w.accountId !== "string") return null;
    const chain: Chain | undefined = w.evm === true ? "evm" : w.chain; // `evm: true`: saved before the other chains
    if (chain && chain in ACCOUNT) {
      if (!ACCOUNT[chain].test(w.accountId)) return null;
      const str = (k: string) => (typeof w[k] === "string" ? { [k]: w[k] as string } : {});
      return { accountId: w.accountId, chain, ...str("publicKey"), ...str("address"), ...str("credentialId"), ...str("bridge") };
    }
    return typeof w.privateKey === "string" ? { accountId: w.accountId, privateKey: w.privateKey } : null;
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
  if (w.chain) throw new Error(`A ${CHAINS[w.chain].name} wallet trades from its trading balance only: create a demo account for this.`);
  return new Account(w.accountId, provider, w.privateKey as KeyPairString);
}

// ------------------------------------------------------------------ wallets of other chains

const win = window as any;
type Eip1193 = { request(a: { method: string; params?: unknown[] }): Promise<any> };
const ethereum = (): Eip1193 | undefined => win.ethereum;
const solana = () => win.phantom?.solana ?? win.solflare ?? win.backpack?.solana ?? win.solana;
const tronWeb = () => win.tronLink?.tronWeb || win.tronWeb;
/** The JS bridge keys of the TonConnect wallets list (github.com/ton-connect/wallets-list, wallets-v2.json, 2026-11-01). */
const TON_KEYS = ["tonkeeper", "mytonwallet", "telegram", "tonhub", "bitgetTonWallet", "okxTonWallet", "binancew3w", "hotWallet", "bybitTonWallet", "safepalwallet", "gatetonwallet", "openmask", "xtonwallet", "tokenpocket", "onekeyTonWallet", "gramwallet"];
/** An injected TonConnect JS bridge (`window.<key>.tonconnect`, TonConnect spec, bridge.md). */
function tonBridge(key?: string): { key: string; tc: any } | undefined {
  for (const k of key ? [key] : TON_KEYS) if (typeof win[k]?.tonconnect?.connect === "function") return { key: k, tc: win[k].tonconnect };
}

/** Which wallets this browser has. Freighter only answers asynchronously: tried on click. */
export function detected(): Record<Chain, boolean> {
  return { evm: !!ethereum(), solana: !!solana(), tron: !!(win.tronLink || win.tronWeb), ton: !!tonBridge(), stellar: true, passkey: !!win.PublicKeyCredential && isSecureContext };
}

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const b64url = (b: Uint8Array) => b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const utf8 = (s: string) => new TextEncoder().encode(s);

/** The 32-byte Ed25519 key of a Stellar account (strkey G...: base32 of version byte 6 << 3, key, CRC16). */
function stellarKey(address: string): Uint8Array {
  let bits = "";
  for (const c of address) {
    const i = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c);
    if (i < 0) throw new Error("Freighter returned an address that is not a Stellar account.");
    bits += i.toString(2).padStart(5, "0");
  }
  const b = Uint8Array.from(bits.match(/.{8}/g) ?? [], (x) => parseInt(x, 2));
  if (b.length !== 35 || b[0] !== 6 << 3) throw new Error("Freighter returned an address that is not a Stellar account.");
  return b.subarray(1, 33);
}

/**
 * Connect a wallet of another chain; its NEAR Intents account is derived from its key: the 0x address for
 * EVM and Tron (keccak of the secp256k1 key), the key in hex for Solana, TON and Stellar (Ed25519), keccak
 * of "p256" and the key for a passkey (P-256, created here: its public key is kept in this browser).
 */
export async function connectWallet(chain: Chain): Promise<Wallet> {
  const w: ChainWallet = { chain, ...(await CONNECT[chain]()) };
  if (!ACCOUNT[chain].test(w.accountId)) throw new Error("The wallet returned no account.");
  setWallet(w);
  return w;
}

const CONNECT: Record<Chain, () => Promise<Omit<ChainWallet, "chain">>> = {
  async evm() {
    const eth = ethereum();
    if (!eth) throw new Error("No Ethereum wallet in this browser.");
    const [address] = await eth.request({ method: "eth_requestAccounts" });
    return { accountId: String(address).toLowerCase() };
  },
  async solana() {
    const sol = solana();
    if (!sol) throw new Error("No Solana wallet in this browser.");
    const r = await sol.connect();
    const pk = r?.publicKey ?? sol.publicKey;
    const key: Uint8Array = pk?.toBytes ? pk.toBytes() : baseDecode(String(pk));
    if (key.length !== 32) throw new Error("The Solana wallet returned no account.");
    return { accountId: hexOf(key), publicKey: `ed25519:${baseEncode(key)}` };
  },
  async tron() {
    if (win.tronLink?.request) await win.tronLink.request({ method: "tron_requestAccounts" });
    const hex: string | undefined = tronWeb()?.defaultAddress?.hex;
    if (!hex || !/^41[0-9a-fA-F]{40}$/.test(hex)) throw new Error("No Tron account: unlock TronLink and try again.");
    return { accountId: "0x" + hex.slice(2).toLowerCase(), address: tronWeb().defaultAddress.base58 };
  },
  async ton() {
    const b = tonBridge();
    if (!b) throw new Error("No TON wallet extension in this browser (TonConnect JS bridge).");
    const ev = await b.tc.connect(2, { manifestUrl: `${location.origin}/tonconnect-manifest.json`, items: [{ name: "ton_addr" }] });
    const item = ev?.event === "connect" ? ev.payload.items.find((i: any) => i.name === "ton_addr") : null;
    if (!item || !/^[0-9a-fA-F]{64}$/.test(item.publicKey)) throw new Error(ev?.payload?.message ?? "The TON wallet did not connect.");
    tonConnected = b.key;
    const key = fromHex(item.publicKey);
    return { accountId: hexOf(key), publicKey: `ed25519:${baseEncode(key)}`, address: item.address, bridge: b.key };
  },
  async stellar() {
    const fr = await import("@stellar/freighter-api");
    if (!(await fr.isConnected()).isConnected) throw new Error("No Freighter wallet in this browser.");
    const r = await fr.requestAccess();
    if (r.error) throw new Error(r.error.message ?? "Freighter refused.");
    const key = stellarKey(r.address);
    return { accountId: hexOf(key), publicKey: `ed25519:${baseEncode(key)}`, address: r.address };
  },
  async passkey() {
    if (!win.PublicKeyCredential || !isSecureContext) throw new Error("Passkeys need a browser that supports them, on https.");
    const cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: "Tontine" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "Tontine trader", displayName: "Tontine trader" },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256, P-256: what NEAR Intents verifies
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
        attestation: "none",
      },
    })) as PublicKeyCredential | null;
    const res = cred?.response as AuthenticatorAttestationResponse | undefined;
    const spki = res?.getPublicKey?.() ? new Uint8Array(res.getPublicKey()!) : null;
    // SubjectPublicKeyInfo of a P-256 key ends with the uncompressed point 04 || x || y.
    if (!cred || !spki || res!.getPublicKeyAlgorithm() !== -7 || spki[spki.length - 65] !== 4) throw new Error("This passkey cannot sign NEAR Intents (P-256 needed).");
    const xy = spki.slice(-64);
    return { accountId: "0x" + hexOf(keccak_256(new Uint8Array([...utf8("p256"), ...xy])).subarray(12)), publicKey: `p256:${baseEncode(xy)}`, credentialId: b64url(new Uint8Array(cred.rawId)) };
  },
};
let tonConnected: string | null = null;

/** Sign a NEAR Intents payload with the wallet, in its chain's standard (the relay checks the envelope, intents.near the signature). */
async function signIntent(w: ChainWallet, payload: string): Promise<SignedIntent> {
  /** r || s || v with v = 27 or 28 (EVM, Tron) to NEAR Intents' r || s || v with v = 0 or 1, base58. */
  const rsv = (sig: string) => {
    const b = fromHex(String(sig).replace(/^0x/, ""));
    if (b.length !== 65) throw new Error("The wallet returned a malformed signature.");
    if (b[64] >= 27) b[64] -= 27;
    return `secp256k1:${baseEncode(b)}`;
  };
  const ed = (sig: Uint8Array) => {
    if (sig.length !== 64) throw new Error("The wallet returned a malformed signature.");
    return { public_key: w.publicKey!, signature: `ed25519:${baseEncode(sig)}` };
  };
  switch (w.chain) {
    case "evm": {
      const eth = ethereum();
      if (!eth) throw new Error("Connect your Ethereum wallet first.");
      return { standard: "erc191", payload, signature: rsv(await eth.request({ method: "personal_sign", params: [`0x${hexOf(utf8(payload))}`, w.accountId] })) };
    }
    case "tron": {
      const tw = tronWeb();
      if (!tw?.trx?.signMessageV2) throw new Error("Unlock TronLink first.");
      return { standard: "tip191", payload, signature: rsv(await tw.trx.signMessageV2(payload)) };
    }
    case "solana": {
      const sol = solana();
      if (!sol) throw new Error("Connect your Solana wallet first.");
      if (!sol.isConnected) await sol.connect({ onlyIfTrusted: true }).catch(() => sol.connect());
      const r = await sol.signMessage(utf8(payload), "utf8"); // Phantom: { signature }, Solflare: the signature
      return { standard: "raw_ed25519", payload, ...ed(new Uint8Array(r?.signature ?? r)) };
    }
    case "stellar": {
      const fr = await import("@stellar/freighter-api");
      const r = await fr.signMessage(payload, { address: w.address });
      if (r.error || !r.signedMessage) throw new Error(r.error?.message ?? "Freighter did not sign.");
      return { standard: "sep53", payload, ...ed(typeof r.signedMessage === "string" ? unb64(r.signedMessage) : new Uint8Array(r.signedMessage)) };
    }
    case "ton": {
      const b = tonBridge(w.bridge);
      if (!b) throw new Error("Open your TON wallet extension first.");
      if (tonConnected !== b.key) {
        const ev = await b.tc.restoreConnection();
        if (ev?.event !== "connect") throw new Error("Reconnect your TON wallet: disconnect, then connect it again.");
        tonConnected = b.key;
      }
      // Only type and text: NEAR Intents hashes the text with the wallet's address, the domain and the time.
      const r = await b.tc.send({ method: "signData", params: [JSON.stringify({ type: "text", text: payload })], id: String(Date.now()) });
      if (r?.error || !r?.result) throw new Error(r?.error?.message ?? "The TON wallet did not sign.");
      const { address, domain, timestamp, signature } = r.result;
      return { standard: "ton_connect", address, domain, timestamp, payload: { type: "text", text: payload }, ...ed(unb64(signature)) };
    }
    case "passkey": {
      const a = (await navigator.credentials.get({
        publicKey: { challenge: new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(payload))), allowCredentials: [{ type: "public-key", id: unb64(w.credentialId!) }], userVerification: "preferred" },
      })) as PublicKeyCredential | null;
      const r = a?.response as AuthenticatorAssertionResponse | undefined;
      if (!r) throw new Error("The passkey did not sign.");
      // DER to r || s, with the low s NEAR Intents requires.
      const sig = p256.Signature.fromBytes(new Uint8Array(r.signature), "der");
      const low = sig.hasHighS() ? new p256.Signature(sig.r, p256.Point.Fn.ORDER - sig.s) : sig;
      return {
        standard: "webauthn",
        payload,
        public_key: w.publicKey!,
        signature: `p256:${baseEncode(low.toBytes("compact"))}`,
        client_data_json: new TextDecoder().decode(r.clientDataJSON),
        authenticator_data: b64url(new Uint8Array(r.authenticatorData)),
      };
    }
  }
}

/** NEAR Intents' versioned nonce V1, base64: magic 5628f6c6, version 0, salt, deadline (ns, i64 LE), 15 random bytes. */
function versionedNonce(saltHex: string, deadlineMs: number): string {
  const b = new Uint8Array(32);
  b.set([0x56, 0x28, 0xf6, 0xc6, 0]);
  b.set(saltHex.match(/../g)!.map((h) => parseInt(h, 16)), 5);
  new DataView(b.buffer).setBigInt64(9, BigInt(deadlineMs) * 1_000_000n, true);
  b.set(crypto.getRandomValues(new Uint8Array(15)), 17);
  return b64(b);
}

/**
 * Sign one transfer intent to a tender in the wallet's standard and post it to the relay. Same payload as
 * ts/src/relay.ts `orderPayload`: the order is the transfer's `msg`, tender's `mt_on_transfer` posts it.
 */
async function relayOrder(w: ChainWallet, tender: string, token: string, amount: bigint, order: object): Promise<TxResult> {
  const c = await getConfig();
  const deadlineMs = Date.now() + 5 * 60_000;
  const payload = JSON.stringify({
    signer_id: w.accountId,
    verifying_contract: c.intents,
    deadline: new Date(deadlineMs).toISOString(),
    nonce: versionedNonce(await view<string>(c.intents, "current_salt"), deadlineMs),
    intents: [{ intent: "transfer", receiver_id: tender, tokens: { [token]: amount.toString() }, msg: JSON.stringify({ PostOrder: order }), min_gas: "50000000000000" }],
  });
  const r = await relayIntent(await signIntent(w, payload));
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
 * auction (`mt_transfer_call` for a demo account, a signed intent through the relay for a wallet of another chain).
 * The fill or the refund comes back to the trading balance (the server's payout keeper).
 */
export async function postOrder(w: Wallet, side: Side, amountIn: bigint, minOut: bigint, referenceOut: bigint, commitSecs = 8, revealSecs = 6, market?: string) {
  const order = { side, amount_in: amountIn.toString(), min_out: minOut.toString(), reference_out: referenceOut.toString(), commit_secs: commitSecs, reveal_secs: revealSecs };
  const token: TokenName = side === "Buy" ? "usdc" : "asset";
  if (!w.chain) return depositToTender(w, amountIn, { PostOrder: order }, token, market);
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
  // A wallet of another chain has no NEAR account (implicit: 0x + 40 hex, or 64 hex); a demo account is v<n>.sandbox.
  const ext = /^(0x[0-9a-f]{40}|[0-9a-f]{64})$/.test(accountId);
  const [acct, storage, uw, ui] = await Promise.all([
    ext
      ? null
      : (provider.viewAccount({ accountId } as any).catch((e) => {
          // The devnet starts fresh on every server restart: a demo account saved before it is gone.
          if (/does not exist/.test(String(e?.message)) && loadWallet()?.accountId === accountId) forgetWallet();
          return null;
        }) as Promise<any>),
    v(c.tender, "storage_balance_of"),
    ext ? "0" : v(c.usdc, "ft_balance_of"),
    v(c.intents, "mt_balance_of", { account_id: accountId, token_id: c.token }),
  ]);
  const markets: Record<string, MarketBalances> = {};
  await Promise.all(
    c.markets.map(async (m) => {
      const [ut, aw, ai, at] = await Promise.all([
        v(m.tender, "balance_of"),
        ext ? "0" : v(m.ft, "ft_balance_of"),
        v(c.intents, "mt_balance_of", { account_id: accountId, token_id: m.assetToken }),
        v(m.tender, "asset_balance_of"),
      ]);
      markets[m.symbol] = { usdc: { wallet: uw, intents: ui, tender: ut }, asset: { wallet: aw, intents: ai, tender: at } };
    }),
  );
  const nearM = markets[c.markets[0].symbol];
  return { near: String(acct?.amount ?? "0"), storage, usdc: nearM.usdc, wnear: nearM.asset, markets };
}
