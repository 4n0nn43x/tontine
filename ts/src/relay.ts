// An EVM user trades without a NEAR account. Its NEAR Intents account is implicit: the lower-case `0x`
// address, which signs intents with ERC-191 (`personal_sign`). This file builds and signs such an intent (one
// `transfer` to a market's tender whose `msg` posts the order), checks it before the relayer pays the gas,
// submits it with `execute_intents`, and pays fills back to NEAR Intents (the payout keeper).
//
// Format: github.com/near/intents at 16d04f6 (defuse 0.4.5, the code of intents.near): DefusePayload
// (core/src/payload/mod.rs), Transfer and NotifyOnTransfer (core/src/intents/tokens.rs), VersionedNonce V1
// (core/src/nonce/versioned.rs), SignedErc191Payload (core/src/payload/erc191.rs, crates/signatures/erc191).
import { createHash, randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { baseEncode, type Account, type JsonRpcProvider, nearToYocto } from "near-api-js";
import { call, view, TGAS, type Event } from "./chain.ts";

/** A signed intent as `execute_intents` takes it (MultiPayload, `standard: "erc191"`). */
export type SignedIntent = { standard: "erc191"; payload: string; signature: string };
/** What tender's `PostOrder` message carries. */
export type PostOrderArgs = { side: "Buy" | "Sell"; amount_in: string; min_out: string; reference_out?: string; commit_secs: number; reveal_secs: number };

/** Gas tender's `mt_on_transfer` gets to post the order (defuse's default is 30 TGas). */
export const ORDER_MIN_GAS = TGAS(50);
/**
 * Storage the relayer prepays in a tender for a `0x` account (NEP-145), at 1e19 yoctoNEAR a byte: an order and
 * its auction take 269 bytes, an account's first order 578 (its storage and ledger entries too; measured on the
 * devnet, 2026-11-01), so 0.05 NEAR covers about 17 orders.
 */
export const STORAGE_DEPOSIT = nearToYocto("0.05");
/** Under this storage balance (about 3 orders) the relay tops the account up with STORAGE_DEPOSIT. */
export const STORAGE_MIN = nearToYocto("0.01");
/** Most storage the relay pays for one account, all tenders together. */
export const STORAGE_CAP = nearToYocto("0.3");
/** Most a deadline may be ahead of now: a signed order cannot sit for long. */
const MAX_AHEAD_MS = 10 * 60_000;
/** `VersionedNonce::VERSIONED_MAGIC_PREFIX`. */
const NONCE_MAGIC = Buffer.from("5628f6c6", "hex");

/** The implicit NEAR Intents account of a secp256k1 key: `0x` + hex(keccak256(x || y)[12..]), the EVM address. */
export function evmAccount(secretKey: Uint8Array): string {
  return "0x" + Buffer.from(keccak_256(secp256k1.getPublicKey(secretKey, false).subarray(1)).subarray(12)).toString("hex");
}

/** ERC-191 prehash, as `personal_sign` and defuse's `Erc191::prehash`: keccak256("\x19Ethereum Signed Message:\n" + len + msg). */
export function erc191Hash(msg: string): Uint8Array {
  const m = Buffer.from(msg, "utf8");
  return keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${m.length}`), m]));
}

/** VersionedNonce V1, base64: magic (4) || version 0 (1) || salt (4) || deadline ns, i64 LE (8) || random (15). */
export function versionedNonce(saltHex: string, deadlineMs: number, random: Uint8Array = randomBytes(15)): string {
  if (!/^[0-9a-f]{8}$/.test(saltHex) || random.length !== 15) throw new Error("salt: 4 bytes hex, random: 15 bytes");
  const b = Buffer.alloc(32);
  NONCE_MAGIC.copy(b, 0);
  Buffer.from(saltHex, "hex").copy(b, 5);
  b.writeBigInt64LE(BigInt(deadlineMs) * 1_000_000n, 9);
  Buffer.from(random).copy(b, 17);
  return b.toString("base64");
}

/** The payload an EVM account signs: one transfer of `amount` of `token` to `tender`, whose msg posts `order`. */
export function orderPayload(p: { signer: string; intents: string; tender: string; token: string; amount: bigint; order: PostOrderArgs; salt: string; deadlineMs: number }): string {
  return JSON.stringify({
    signer_id: p.signer,
    verifying_contract: p.intents,
    deadline: new Date(p.deadlineMs).toISOString(),
    nonce: versionedNonce(p.salt, p.deadlineMs),
    intents: [{ intent: "transfer", receiver_id: p.tender, tokens: { [p.token]: p.amount.toString() }, msg: JSON.stringify({ PostOrder: p.order }), min_gas: ORDER_MIN_GAS.toString() }],
  });
}

/** Sign with a local key (the demo, tests): 65 bytes r || s || v, v in {0, 1}, as defuse's Secp256k1RecoverableSignature. */
export function signErc191(payload: string, secretKey: Uint8Array): SignedIntent {
  const sig = secp256k1.sign(erc191Hash(payload), secretKey, { prehash: false, format: "recovered" }); // noble: v || r || s
  return { standard: "erc191", payload, signature: `secp256k1:${baseEncode(Buffer.concat([sig.subarray(1), sig.subarray(0, 1)]))}` };
}

/**
 * The tenders the relay posts to, each with the token ids it takes: USDC first, then its asset. `minOrder`:
 * each tender's `min_order` (USDC base units), so the relay pays nothing for an order the tender refuses.
 */
export type RelayTargets = { intents: string; tenders: Record<string, [string, string]>; minOrder?: Record<string, bigint> };
export type RelayOrder = { signer: string; tender: string; token: string; amount: bigint; order: PostOrderArgs };

const fail = (m: string): never => {
  throw new Error(m);
};

/**
 * Everything the relay checks before it pays any gas: one ERC-191 transfer intent from an implicit `0x`
 * account to one of the tenders, in the token the order sells, of exactly its `amount_in`, whose msg is a
 * PostOrder of at least the tender's `min_order`, with a deadline at most 10 minutes ahead. intents.near checks the signature, nonce and balance
 * (`simulate_intents`, in `submitRelay`).
 */
export function checkRelay(signed: any, t: RelayTargets, now = Date.now()): RelayOrder {
  if (!signed || typeof signed !== "object" || signed.standard !== "erc191") fail("signed: an erc191 payload");
  if (typeof signed.payload !== "string" || signed.payload.length > 4096) fail("payload: a JSON string of at most 4 KB");
  if (typeof signed.signature !== "string" || !/^secp256k1:[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(signed.signature)) fail("signature: secp256k1:<base58 of 65 bytes>");
  let p: any;
  try {
    p = JSON.parse(signed.payload);
  } catch {
    fail("payload: not JSON");
  }
  if (typeof p?.signer_id !== "string" || !/^0x[0-9a-f]{40}$/.test(p.signer_id)) fail("signer_id: an implicit EVM account, lower-case 0x + 40 hex");
  if (p.verifying_contract !== t.intents) fail(`verifying_contract: ${t.intents}`);
  const deadline = Date.parse(p.deadline);
  if (!(deadline > now && deadline <= now + MAX_AHEAD_MS)) fail("deadline: in the next 10 minutes");
  if (typeof p.nonce !== "string" || Buffer.from(p.nonce, "base64").length !== 32) fail("nonce: 32 bytes, base64");
  if (!Array.isArray(p.intents) || p.intents.length !== 1) fail("intents: exactly one");
  const i = p.intents[0];
  if (i?.intent !== "transfer") fail("intent: transfer");
  const tokens = t.tenders[i.receiver_id];
  if (!tokens) fail("receiver_id: one of the tenders");
  const entries = Object.entries(i.tokens ?? {});
  if (entries.length !== 1) fail("tokens: exactly one");
  const [token, amount] = entries[0] as [string, string];
  if (typeof amount !== "string" || !/^[1-9][0-9]{0,30}$/.test(amount)) fail("amount: a positive integer string");
  if (i.min_gas !== undefined && (typeof i.min_gas !== "string" || !/^[0-9]{1,15}$/.test(i.min_gas) || BigInt(i.min_gas) > TGAS(100))) fail("min_gas: at most 100 TGas");
  let msg: any;
  try {
    msg = JSON.parse(i.msg);
  } catch {
    fail("msg: a tender PostOrder message");
  }
  const o = msg?.PostOrder;
  if (!o || Object.keys(msg).length !== 1) fail("msg: a tender PostOrder message");
  if (o.side !== "Buy" && o.side !== "Sell") fail("side: Buy or Sell");
  if (token !== tokens[o.side === "Buy" ? 0 : 1]) fail("tokens: the token the order sells (USDC for a buy, the asset for a sell)");
  if (o.amount_in !== amount) fail("amount_in: the amount transferred");
  if (typeof o.min_out !== "string" || !/^[1-9][0-9]{0,38}$/.test(o.min_out)) fail("min_out: a positive integer string");
  if (![o.commit_secs, o.reveal_secs].every((s) => Number.isInteger(s) && s >= 1 && s <= 600)) fail("commit_secs, reveal_secs: 1 to 600");
  // As the tender counts it: amount_in of a buy, min_out of a sell, both in USDC.
  const min = t.minOrder?.[i.receiver_id] ?? 0n;
  if (BigInt(o.side === "Buy" ? amount : o.min_out) < min) fail(`order below the minimum size of ${Number(min) / 1e6} USDC (amount_in of a buy, min_out of a sell)`);
  return { signer: p.signer_id, tender: i.receiver_id, token, amount: BigInt(amount), order: o };
}

/**
 * Submit a checked intent: `simulate_intents` first (signature, nonce, balance; a view, no gas), then
 * STORAGE_DEPOSIT of tender storage if the account has under STORAGE_MIN (a new account, a used-up deposit, or
 * dust someone deposited for it) and `fundStorage()` allows it, then `execute_intents` from the relayer,
 * which pays the gas. The tender sees the `0x` account as the client and posts the order. If it refuses
 * the order, intents.near returns the tokens to the signer (`mt_resolve_transfer`).
 */
export async function submitRelay(
  relayer: Account,
  provider: JsonRpcProvider,
  intents: string,
  signed: SignedIntent,
  o: RelayOrder,
  fundStorage: () => boolean = () => true,
): Promise<{ txHash: string; orderId: number; events: Event[]; storagePaid: boolean }> {
  try {
    await view(provider, intents, "simulate_intents", { signed: [signed] });
  } catch (e) {
    const m = String((e as Error).message);
    throw new Error(`intents.near refuses it: ${m.match(/(?:panicked: |panic_msg: \\?")([^"\\]+)/)?.[1] ?? m.slice(0, 200)}`);
  }
  let storagePaid = false;
  if (BigInt(await view(provider, o.tender, "storage_balance_of", { account_id: o.signer })) < STORAGE_MIN) {
    if (!fundStorage()) throw new Error("the relay's storage budget for this account or this address is spent, try again later");
    await call(relayer, o.tender, "storage_deposit", { account_id: o.signer }, STORAGE_DEPOSIT);
    storagePaid = true;
  }
  const r = await call(relayer, intents, "execute_intents", { signed: [signed] }, 0n, TGAS(300));
  const posted = r.events.find((e) => e.standard === "tontine" && e.event === "order_posted");
  if (!posted) throw new Error(`the tender refused the order; intents.near returned the tokens (tx ${r.txHash})`);
  return { txHash: r.txHash, orderId: posted.data[0].order_id, events: r.events, storagePaid };
}

/**
 * The relay's limits, in memory: one intent at a time per signer, each signed payload once (in flight, or
 * submitted in the last 10 minutes: no deadline runs longer), and at most STORAGE_CAP of storage per account.
 * Without them, 30 concurrent copies of one intent each paid a storage deposit and an `execute_intents`, and
 * 29 of those failed on the nonce.
 */
export class RelayGate {
  private busy = new Set<string>();
  private seen = new Map<string, number>();
  private paid = new Map<string, bigint>();

  async run<T>(signed: SignedIntent, signer: string, submit: () => Promise<T>, now = Date.now()): Promise<T> {
    for (const [h, at] of this.seen) if (at <= now - MAX_AHEAD_MS) this.seen.delete(h);
    const h = createHash("sha256").update(signed.payload).digest("hex");
    if (this.seen.has(h)) throw new Error("this intent was already submitted");
    if (this.busy.has(signer)) throw new Error("another intent of this account is being submitted, try again in a few seconds");
    this.seen.set(h, now);
    this.busy.add(signer);
    try {
      return await submit();
    } finally {
      this.busy.delete(signer);
    }
  }

  /** Whether the relay pays one more STORAGE_DEPOSIT for `signer`: under STORAGE_CAP, and `budget()` (rate limits) agrees. Counted if so. */
  fundStorage(signer: string, budget: () => boolean = () => true): boolean {
    const p = (this.paid.get(signer) ?? 0n) + STORAGE_DEPOSIT;
    if (p > STORAGE_CAP || !budget()) return false;
    this.paid.set(signer, p);
    return true;
  }
}

/**
 * The payout keeper: after a fill or a refund, a client's proceeds sit in that market's tender ledger.
 * `withdraw_to_intents(client)` (anyone may call it, firm accounts refused) moves them back to the client's
 * NEAR Intents account, its single trading balance. One job per (tender, client) in a small queue, run one at
 * a time, retried with a growing delay; a job that finds nothing to move is done.
 */
export class Payouts {
  private queue: { tender: string; client: string; tries: number }[] = [];
  private queued = new Set<string>();
  private busy = false;
  constructor(
    private pay: (tender: string, client: string) => Promise<unknown>,
    private isFirm: (tender: string, client: string) => Promise<boolean>,
    private log: (s: string) => void = () => {},
    private retryMs = 2000,
    private maxTries = 5,
    private maxQueue = 1000,
  ) {}

  push(tender: string, client: string, tries = 0) {
    const key = `${tender} ${client}`;
    if (this.queued.has(key)) return; // one withdraw_to_intents moves the whole balance
    if (this.queue.length >= this.maxQueue) return this.log(`payouts: queue full, skipped ${client} on ${tender}`);
    this.queued.add(key);
    this.queue.push({ tender, client, tries });
    void this.run();
  }

  get pending() {
    return this.queue.length + (this.busy ? 1 : 0);
  }

  private async run() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const j = this.queue.shift()!;
      const key = `${j.tender} ${j.client}`;
      try {
        const firm = await this.isFirm(j.tender, j.client);
        // Unmarked before the call: a credit it may not see gets a job of its own.
        this.queued.delete(key);
        if (firm) continue;
        await this.pay(j.tender, j.client);
      } catch (e) {
        this.queued.delete(key);
        const m = String((e as Error).message);
        if (m.includes("nothing to withdraw")) continue;
        if (j.tries + 1 < this.maxTries) setTimeout(() => this.push(j.tender, j.client, j.tries + 1), this.retryMs * (j.tries + 1));
        else this.log(`payouts: gave up on ${j.client} on ${j.tender}: ${m}`);
      }
    }
    this.busy = false;
  }
}
