// A user of another chain trades without a NEAR account. Its NEAR Intents account is implicit, derived from
// its wallet's key, and it signs intents with its own wallet's message standard: an EVM wallet (Base,
// Ethereum...) with ERC-191 `personal_sign`, Tron with TIP-191, Solana with a raw Ed25519 signature, Stellar
// with SEP-53, TON with TonConnect `signData`, and a passkey with WebAuthn. This file builds and signs such an
// intent (one `transfer` to a market's tender whose `msg` posts the order), checks it before the relayer pays
// the gas, submits it with `execute_intents`, and pays fills back to NEAR Intents (the payout keeper).
//
// Format: github.com/near/intents at 16d04f6 (defuse 0.4.5, the code of intents.near): DefusePayload
// (core/src/payload/mod.rs), Transfer and NotifyOnTransfer (core/src/intents/tokens.rs), VersionedNonce V1
// (core/src/nonce/versioned.rs), MultiPayload (core/src/payload/multi.rs) and its standards
// (core/src/payload/*.rs, crates/signatures/*), implicit accounts (core/src/public_key.rs).
import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { baseEncode, type Account, type JsonRpcProvider, nearToYocto } from "near-api-js";
import { call, view, TGAS, type Event } from "./chain.ts";

/**
 * A signed intent as `execute_intents` takes it (MultiPayload), in every standard intents.near verifies but
 * NEP-413 (a NEAR key sends its own transactions). Keys and signatures are `<curve>:<base58>`.
 */
export type SignedIntent =
  | { standard: "erc191" | "tip191"; payload: string; signature: string }
  | { standard: "raw_ed25519" | "sep53"; payload: string; public_key: string; signature: string }
  | { standard: "webauthn"; payload: string; public_key: string; signature: string; client_data_json: string; authenticator_data: string }
  | { standard: "ton_connect"; address: string; domain: string; timestamp: number; payload: { type: "text"; text: string }; public_key: string; signature: string };
export type Standard = SignedIntent["standard"];
export const STANDARDS: Standard[] = ["erc191", "tip191", "raw_ed25519", "sep53", "ton_connect", "webauthn"];
/** What tender's `PostOrder` message carries. */
export type PostOrderArgs = { side: "Buy" | "Sell"; amount_in: string; min_out: string; reference_out?: string; commit_secs: number; reveal_secs: number };

/** Gas tender's `mt_on_transfer` gets to post the order (defuse's default is 30 TGas). */
export const ORDER_MIN_GAS = TGAS(50);
/**
 * Storage the relayer prepays in a tender for an implicit account (NEP-145), at 1e19 yoctoNEAR a byte: an order and
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

/** The implicit NEAR Intents account of a secp256k1 key: `0x` + hex(keccak256(x || y)[12..]), the EVM address (Tron's too). */
export function evmAccount(secretKey: Uint8Array): string {
  return "0x" + Buffer.from(keccak_256(secp256k1.getPublicKey(secretKey, false).subarray(1)).subarray(12)).toString("hex");
}
/** The implicit account of an Ed25519 public key (Solana, Stellar, TON, an Ed25519 passkey): its 64 hex characters. */
export const ed25519Account = (publicKey: Uint8Array) => Buffer.from(publicKey).toString("hex");
/** The implicit account of a P-256 public key (x || y, 64 bytes; a passkey): `0x` + hex(keccak256("p256" || x || y)[12..]). */
export const p256Account = (xy: Uint8Array) => "0x" + Buffer.from(keccak_256(Buffer.concat([Buffer.from("p256"), xy])).subarray(12)).toString("hex");

