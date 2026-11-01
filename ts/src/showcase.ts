// The testnet showcase, next to the devnet the site plays on: the same contracts on NEAR testnet, a public chain
// anyone can check on testnet.nearblocks.io. Under the master account (TESTNET_ACCOUNT, TESTNET_KEY): our copy
// of the intents.near mainnet code (NEAR Intents is not deployed on testnet), mock USDC and wNEAR (only the token
// account mints), one NEAR/USDC tender with two house firms, and a house client whose order, every
// SHOWCASE_ORDER_MIN minutes, the same swarm auctions. Once, a real Chain Signatures proof: the MPC network
// (v1.signer-prod.testnet) signs a Base Sepolia transaction for a firm, within its owner's policy.
//
// The setup runs step by step and saves after each one (TESTNET_DIR/testnet.json, with the keys of the accounts
// it creates, saved before each account exists): a start that runs out of NEAR or dies resumes where it stopped.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { JsonRpcProvider, KeyPair, nearToYocto, type Account } from "near-api-js";
import { account, call, sleep, view, TGAS, USDC } from "./chain.ts";
import { createFirm, deployContract, wasm } from "./deploy.ts";
import { DEVNET_CONFIG, NEAR_, serialize, tenderConfig, units } from "./devnet.ts";
import { deriveEvmAddress, signedTxHex, type EvmTx, type MpcSignature } from "./evm.ts";
import { makeLlm } from "./llm.ts";
import { ASSETS, reference } from "./prices.ts";
import { loadStrategies } from "./strategy.ts";
import { Swarm, type FirmHandle } from "./swarm.ts";

const RPC = process.env.TESTNET_RPC ?? "https://rpc.testnet.fastnear.com";
const DIR = path.resolve(process.env.TESTNET_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "keys"));
const FILE = path.join(DIR, "testnet.json");
const ORDER_MIN = Number(process.env.SHOWCASE_ORDER_MIN ?? 30);
const SIGNER = "v1.signer-prod.testnet";
const EXPLORER = "https://testnet.nearblocks.io";
/** The two house firms of the showcase: rule managers only, no LLM spend. */
const FIRMS = ["Undercut & Co", "Cost Plus Ltd"];
/** NEAR each account starts with: storage of its contract and state, then gas. intents.near's code alone is 1.27 MB. */
const ACCOUNTS: [string, string][] = [
  ["intents", "14"],
  ["usdc", "2.4"],
  ["wnear", "2.4"],
  ["tender", "15"], // 4.1 of code, 2 of firm code in state, then 3 per house firm it creates
  ["o1", "0.5"],
  ["o2", "0.5"],
  ["client", "0.5"],
];
/** What the setup needs on the master account: the accounts above, storage deposits in tender, and gas. */
export const SHOWCASE_NEED = 37;
/** Tender storage (NEP-145) each showcase account keeps, topped up from the master under STORAGE_LOW. */
const STORAGE = nearToYocto("0.2");
const STORAGE_LOW = nearToYocto("0.05");
// Base Sepolia (84532) USDC; the transfer goes to a burn address the owner lists. Signed, not broadcast: the
// firm's address holds no Base Sepolia ETH for gas.
const BASE_SEPOLIA = 84532;
const BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const RECIPIENT = "0x000000000000000000000000000000000000dead";

export type ShowcaseOrder = { id: number; side: "Buy" | "Sell"; amountIn: string; out: string | null; status: string; postTx: string; settleTx: string; at: number };
export type EvmProof = { firm: string; signer: string; path: string; address: string; recovered: string; ok: boolean; nearTx: string; payloadHash: string; signedTxHash: string; at: number };
type State = {
  master: string;
  keys: Record<string, string>;
  done: string[];
  firms: { id: number; account: string; owner: string; tender: string; firm: string; strategy: string }[];
  orders: ShowcaseOrder[];
  evm: EvmProof | null;
};

export type ShowcaseView = {
  enabled: true;
  network: "testnet";
  explorer: string;
  status: "waiting-funds" | "setting-up" | "running" | "error";
  message: string;
  master: string;
  balance: number | null;
  need: number;
  contracts: { intents: string; usdc: string; wnear: string; tender: string } | null;
  firms: { id: number; name: string; account: string }[];
  orders: ShowcaseOrder[];
  evm: EvmProof | null;
  evmError: string | null;
};

