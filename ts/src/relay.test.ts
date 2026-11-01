import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { baseDecode } from "near-api-js";
import {
  checkRelay, erc191Hash, evmAccount, orderPayload, Payouts, RelayGate, signErc191, STORAGE_CAP, STORAGE_DEPOSIT, STORAGE_MIN, submitRelay, versionedNonce, type PostOrderArgs, type RelayTargets,
} from "./relay.ts";

// defuse's own vector (crates/signatures/erc191/src/lib.rs, near/intents 16d04f6): this key signed "Hello world!".
const PK = "85a66984273f338ce4ef7b85e5430b008307e8591bb7c1b980852cf6423770b801f41e9438155eb53a5e20f748640093bb42ae3aeca035f7b7fd7a1a21f22f68";
const SIG = "7800a70d05cde2c49ed546a6ce887ce6027c2c268c0285f6efef0cdfc4366b23643790f67a86468ee8301ed12cfffcb07c6530f90a9327ec057800fabd332e4701";

/** defuse's layout r || s || v back to noble's v || r || s, then recover the uncompressed key without its 04 tag. */
const recover = (msg: string, rsv: Uint8Array) =>
  Buffer.from(secp256k1.Point.fromBytes(secp256k1.recoverPublicKey(Buffer.concat([rsv.subarray(64), rsv.subarray(0, 64)]), erc191Hash(msg), { prehash: false })).toBytes(false).subarray(1)).toString("hex");

test("ERC-191 prehash and signature layout match defuse's test vector", () => {
  assert.equal(recover("Hello world!", Buffer.from(SIG, "hex")), PK);
});