/** ERC-191 prehash, as `personal_sign` and defuse's `Erc191::prehash`: keccak256("\x19Ethereum Signed Message:\n" + len + msg). */
export function erc191Hash(msg: string): Uint8Array {
  const m = Buffer.from(msg, "utf8");
  return keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${m.length}`), m]));
}
/** TIP-191 prehash, as TronLink's `signMessageV2`: the same with "\x19TRON Signed Message:\n". */
export function tip191Hash(msg: string): Uint8Array {
  const m = Buffer.from(msg, "utf8");
  return keccak_256(Buffer.concat([Buffer.from(`\x19TRON Signed Message:\n${m.length}`), m]));
}
/** SEP-53 prehash (Stellar wallets' `signMessage`): sha256("Stellar Signed Message:\n" || msg). */
export const sep53Hash = (msg: string) => sha256(Buffer.concat([Buffer.from("Stellar Signed Message:\n"), Buffer.from(msg, "utf8")]));
/**
 * TonConnect `signData` prehash of a text: sha256(0xffff || "ton-connect/sign-data/" || workchain (i32 BE) ||
 * address (32) || domain length (u32 BE) || domain || timestamp (u64 BE) || "txt" || text length (u32 BE) || text).
 */
export function tonConnectHash(address: string, domain: string, timestamp: number, text: string): Uint8Array {
  const [wc, hash] = address.split(":");
  const d = Buffer.from(domain, "utf8"), t = Buffer.from(text, "utf8");
  const n = Buffer.alloc(4 + 4 + 8 + 4);
  n.writeInt32BE(Number(wc), 0);
  n.writeUInt32BE(d.length, 4);
  n.writeBigUInt64BE(BigInt(timestamp), 8);
  n.writeUInt32BE(t.length, 16);
  return sha256(Buffer.concat([Buffer.from("ffff", "hex"), Buffer.from("ton-connect/sign-data/"), n.subarray(0, 4), Buffer.from(hash, "hex"), n.subarray(4, 8), d, n.subarray(8, 16), Buffer.from("txt"), n.subarray(16), t]));
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

/** The payload a wallet signs: one transfer of `amount` of `token` to `tender`, whose msg posts `order`. */
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
export function signErc191(payload: string, secretKey: Uint8Array, standard: "erc191" | "tip191" = "erc191"): SignedIntent {
  const sig = secp256k1.sign((standard === "tip191" ? tip191Hash : erc191Hash)(payload), secretKey, { prehash: false, format: "recovered" }); // noble: v || r || s
  return { standard, payload, signature: `secp256k1:${baseEncode(Buffer.concat([sig.subarray(1), sig.subarray(0, 1)]))}` };
}

/**
 * Sign with a local key as each wallet does (the demo, tests): an EVM or Tron wallet with a secp256k1 key,
 * Phantom (`raw_ed25519`, the payload itself), a Stellar or TON wallet with an Ed25519 key, a passkey with a
 * P-256 key (the authenticator data and client data a browser would produce). `address` is the TON wallet's.
 */
export function signAs(standard: Standard, payload: string, secretKey: Uint8Array, o: { address?: string; domain?: string; now?: number } = {}): SignedIntent {
  if (standard === "erc191" || standard === "tip191") return signErc191(payload, secretKey, standard);
  const ed = (msg: Uint8Array) => ({ public_key: `ed25519:${baseEncode(ed25519.getPublicKey(secretKey))}`, signature: `ed25519:${baseEncode(ed25519.sign(msg, secretKey))}` });
  if (standard === "raw_ed25519") return { standard, payload, ...ed(Buffer.from(payload, "utf8")) };
  if (standard === "sep53") return { standard, payload, ...ed(sep53Hash(payload)) };
  if (standard === "ton_connect") {
    const address = o.address ?? "0:" + "00".repeat(32), domain = o.domain ?? "tontine.fyra.fun", timestamp = Math.floor((o.now ?? Date.now()) / 1000);
    return { standard, address, domain, timestamp, payload: { type: "text", text: payload }, ...ed(tonConnectHash(address, domain, timestamp, payload)) };
  }
  // WebAuthn: the authenticator signs authenticatorData || sha256(clientDataJSON), whose challenge is sha256(payload).
  const client_data_json = JSON.stringify({ type: "webauthn.get", challenge: Buffer.from(sha256(Buffer.from(payload, "utf8"))).toString("base64url"), origin: `https://${o.domain ?? "tontine.fyra.fun"}` });
  const auth = Buffer.concat([sha256(Buffer.from(o.domain ?? "tontine.fyra.fun")), Buffer.from([0x05, 0, 0, 0, 1])]); // rpIdHash, flags UP | UV, counter
  const sig = p256.sign(Buffer.concat([auth, sha256(Buffer.from(client_data_json))]), secretKey, { lowS: true });
  return {
    standard, payload, client_data_json, authenticator_data: auth.toString("base64url"),
    public_key: `p256:${baseEncode(p256.getPublicKey(secretKey, false).subarray(1))}`, signature: `p256:${baseEncode(sig)}`,
  };
}

