// The firm's EVM address through NEAR Chain Signatures: derive it, assemble a transaction the MPC
// signed through the firm contract's `sign_evm`, broadcast it. The contract checks the owner's policy.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { PublicKey, type JsonRpcProvider } from "near-api-js";
import { view } from "./chain.ts";

/** The firm contract's EvmTx: an EIP-1559 call with value 0 and an empty access list. */
export type EvmTx = {
  chain_id: number;
  nonce: number;
  /** Wei, decimal string (U128). */
  max_priority_fee_per_gas: string;
  max_fee_per_gas: string;
  gas_limit: number;
  to: string;
  data: string;
};

/** The MPC signer's Secp256k1 response, as `sign_evm` returns it. */
export type MpcSignature = { big_r: { affine_point: string }; s: { scalar: string }; recovery_id: number };

function hex(s: string): Buffer {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(s)) throw new Error(`not 0x hex: ${s}`);
  return Buffer.from(s.slice(2), "hex");
}

// RLP: minimal big-endian integers, byte strings, lists.
function be(n: bigint): Buffer {
  const h = n.toString(16);
  return n === 0n ? Buffer.alloc(0) : Buffer.from(h.length % 2 ? "0" + h : h, "hex");
}
function header(len: number, offset: number): Buffer {
  if (len < 56) return Buffer.from([offset + len]);
  const l = be(BigInt(len));
  return Buffer.concat([Buffer.from([offset + 55 + l.length]), l]);
}
const rlpBytes = (b: Buffer) => (b.length === 1 && b[0] < 0x80 ? b : Buffer.concat([header(b.length, 0x80), b]));
const rlpInt = (n: bigint | number | string) => rlpBytes(be(BigInt(n)));
const rlpList = (items: Buffer[]) => {
  const body = Buffer.concat(items);
  return Buffer.concat([header(body.length, 0xc0), body]);
};

/** EVM address of a NEAR secp256k1 public key (64 bytes, x || y): the last 20 bytes of its keccak256. */
export function evmAddress(publicKey: string): string {
  const data = PublicKey.fromString(publicKey).data;
  if (!publicKey.startsWith("secp256k1:") || data.length !== 64) throw new Error(`not a secp256k1 key: ${publicKey}`);
  return "0x" + Buffer.from(keccak_256(data).subarray(12)).toString("hex");
}

/** The firm's EVM address: the MPC key the signer derives for `firmAccount` and `path` (the firm's `evm_path()`). */
/** The firm's current EVM address. Its path ("evm-1", "evm-2"...) changes at each takeover: read from the firm. */
export async function deriveEvmAddress(provider: JsonRpcProvider, signer: string, firmAccount: string, path?: string): Promise<string> {
  const p = path ?? (await view<string>(provider, firmAccount, "evm_path"));
  return evmAddress(await view<string>(provider, signer, "derived_public_key", { path: p, predecessor: firmAccount, domain_id: 0 }));
}

/** Raw signed EIP-1559 transaction: 0x02 || rlp([...tx fields, y parity, r, s]), r being big_r's x. */
export function signedTxHex(tx: EvmTx, sig: MpcSignature): string {
  if (sig.recovery_id !== 0 && sig.recovery_id !== 1) throw new Error(`recovery_id ${sig.recovery_id} is not a y parity`);
  const r = hex("0x" + sig.big_r.affine_point).subarray(1); // compressed point: 02 or 03, then x
  const s = hex("0x" + sig.s.scalar);
  if (r.length !== 32 || s.length !== 32) throw new Error("big_r must be 33 bytes and s 32");
  const items = [tx.chain_id, tx.nonce, tx.max_priority_fee_per_gas, tx.max_fee_per_gas, tx.gas_limit].map(rlpInt);
  items.push(rlpBytes(hex(tx.to)), rlpInt(0), rlpBytes(hex(tx.data)), rlpList([]));
  items.push(rlpInt(sig.recovery_id), rlpInt("0x" + r.toString("hex")), rlpInt("0x" + s.toString("hex")));
  return "0x" + Buffer.concat([Buffer.from([0x02]), rlpList(items)]).toString("hex");
}

/** Send a raw transaction to an EVM JSON-RPC endpoint; returns its hash. */
export async function broadcast(rpcUrl: string, rawTx: string): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [rawTx] }),
  });
  const body: any = await res.json();
  if (body.error) throw new Error(`eth_sendRawTransaction: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}