test("a local key signs an intent intents.near can verify, from the implicit 0x account", () => {
  // Private key 1: its address is the well-known 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf.
  const sk = Buffer.from("00".repeat(31) + "01", "hex");
  assert.equal(evmAccount(sk), "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  const s = signErc191("Hello world!", sk);
  const rsv = baseDecode(s.signature.replace("secp256k1:", ""));
  assert.equal(rsv.length, 65);
  assert.ok(rsv[64] === 0 || rsv[64] === 1);
  assert.equal(recover("Hello world!", rsv), Buffer.from(secp256k1.getPublicKey(sk, false).subarray(1)).toString("hex"));
});

test("versioned nonce V1: magic, version, salt, deadline in ns, 15 random bytes", () => {
  const n = Buffer.from(versionedNonce("0a0b0c0d", 1_782_395_622_123, new Uint8Array(15).fill(7)), "base64");
  assert.equal(n.length, 32);
  assert.equal(n.subarray(0, 5).toString("hex"), "5628f6c600");
  assert.equal(n.subarray(5, 9).toString("hex"), "0a0b0c0d");
  assert.equal(n.readBigInt64LE(9), 1_782_395_622_123_000_000n);
  assert.deepEqual([...n.subarray(17)], Array(15).fill(7));
});

test("the relay accepts one PostOrder transfer to a tender and refuses anything else", () => {
  const t: RelayTargets = { intents: "intents.sandbox", tenders: { "tender.sandbox": ["nep141:usdc.sandbox", "nep141:wnear.sandbox"] } };
  const sk = secp256k1.utils.randomSecretKey();
  const signer = evmAccount(sk);
  const order: PostOrderArgs = { side: "Buy", amount_in: "40000000", min_out: "7000000000000000000000000", commit_secs: 8, reveal_secs: 6 };
  const now = Date.now();
  const base = { signer, intents: t.intents, tender: "tender.sandbox", token: "nep141:usdc.sandbox", amount: 40_000_000n, order, salt: "0a0b0c0d", deadlineMs: now + 60_000 };
  const ok = checkRelay(signErc191(orderPayload(base), sk), t, now);
  assert.deepEqual([ok.signer, ok.tender, ok.token, ok.amount, ok.order.side], [signer, "tender.sandbox", "nep141:usdc.sandbox", 40_000_000n, "Buy"]);
  const p = JSON.parse(orderPayload(base));
  assert.equal(p.intents[0].min_gas, "50000000000000");
  const bad = (edit: (p: any) => void, why: RegExp) => {
    const q = JSON.parse(orderPayload(base));
    edit(q);
    assert.throws(() => checkRelay(signErc191(JSON.stringify(q), sk), t, now), why);
  };
  bad((q) => (q.intents[0].receiver_id = "evil.sandbox"), /receiver_id/);
  bad((q) => q.intents.push(q.intents[0]), /exactly one/);
  bad((q) => (q.intents[0].intent = "ft_withdraw"), /intent: transfer/);
  bad((q) => (q.intents[0].tokens = { "nep141:wnear.sandbox": "40000000" }), /the token the order sells/);
  bad((q) => (q.intents[0].msg = JSON.stringify({ Credit: "evil.sandbox" })), /PostOrder/);
  bad((q) => (q.intents[0].msg = JSON.stringify({ PostOrder: { ...order, amount_in: "1" } })), /amount_in/);
  bad((q) => (q.signer_id = "alice.near"), /signer_id/);
  bad((q) => (q.verifying_contract = "intents.near"), /verifying_contract/);
  bad((q) => (q.deadline = new Date(now + 3_600_000).toISOString()), /deadline/);
  bad((q) => (q.intents[0].min_gas = "300000000000000"), /min_gas/);
  assert.throws(() => checkRelay({ standard: "nep413", payload: "{}", signature: "x" }, t, now), /erc191/);
});

test("payouts: one job per client and tender, firms skipped, failures retried, nothing to move is done", async () => {
  const paid: string[] = [];
  let flaky = 1;
  const p = new Payouts(
    async (tender, client) => {
      if (client === "flaky" && flaky-- > 0) throw new Error("RPC timeout");
      if (client === "empty") throw new Error("Smart contract panicked: nothing to withdraw");
      paid.push(`${tender}:${client}`);
    },
    async (_t, client) => client.startsWith("w1."),
    () => {},
    5,
  );
  p.push("tender", "alice");
  p.push("tender", "alice");
  p.push("tender-eth", "alice");
  p.push("tender", "w1.tender");
  p.push("tender", "empty");
  p.push("tender", "flaky");
  for (let i = 0; i < 100 && (p.pending || paid.length < 3); i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(paid.sort(), ["tender-eth:alice", "tender:alice", "tender:flaky"]);
});

test("the relay refuses an order under the tender's min_order: no storage for an order the tender would refuse", () => {
  const t: RelayTargets = { intents: "intents.sandbox", tenders: { "tender.sandbox": ["nep141:usdc.sandbox", "nep141:wnear.sandbox"] }, minOrder: { "tender.sandbox": 1_000_000n } };
  const sk = secp256k1.utils.randomSecretKey();
  const now = Date.now();
  const post = (side: "Buy" | "Sell", amount: bigint, minOut: string) => {
    const order: PostOrderArgs = { side, amount_in: amount.toString(), min_out: minOut, commit_secs: 8, reveal_secs: 6 };
    const token = t.tenders["tender.sandbox"][side === "Buy" ? 0 : 1];
    return checkRelay(signErc191(orderPayload({ signer: evmAccount(sk), intents: t.intents, tender: "tender.sandbox", token, amount, order, salt: "0a0b0c0d", deadlineMs: now + 60_000 }), sk), t, now);
  };
  assert.throws(() => post("Buy", 999_999n, "1"), /minimum size of 1 USDC/);
  assert.equal(post("Buy", 1_000_000n, "1").amount, 1_000_000n);
  // A sell counts its min_out in USDC, whatever the asset amount.
  assert.throws(() => post("Sell", 10n ** 24n, "999999"), /minimum size/);
  assert.equal(post("Sell", 1n, "1000000").order.side, "Sell");
});

/** A chain with one tender: views take 5 ms, the relayer's transactions 20 ms each, one at a time (devnet.serialize). */
function mockChain(storage: bigint) {
  const st = { storage, deposits: [] as bigint[], executes: 0 };
  const provider: any = {
    callFunction: async ({ method }: any) => {
      await new Promise((r) => setTimeout(r, 5));
      return method === "storage_balance_of" ? st.storage.toString() : {};
    },
  };
  let queue: Promise<unknown> = Promise.resolve();
  const outcome = (logs: string[]) => ({ status: { SuccessValue: "" }, transaction: { hash: "h" }, receipts_outcome: [{ outcome: { logs } }] });
  const relayer: any = {
    signAndSendTransaction: (a: any) => {
      const run = queue.then(async () => {
        await new Promise((r) => setTimeout(r, 20));
        const fc = a.actions[0].functionCall;
        if (fc.methodName === "storage_deposit") {
          st.deposits.push(BigInt(fc.deposit));
          st.storage += BigInt(fc.deposit);
          return outcome([]);
        }
        st.executes++;
        return outcome([`EVENT_JSON:${JSON.stringify({ standard: "tontine", event: "order_posted", data: [{ order_id: st.executes }] })}`]);
      });
      queue = run.catch(() => {});
      return run;
    },
  };
  return { st, provider, relayer };
}

function relayFixture() {
  const t: RelayTargets = { intents: "intents.sandbox", tenders: { "tender.sandbox": ["nep141:usdc.sandbox", "nep141:wnear.sandbox"] } };
  const sk = secp256k1.utils.randomSecretKey();
  const sign = (amount = 40_000_000n) => {
    const order: PostOrderArgs = { side: "Buy", amount_in: amount.toString(), min_out: "1", commit_secs: 8, reveal_secs: 6 };
    return signErc191(orderPayload({ signer: evmAccount(sk), intents: t.intents, tender: "tender.sandbox", token: "nep141:usdc.sandbox", amount, order, salt: "0a0b0c0d", deadlineMs: Date.now() + 60_000 }), sk);
  };
  return { t, sign };
}

test("relay storage: paid under STORAGE_MIN (new, used up, or dust a griefer deposited), never at or over it", async () => {
  const { t, sign } = relayFixture();
  const signed = sign();
  const o = checkRelay(signed, t);
  for (const [have, paid] of [[0n, true], [10n ** 18n, true], [STORAGE_MIN - 1n, true], [STORAGE_MIN, false], [STORAGE_DEPOSIT, false]] as const) {
    const c = mockChain(have);
    const r = await submitRelay(c.relayer, c.provider, t.intents, signed, o);
    assert.deepEqual([r.storagePaid, c.st.deposits, c.st.executes], [paid, paid ? [STORAGE_DEPOSIT] : [], 1], `storage balance ${have}`);
  }
  assert.ok(STORAGE_DEPOSIT >= 4n * STORAGE_MIN, "a deposit lasts several orders before the next top-up");
  const c = mockChain(0n);
  await assert.rejects(submitRelay(c.relayer, c.provider, t.intents, signed, o, () => false), /storage budget/);
  assert.equal(c.st.executes, 0, "no execute_intents when the storage is refused");
});

test("relay gate: 30 concurrent copies of one intent pay one deposit and one execute_intents", async () => {
  const { t, sign } = relayFixture();
  const signed = sign();
  const o = checkRelay(signed, t);
  const c = mockChain(0n);
  const gate = new RelayGate();
  const submit = () => submitRelay(c.relayer, c.provider, t.intents, signed, o, () => gate.fundStorage(o.signer));
  const rs = await Promise.allSettled(Array.from({ length: 30 }, () => gate.run(signed, o.signer, submit)));
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(rs.every((r) => r.status === "fulfilled" || /already submitted/.test(r.reason.message)));
  assert.deepEqual([c.st.deposits.length, c.st.executes], [1, 1]);
  // Submitted: refused for 10 minutes, the longest a deadline runs; then forgotten.
  await assert.rejects(gate.run(signed, o.signer, async () => 1), /already submitted/);
  assert.equal(await gate.run(signed, o.signer, async () => 1, Date.now() + 10 * 60_000 + 1), 1);
});

test("relay gate: one intent at a time per signer, others pass", async () => {
  const gate = new RelayGate();
  const { sign } = relayFixture();
  let release = () => {};
  const slow = gate.run(sign(1_000_000n), "0xa", () => new Promise<string>((r) => (release = () => r("first"))));
  await assert.rejects(gate.run(sign(2_000_000n), "0xa", async () => "second"), /being submitted/);
  assert.equal(await gate.run(sign(3_000_000n), "0xb", async () => "other signer"), "other signer");
  release();
  assert.equal(await slow, "first");
  assert.equal(await gate.run(sign(4_000_000n), "0xa", async () => "after"), "after");
  await assert.rejects(gate.run(sign(5_000_000n), "0xa", async () => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(await gate.run(sign(6_000_000n), "0xa", async () => "after a failure"), "after a failure");
});

test("relay gate: storage capped per account, and only counted when the rate limits agree", () => {
  const gate = new RelayGate();
  assert.equal(gate.fundStorage("0xa", () => false), false);
  const n = Number(STORAGE_CAP / STORAGE_DEPOSIT);
  assert.equal(n, 6);
  for (let i = 0; i < n; i++) assert.equal(gate.fundStorage("0xa"), true, `deposit ${i + 1}`);
  assert.equal(gate.fundStorage("0xa"), false, "over STORAGE_CAP");
  assert.equal(gate.fundStorage("0xb"), true, "another account");
});
