import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { baseEncode, type JsonRpcProvider } from "near-api-js";
import { deriveEvmAddress, evmAddress, signedTxHex, type EvmTx } from "./evm.ts";

// The secp256k1 generator G (SEC 2 v2, section 2.4.1), i.e. the public key of private key 1, whose
// Ethereum address is the well-known 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf.
const G = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
const G_KEY = "secp256k1:" + baseEncode(Buffer.from(G, "hex"));

test("the EVM address is the last 20 bytes of keccak256 of the key", async () => {
  assert.equal(evmAddress(G_KEY), "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  assert.throws(() => evmAddress("ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"));
  let asked: any;
  // The firm answers its current path (it changes at each takeover), the signer the derived key.
  const provider = { callFunction: async (q: any) => (q.method === "evm_path" ? "evm-2" : ((asked = q), G_KEY)) } as unknown as JsonRpcProvider;
  assert.equal(await deriveEvmAddress(provider, "v1.signer", "w1.tender.near"), "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  assert.deepEqual(asked, { contractId: "v1.signer", method: "derived_public_key", args: { path: "evm-2", predecessor: "w1.tender.near", domain_id: 0 } });
});

// A real Base mainnet USDC transfer (value 0, empty access list), block 53349793:
// https://basescan.org/tx/0xd0be552301024625eb9b3c3a3d7f2966ca4c7e865844d602090fe1a159671fa0
const BASE_TX: EvmTx = {
  chain_id: 8453,
  nonce: 0x2b746,
  max_priority_fee_per_gas: "1000000",
  max_fee_per_gas: "11000000",
  gas_limit: 0x1339f,
  to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  data: "0xa9059cbb000000000000000000000000745317bc9ae61448e03c7664e418322fced0493c00000000000000000000000000000000000000000000000000000000072fa920",
};
const SIG = {
  big_r: { affine_point: "0373f8e74ee4b33ff79e7b00a92f95e26295c92247734c57db22020300310ba270" },
  s: { scalar: "50634b540d6be494821720b11d21a7e3b8be7e6ec55669eff949bafe3c668a1f" },
  recovery_id: 1,
};

test("the signed transaction hashes to the published Base tx hash", () => {
  const raw = signedTxHex(BASE_TX, SIG);
  assert.match(raw, /^0x02f8b3/);
  assert.equal("0x" + Buffer.from(keccak_256(Buffer.from(raw.slice(2), "hex"))).toString("hex"), "0xd0be552301024625eb9b3c3a3d7f2966ca4c7e865844d602090fe1a159671fa0");
  assert.throws(() => signedTxHex(BASE_TX, { ...SIG, recovery_id: 2 }), /y parity/);
  assert.throws(() => signedTxHex({ ...BASE_TX, data: "0xa9059cb" }, SIG), /not 0x hex/);
});