export function startShowcase(opts: { master: string; key: string; log: (s: string) => void }): { view(): ShowcaseView } {
  const { master, log } = opts;
  const provider = new JsonRpcProvider({ url: RPC });
  const id = (name: string) => `${name}.${master}`;
  const I = id("intents"), T = id("tender"), U = id("usdc"), W = id("wnear");
  const st: State = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : { master, keys: {}, done: [], firms: [], orders: [], evm: null };
  if (st.master !== master) throw new Error(`${FILE} belongs to ${st.master}, not ${master}`);
  const save = () => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(`${FILE}.tmp`, JSON.stringify(st, null, 1), { mode: 0o600 });
    renameSync(`${FILE}.tmp`, FILE);
  };
  const v = { status: "setting-up" as ShowcaseView["status"], message: "starting", balance: null as number | null, evmError: null as string | null };
  const root = serialize(account(master, provider, opts.key as any));
  const accts = new Map<string, Account>();
  const acct = (a: string) => accts.get(a) ?? (accts.set(a, serialize(account(a, provider, st.keys[a] as any))), accts.get(a)!);
  const exists = (a: string) => provider.query({ request_type: "view_account", account_id: a, finality: "final" } as any).then((r: any) => r, () => null);
  const balance = async () => {
    const r: any = await exists(master);
    v.balance = r ? Number(BigInt(r.amount) / 10n ** 21n) / 1000 : 0;
    return v.balance;
  };

  async function step(name: string, fn: () => Promise<void>) {
    if (st.done.includes(name)) return;
    v.message = `setup: ${name}`;
    await fn();
    st.done.push(name);
    save();
    log(`setup: ${name} done`);
  }

  // Deposit from a wallet into tender through intents.near (the mainnet path): ft_transfer_call, then mt_transfer_call.
  const deposit = async (from: Account, token: string, amount: bigint, msg?: object) => {
    await call(from, token, "ft_transfer_call", { receiver_id: I, amount: amount.toString(), msg: "" }, 1n, TGAS(100));
    return call(from, I, "mt_transfer_call", { receiver_id: T, token_id: `nep141:${token}`, amount: amount.toString(), approval: null, memo: null, msg: msg ? JSON.stringify(msg) : "" }, 1n, TGAS(250));
  };
  const mint = (token: string, to: string, amount: bigint) => call(acct(token), token, "mint", { account_id: to, amount: amount.toString() });

  async function setup() {
    const strategies = await loadStrategies();
    const mid = (await reference("Buy", USDC(100), -1, "NEAR")).mid;
    await step("accounts", async () => {
      for (const [name, near] of ACCOUNTS) {
        const a = id(name);
        if (await exists(a)) {
          if (!st.keys[a]) throw new Error(`${a} exists but its key is not in ${FILE}`);
          continue;
        }
        const kp = KeyPair.fromRandom("ed25519");
        st.keys[a] = kp.toString();
        save(); // the key first: an account created in a crash is still ours
        await root.createAccount({ newAccountId: a, publicKey: kp.getPublicKey(), nearToTransfer: nearToYocto(near as `${number}`) });
      }
    });
    await step("intents", () => deployContract(acct(I), wasm("intents_mainnet"), "new", { config: { wnear_id: "wrap.testnet", fees: { fee: 0, fee_collector: I }, roles: {} } }));
    await step("tokens", async () => {
      for (const t of [U, W]) await deployContract(acct(t), wasm("mock_ft"), "new", {});
    });
    await step("tender", async () => {
      const config = { ...tenderConfig({ admin: T, intents: I, token: `nep141:${U}`, assetToken: `nep141:${W}`, unit: ASSETS.NEAR.unit, mid }), epoch_secs: 3600 };
      await deployContract(acct(T), wasm("tender"), "new", { config });
      await call(acct(T), T, "set_firm_code", { code: Buffer.from(wasm("firm")).toString("base64") }, 0n, TGAS(200));
    });
    await step("firms", async () => {
      for (let i = 0; i < FIRMS.length; i++) {
        if (st.firms[i]) continue;
        const strategy = strategies.find((s) => s.name === FIRMS[i])!;
        const owner = id(`o${i + 1}`);
        const keys = { tender: KeyPair.fromRandom("ed25519"), firm: KeyPair.fromRandom("ed25519") };
        const account = `w${i + 1}.${T}`;
        st.keys[`${account}#tender`] = keys.tender.toString();
        st.keys[`${account}#firm`] = keys.firm.toString();
        save();
        const f = await createFirm({ tenderAcct: acct(T), provider, n: i + 1, owner: acct(owner), strategy, budget: USDC(20), maxPerCall: USDC(25), budgetEpochSecs: 3600, keys });
        st.firms[i] = { id: f.id, account: f.account, owner, tender: f.keys.tender, firm: f.keys.firm, strategy: strategy.name };
        save();
      }
    });
    await step("funding", async () => {
      for (const t of [U, W]) await mint(t, I, 0n);
      for (const a of [id("client"), ...st.firms.flatMap((f) => [f.owner, f.account])]) await call(root, T, "storage_deposit", { account_id: a }, a === id("client") ? STORAGE * 2n : STORAGE);
      await mint(U, id("client"), USDC(1_000_000));
      await mint(W, id("client"), NEAR_(100_000));
      for (const f of st.firms) {
        const owner = acct(f.owner);
        await mint(U, f.owner, USDC(1000));
        await mint(W, f.owner, NEAR_(200));
        await deposit(owner, U, USDC(10));
        await call(owner, T, "deposit_bond", { amount: DEVNET_CONFIG.minBond.toString() }, 1n);
        await deposit(owner, U, USDC(200), { Credit: f.account });
        await deposit(owner, W, NEAR_(40), { Credit: f.account });
        const spec = strategies.find((s) => s.name === f.strategy)?.spec;
        if (spec) await call(owner, T, "set_firm_profile", { firm_id: f.id, profile: JSON.stringify(spec) }, 1n);
      }
    });
  }

  let swarm: Swarm | null = null;
  const handles = async (): Promise<FirmHandle[]> => {
    const strategies = await loadStrategies();
    return st.firms.map((f) => ({
      id: f.id,
      account: f.account,
      owner: acct(f.owner),
      agentTender: serialize(account(f.account, provider, f.tender as any)),
      agentFirm: serialize(account(f.account, provider, f.firm as any)),
      strategy: strategies.find((s) => s.name === f.strategy)!,
    }));
  };

  /** Keep each account's tender storage above STORAGE_LOW: every order and bid is stored. */
  async function topUp() {
    for (const a of [id("client"), ...st.firms.flatMap((f) => [f.owner, f.account])]) {
      if (BigInt(await view(provider, T, "storage_balance_of", { account_id: a })) < STORAGE_LOW) await call(root, T, "storage_deposit", { account_id: a }, STORAGE);
    }
  }

  async function order() {
    await topUp();
    const buy = st.orders.length % 2 === 0;
    const side = buy ? "Buy" : "Sell";
    const mid = (await reference("Buy", USDC(100), -1, "NEAR")).mid;
    const amountIn = buy ? USDC(10 + Math.floor(Math.random() * 20)) : units((5 + Math.floor(Math.random() * 15)) / mid, 24);
    const q = await reference(side, amountIn, -1, "NEAR");
    const posted = await deposit(acct(id("client")), buy ? U : W, amountIn, { PostOrder: { side, amount_in: amountIn.toString(), min_out: q.out.toString(), reference_out: q.out.toString(), commit_secs: 20, reveal_secs: 15 } });
    const oid = posted.events.find((e) => e.event === "order_posted")?.data[0].order_id as number;
    const r = await swarm!.runOrder(oid);
    st.orders.unshift({ id: oid, side, amountIn: amountIn.toString(), out: r.order.status === "Filled" ? String(r.order.out) : null, status: r.order.status, postTx: posted.txHash, settleTx: r.auction.txHash, at: Date.now() });
    st.orders = st.orders.slice(0, 20);
    save();
  }

  /** The first firm's EVM key signs a Base Sepolia USDC transfer through the MPC network, within its owner's policy. */
  async function evmProof() {
    const [f] = await handles();
    await call(f.owner, f.account, "set_signer", { signer: SIGNER });
    await call(f.owner, f.account, "set_evm_policy", {
      policy: { chain_ids: [BASE_SEPOLIA], targets: [{ to: BASE_SEPOLIA_USDC, selectors: ["0xa9059cbb"] }], max_gas: 100_000, max_fee_per_gas: "1000000000", recipients: [RECIPIENT] },
    });
    const evmPath = await view<string>(provider, f.account, "evm_path");
    const address = await deriveEvmAddress(provider, SIGNER, f.account, evmPath);
    const pad = (h: string) => h.replace(/^0x/, "").padStart(64, "0");
    const tx: EvmTx = { chain_id: BASE_SEPOLIA, nonce: 0, max_priority_fee_per_gas: "1000000", max_fee_per_gas: "100000000", gas_limit: 60_000, to: BASE_SEPOLIA_USDC, data: `0xa9059cbb${pad(RECIPIENT)}${pad("1")}` };
    const r = await call<MpcSignature>(f.agentFirm, f.account, "sign_evm", { tx }, 0n, TGAS(100));
    const payloadHash = r.events.find((e) => e.event === "evm_signed")?.data[0].hash as string;
    if (!r.value || !payloadHash) throw new Error(`the signer gave no signature (tx ${r.txHash})`);
    const sig = r.value;
    const rs = Buffer.concat([Buffer.from(sig.big_r.affine_point, "hex").subarray(1), Buffer.from(sig.s.scalar, "hex")]);
    const pub = secp256k1.recoverPublicKey(Buffer.concat([Buffer.from([sig.recovery_id]), rs]), Buffer.from(payloadHash, "hex"), { prehash: false });
    const recovered = "0x" + Buffer.from(keccak_256(secp256k1.Point.fromBytes(pub).toBytes(false).subarray(1)).subarray(12)).toString("hex");
    const raw = signedTxHex(tx, sig);
    st.evm = { firm: f.account, signer: SIGNER, path: evmPath, address, recovered, ok: recovered === address, nearTx: r.txHash, payloadHash, signedTxHash: "0x" + Buffer.from(keccak_256(Buffer.from(raw.slice(2), "hex"))).toString("hex"), at: Date.now() };
    save();
    log(`chain signatures: ${f.account} signed for ${address}, recovered ${recovered} (${st.evm.ok ? "match" : "MISMATCH"})`);
  }

  void (async () => {
    // Set up, waiting for NEAR when the master has too little.
    for (;;) {
      try {
        if (!st.done.includes("funding")) {
          const have = await balance();
          if (!st.done.includes("accounts") && have < SHOWCASE_NEED) {
            v.status = "waiting-funds";
            v.message = `${master} holds ${have.toFixed(2)} testnet NEAR; the setup needs about ${SHOWCASE_NEED}`;
            await sleep(5 * 60_000);
            continue;
          }
          v.status = "setting-up";
          await setup();
        }
        break;
      } catch (e) {
        v.status = "error";
        v.message = `setup: ${(e as Error).message}`;
        log(v.message);
        await sleep(5 * 60_000);
      }
    }
    swarm = new Swarm(provider, T, await handles(), makeLlm(), master, async () => (await reference("Buy", USDC(100), -1, "NEAR")).mid, (s) => log(`swarm ${s.trim()}`));
    v.status = "running";
    v.message = `a house order every ${ORDER_MIN} minutes`;
    log(`running on ${T}: ${v.message}`);
    // Chain Signatures, until it worked once (a few tries, 30 minutes apart).
    void (async () => {
      for (let i = 0; !st.evm && i < 4; i++) {
        try {
          await evmProof();
        } catch (e) {
          v.evmError = (e as Error).message.slice(0, 300);
          log(`chain signatures: ${v.evmError}`);
          await sleep(30 * 60_000);
        }
      }
    })();
    let lastTick = 0;
    for (;;) {
      try {
        await balance();
        if (Date.now() - lastTick > 3600_000) {
          await swarm.tick().catch(() => false);
          lastTick = Date.now();
        }
        await order();
      } catch (e) {
        log(`order: ${(e as Error).message}`);
      }
      await sleep(ORDER_MIN * 60_000);
    }
  })();

  return {
    view: () => ({
      enabled: true,
      network: "testnet",
      explorer: EXPLORER,
      status: v.status,
      message: v.message,
      master,
      balance: v.balance,
      need: SHOWCASE_NEED,
      contracts: st.done.includes("tender") ? { intents: I, usdc: U, wnear: W, tender: T } : null,
      firms: st.firms.map((f) => ({ id: f.id, name: f.strategy, account: f.account })),
      orders: st.orders,
      evm: st.evm,
      evmError: st.evm ? null : v.evmError,
    }),
  };
}