/** The implicit account a local key signs for in `standard` (see signAs). */
export function accountOf(standard: Standard, secretKey: Uint8Array): string {
  if (standard === "erc191" || standard === "tip191") return evmAccount(secretKey);
  if (standard === "webauthn") return p256Account(p256.getPublicKey(secretKey, false).subarray(1));
  return ed25519Account(ed25519.getPublicKey(secretKey));
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

const B58 = (min: number, max: number) => new RegExp(`^[1-9A-HJ-NP-Za-km-z]{${min},${max}}$`);
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/**
 * The signed envelope of each standard, checked for shape only (intents.near verifies the signature): the
 * DefusePayload JSON it carries (TonConnect's is the signed text) and the curve of its key.
 */
function envelope(signed: any): { text: string; curve: "secp256k1" | "ed25519" | "p256" } {
  if (!signed || typeof signed !== "object" || !STANDARDS.includes(signed.standard)) fail(`signed: one of ${STANDARDS.join(", ")}`);
  const st: Standard = signed.standard;
  const text = st === "ton_connect" ? signed.payload?.text : signed.payload;
  if (!isStr(text, 4096)) fail("payload: a JSON string of at most 4 KB");
  if (st === "erc191" || st === "tip191") {
    if (!isStr(signed.signature, 120) || !B58(80, 100).test(signed.signature.slice(10)) || !signed.signature.startsWith("secp256k1:")) fail("signature: secp256k1:<base58 of 65 bytes>");
    return { text, curve: "secp256k1" };
  }
  const curve = st === "webauthn" && String(signed.public_key).startsWith("p256:") ? "p256" : "ed25519";
  const [pk, sig] = [signed.public_key, signed.signature].map((v) => (typeof v === "string" && v.startsWith(curve + ":") ? v.slice(curve.length + 1) : ""));
  if (!(curve === "p256" ? B58(64, 90) : B58(32, 44)).test(pk)) fail(`public_key: ${curve}:<base58 of ${curve === "p256" ? "x || y, 64" : "32"} bytes>`);
  if (!B58(64, 90).test(sig)) fail(`signature: ${curve}:<base58 of 64 bytes>`);
  if (st === "webauthn" && (!isStr(signed.client_data_json, 1024) || typeof signed.authenticator_data !== "string" || !/^[A-Za-z0-9_-]{50,400}$/.test(signed.authenticator_data)))
    fail("webauthn: client_data_json (JSON text) and authenticator_data (base64url)");
  if (st === "ton_connect") {
    if (!isStr(signed.address, 80) || !/^-?[0-9]{1,10}:[0-9a-fA-F]{64}$/.test(signed.address)) fail("address: the TON wallet's raw address, <workchain>:<64 hex>");
    if (!isStr(signed.domain, 253)) fail("domain: the domain the wallet signed for");
    if (!Number.isSafeInteger(signed.timestamp) || signed.timestamp <= 0) fail("timestamp: seconds");
    if (signed.payload.type !== "text" || Object.keys(signed.payload).length !== 2) fail("payload: a TonConnect text payload");
  }
  return { text, curve };
}

/** The DefusePayload JSON a signed intent carries. */
export const intentText = (signed: SignedIntent) => envelope(signed).text;

/**
 * Everything the relay checks before it pays any gas: one transfer intent, in one of the standards above,
 * from the implicit account of its key to one of the tenders, in the token the order sells, of exactly its
 * `amount_in`, whose msg is a PostOrder of at least the tender's `min_order`, with a deadline at most 10
 * minutes ahead. intents.near checks the signature, nonce and balance (`simulate_intents`, in `submitRelay`).
 */
export function checkRelay(signed: any, t: RelayTargets, now = Date.now()): RelayOrder {
  const { text, curve } = envelope(signed);
  let p: any;
  try {
    p = JSON.parse(text);
  } catch {
    fail("payload: not JSON");
  }
  if (typeof p?.signer_id !== "string" || !(curve === "ed25519" ? /^[0-9a-f]{64}$/ : /^0x[0-9a-f]{40}$/).test(p.signer_id))
    fail(`signer_id: the implicit account of the ${curve} key, ${curve === "ed25519" ? "64 lower-case hex" : "lower-case 0x + 40 hex"}`);
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
    msg = typeof i.msg === "string" ? JSON.parse(i.msg) : null;
  } catch {
    fail("msg: a tender PostOrder message");
  }
  const o = msg?.PostOrder;
  if (!o || Object.keys(msg).length !== 1) fail("msg: a tender PostOrder message");
  if (o.side !== "Buy" && o.side !== "Sell") fail("side: Buy or Sell");
  if (token !== tokens[o.side === "Buy" ? 0 : 1]) fail("tokens: the token the order sells (USDC for a buy, the asset for a sell)");
  if (o.amount_in !== amount) fail("amount_in: the amount transferred");
  const u128 = (v: unknown) => typeof v === "string" && /^[1-9][0-9]{0,38}$/.test(v) && BigInt(v) < 2n ** 128n;
  if (!u128(o.min_out)) fail("min_out: a positive integer string");
  if (o.reference_out !== undefined && o.reference_out !== null && !u128(o.reference_out)) fail("reference_out: a positive integer string or null");
  if (![o.commit_secs, o.reveal_secs].every((s) => Number.isInteger(s) && s >= 1 && s <= 600)) fail("commit_secs, reveal_secs: 1 to 600");
  // The msg must be exactly this order, written the one way the tender parses it: no duplicate or extra key,
  // no 8.0 for 8. What the tender would refuse costs the relayer storage and gas for nothing.
  const canonical = { side: o.side, amount_in: o.amount_in, min_out: o.min_out, reference_out: o.reference_out, commit_secs: o.commit_secs, reveal_secs: o.reveal_secs };
  if (i.msg !== JSON.stringify({ PostOrder: canonical })) fail("msg: exactly {\"PostOrder\":{side, amount_in, min_out, reference_out, commit_secs, reveal_secs}}, in that order");
  // As the tender counts it: amount_in of a buy, min_out of a sell, both in USDC.
  const min = t.minOrder?.[i.receiver_id] ?? 0n;
  if (BigInt(o.side === "Buy" ? amount : o.min_out) < min) fail(`order below the minimum size of ${Number(min) / 1e6} USDC (amount_in of a buy, min_out of a sell)`);
  return { signer: p.signer_id, tender: i.receiver_id, token, amount: BigInt(amount), order: o };
}

/**
 * Submit a checked intent: `simulate_intents` first (signature, nonce, balance; a view, no gas), then
 * STORAGE_DEPOSIT of tender storage if the account has under STORAGE_MIN (a new account, a used-up deposit, or
 * dust someone deposited for it) and `fundStorage()` allows it, then `execute_intents` from the relayer,
 * which pays the gas. The tender sees the implicit account as the client and posts the order. If it refuses
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
    const h = createHash("sha256").update(intentText(signed)).digest("hex");
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
