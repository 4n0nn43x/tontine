// The testnet showcase, next to the devnet the site plays on: the whole system on NEAR testnet, a public chain
// anyone can check on testnet.nearblocks.io, run by the server at a pace the free RPCs allow (a few requests a
// second). Under the master account (TESTNET_ACCOUNT, TESTNET_KEY): our copy of the intents.near mainnet code
// (NEAR Intents is not deployed on testnet), mock USDC, wNEAR, wETH and wSOL (only the token account mints), the
// three tenders with the devnet's house firms and managers, and a house client whose order, every
// SHOWCASE_ORDER_MIN minutes on the next market, the same swarm auctions. Once each: a real Chain Signatures
// proof (v1.signer-prod.testnet signs a Base Sepolia transaction for a firm, within its owner's policy), and one
// order relayed from each wallet standard (EVM, Tron, Solana, Stellar, TON, passkey), verified by intents.near.
//
// The setup runs step by step and saves after each one (TESTNET_DIR/testnet.json, with the keys of the accounts
// it creates, saved before each account exists): a start that runs out of NEAR or dies resumes where it stopped.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { JsonRpcProvider, KeyPair, nearToYocto, type Account } from "near-api-js";
import { account, call, sleep, view, TGAS, USDC } from "./chain.ts";
import { createFirm, deployContract, wasm } from "./deploy.ts";
import { DEVNET_CONFIG, marketHouse, NEAR_, serialize, tenderConfig, units } from "./devnet.ts";
import { deriveEvmAddress, signedTxHex, type EvmTx, type MpcSignature } from "./evm.ts";
import { makeLlm } from "./llm.ts";
import { ASSETS, reference, type AssetSymbol } from "./prices.ts";
import { accountOf, checkRelay, orderPayload, signAs, STANDARDS, submitRelay, type Standard } from "./relay.ts";
import { loadStrategies, type Strategy } from "./strategy.ts";
import { Swarm, type FirmHandle } from "./swarm.ts";

const RPC = process.env.TESTNET_RPC ?? "https://rpc.testnet.fastnear.com";
const DIR = path.resolve(process.env.TESTNET_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "keys"));
const FILE = path.join(DIR, "testnet.json");
const ORDER_MIN = Number(process.env.SHOWCASE_ORDER_MIN ?? 5);
const MANAGER_SECS = Number(process.env.MANAGER_SECS ?? 180);
const SIGNER = "v1.signer-prod.testnet";
/** Requests a second the showcase sends the RPC: the free FastNEAR one allows about 8 (measured, 2026-11-01). */
const RPS = Number(process.env.SHOWCASE_RPS ?? 4);
const EXPLORER = "https://testnet.nearblocks.io";
const MARKETS: { symbol: AssetSymbol; token: string; tender: string; owner: string }[] = [
  { symbol: "NEAR", token: "wnear", tender: "tender", owner: "o" },
  { symbol: "ETH", token: "weth", tender: "tender-eth", owner: "oeth" },
  { symbol: "SOL", token: "wsol", tender: "tender-sol", owner: "osol" },
];
/** Storage of a tender's code (4.1 NEAR) and of the firm code it keeps (2), plus state. */
const TENDER_NEAR = 7;
/** What a tender sends each house firm it creates (createFirm): the firm contract's storage and gas. */
const FIRM_NEAR = 3;
/** What the setup needs on the master account: accounts, tenders, firms, storage deposits and gas. */
export const SHOWCASE_NEED = 70;
/** Tender storage (NEP-145) each house account keeps, topped up from the master under STORAGE_LOW. */
const STORAGE = nearToYocto("0.2");
const STORAGE_LOW = nearToYocto("0.05");
// Base Sepolia (84532) USDC; the transfer goes to a burn address the owner lists. Signed, not broadcast: the
// firm's address holds no Base Sepolia ETH for gas.
const BASE_SEPOLIA = 84532;
const BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const RECIPIENT = "0x000000000000000000000000000000000000dead";

type SavedFirm = { id: number; account: string; owner: string; tender: string; firm: string; strategy: string };
export type ShowcaseOrder = { symbol: string; id: number; side: "Buy" | "Sell"; amountIn: string; out: string | null; status: string; postTx: string; settleTx: string; at: number };
export type EvmProof = { firm: string; signer: string; path: string; address: string; recovered: string; ok: boolean; nearTx: string; payloadHash: string; signedTxHash: string; at: number };
export type WalletProof = { standard: Standard; account: string; orderId: number; relayTx: string; settleTx: string; status: string; out: string | null; at: number };
type State = {
  master: string;
  keys: Record<string, string>;
  done: string[];
  markets: Record<string, { firms: SavedFirm[] }>;
  orders: ShowcaseOrder[];
  evm: EvmProof | null;
  wallets: WalletProof[];
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
  contracts: { intents: string; tokens: string[] } | null;
  markets: { symbol: string; tender: string; firms: { id: number; name: string; account: string }[] }[];
  orders: ShowcaseOrder[];
  evm: EvmProof | null;
  evmError: string | null;
  wallets: WalletProof[];
};

/**
 * A provider for a free public RPC: at most `rps` requests a second through it (every account built on it
 * shares the pace), and a request it refuses for its rate limit (-429) is sent again after a growing wait.
 */
function limited(provider: JsonRpcProvider, rps: number): JsonRpcProvider {
  const send = provider.sendJsonRpc.bind(provider);
  let next = 0;
  (provider as any).sendJsonRpc = async (method: string, params: unknown) => {
    for (let i = 0; ; i++) {
      const now = Date.now();
      const at = Math.max(now, next);
      next = at + 1000 / rps;
      if (at > now) await sleep(at - now);
      try {
        return await send(method as any, params as any);
      } catch (e) {
        if (i >= 6 || !/-429|Rate limits exceeded|Too Many Requests/i.test(String((e as Error).message))) throw e;
        await sleep(1000 * 2 ** i);
      }
    }
  };
  return provider;
}

/** The first version ran the NEAR market alone: its steps and firms become the NEAR market's. */
function migrate(st: any): State {
  if (!st.firms) return { wallets: [], ...st };
  const rename: Record<string, string[]> = {
    tokens: ["token:usdc", "token:wnear"],
    tender: ["tender:NEAR"],
    firms: st.firms.map((_: unknown, i: number) => `firm:NEAR:${i}`),
    funding: ["register:usdc", "register:wnear", "client:NEAR", ...st.firms.map((_: unknown, i: number) => `fund:NEAR:${i}`)],
  };
  return {
    master: st.master,
    keys: st.keys,
    done: st.done.flatMap((d: string) => rename[d] ?? (d === "accounts" ? [] : [d])),
    markets: { NEAR: { firms: st.firms } },
    orders: st.orders.map((o: any) => ({ symbol: "NEAR", ...o })),
    evm: st.evm,
    wallets: [],
  };
}

export function startShowcase(opts: { master: string; key: string; log: (s: string) => void }): { view(): ShowcaseView } {
  const { master, log } = opts;
  const provider = limited(new JsonRpcProvider({ url: RPC }), RPS);
  const id = (name: string) => `${name}.${master}`;
  const I = id("intents"), U = id("usdc");
  const tenderOf = (s: string) => id(MARKETS.find((m) => m.symbol === s)!.tender);
  const tokenOf = (s: string) => id(MARKETS.find((m) => m.symbol === s)!.token);
  const st: State = existsSync(FILE) ? migrate(JSON.parse(readFileSync(FILE, "utf8"))) : { master, keys: {}, done: [], markets: {}, orders: [], evm: null, wallets: [] };
  if (st.master !== master) throw new Error(`${FILE} belongs to ${st.master}, not ${master}`);
  for (const m of MARKETS) st.markets[m.symbol] ??= { firms: [] };
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
  let strategies: Strategy[] = [];
  const houseOf = (s: AssetSymbol) => (s === "NEAR" ? strategies : marketHouse(s));

  async function step(name: string, fn: () => Promise<void>) {
    if (st.done.includes(name)) return;
    v.message = `setup: ${name}`;
    await fn();
    st.done.push(name);
    save();
    log(`setup: ${name} done`);
  }

  // Deposit from a wallet into a tender through intents.near (the mainnet path): ft_transfer_call, then mt_transfer_call.
  const deposit = async (from: Account, token: string, tender: string, amount: bigint, msg?: object) => {
    await call(from, token, "ft_transfer_call", { receiver_id: I, amount: amount.toString(), msg: "" }, 1n, TGAS(100));
    return call(from, I, "mt_transfer_call", { receiver_id: tender, token_id: `nep141:${token}`, amount: amount.toString(), approval: null, memo: null, msg: msg ? JSON.stringify(msg) : "" }, 1n, TGAS(250));
  };
  const mint = (token: string, to: string, amount: bigint) => call(acct(token), token, "mint", { account_id: to, amount: amount.toString() });
  /** Into `to`'s NEAR Intents account: the token mints to itself and deposits for it (deposit msg = receiver). */
  const credit = async (token: string, to: string, amount: bigint) => {
    await mint(token, token, amount);
    await call(acct(token), token, "ft_transfer_call", { receiver_id: I, amount: amount.toString(), msg: to }, 1n, TGAS(100));
  };

  async function setup() {
    strategies = await loadStrategies();
    const accounts: [string, string][] = [
      ["intents", "14"],
      ...["usdc", "wnear", "weth", "wsol"].map((t): [string, string] => [t, "2.4"]),
      ...MARKETS.map((m): [string, string] => [m.tender, String(TENDER_NEAR + FIRM_NEAR * houseOf(m.symbol).length)]),
      ...MARKETS.flatMap((m) => houseOf(m.symbol).map((_, i): [string, string] => [`${m.owner}${i + 1}`, "0.5"])),
      ["client", "1"],
      ["relayer", "3"],
      ["inference", "0.3"],
    ];
    for (const [name, near] of accounts)
      await step(`account:${name}`, async () => {
        const a = id(name);
        if (await exists(a)) {
          if (!st.keys[a]) throw new Error(`${a} exists but its key is not in ${FILE}`);
          return;
        }
        const kp = KeyPair.fromRandom("ed25519");
        st.keys[a] = kp.toString();
        save(); // the key first: an account created in a crash is still ours
        await root.createAccount({ newAccountId: a, publicKey: kp.getPublicKey(), nearToTransfer: nearToYocto(near as `${number}`) });
      });
    await step("intents", () => deployContract(acct(I), wasm("intents_mainnet"), "new", { config: { wnear_id: "wrap.testnet", fees: { fee: 0, fee_collector: I }, roles: {} } }));
    for (const t of ["usdc", "wnear", "weth", "wsol"]) {
      await step(`token:${t}`, () => deployContract(acct(id(t)), wasm("mock_ft"), "new", {}));
      await step(`register:${t}`, async () => void (await mint(id(t), I, 0n)));
    }
    await step("client:usdc", async () => void (await mint(U, id("client"), USDC(1_000_000))));
    for (const m of MARKETS) {
      const T = tenderOf(m.symbol), A = tokenOf(m.symbol), { unit, decimals } = ASSETS[m.symbol];
      const mid = (await reference("Buy", USDC(100), -1, m.symbol)).mid;
      const worth = (usd: number) => units(usd / mid, decimals);
      await step(`tender:${m.symbol}`, async () => {
        const config = { ...tenderConfig({ admin: T, intents: I, token: `nep141:${U}`, assetToken: `nep141:${A}`, unit, mid }), epoch_secs: 3600 };
        await deployContract(acct(T), wasm("tender"), "new", { config });
        await call(acct(T), T, "set_firm_code", { code: Buffer.from(wasm("firm")).toString("base64") }, 0n, TGAS(200));
      });
      const house = houseOf(m.symbol);
      const firms = st.markets[m.symbol].firms;
      for (let i = 0; i < house.length; i++) {
        await step(`firm:${m.symbol}:${i}`, async () => {
          // A tender made for fewer firms (the first showcase ran two) gets what the next one costs: its balance
          // past the storage its code and state lock (1e19 yoctoNEAR a byte).
          const free = async () => {
            const t: any = await exists(T);
            return BigInt(t.amount) - BigInt(t.storage_usage) * 10n ** 19n;
          };
          const want = nearToYocto(String(FIRM_NEAR + 1) as `${number}`);
          const have = await free();
          if (have < want) {
            await root.transfer({ receiverId: T, amount: want - have });
            // The master and the tender may sit on different shards: the credit lands a block or two later, and a
            // firm created before it fails for lack of balance (seen on testnet).
            for (let i = 0; i < 20 && (await free()) < want; i++) await sleep(1000);
          }
          const owner = id(`${m.owner}${i + 1}`);
          const keys = { tender: KeyPair.fromRandom("ed25519"), firm: KeyPair.fromRandom("ed25519") };
          const fa = `w${i + 1}.${T}`;
          st.keys[`${fa}#tender`] = keys.tender.toString();
          st.keys[`${fa}#firm`] = keys.firm.toString();
          save();
          const f = await createFirm({ tenderAcct: acct(T), provider, n: i + 1, owner: acct(owner), strategy: house[i], budget: USDC(20), maxPerCall: USDC(25), budgetEpochSecs: 3600, keys });
          firms[i] = { id: f.id, account: f.account, owner, tender: f.keys.tender, firm: f.keys.firm, strategy: house[i].name };
        });
      }
      await step(`client:${m.symbol}`, async () => {
        await call(root, T, "storage_deposit", { account_id: id("client") }, STORAGE * 2n);
        await mint(A, id("client"), m.symbol === "NEAR" ? NEAR_(100_000) : worth(500_000));
      });
      for (let i = 0; i < firms.length; i++)
        await step(`fund:${m.symbol}:${i}`, async () => {
          const f = firms[i];
          const owner = acct(f.owner);
          for (const a of [f.owner, f.account]) await call(root, T, "storage_deposit", { account_id: a }, STORAGE);
          // Gambler Inc starts with 60 USDC (the floor is 40) and spends it on NEAR: liquidated, then bought.
          const gambler = f.strategy === "Gambler Inc";
          await mint(U, f.owner, USDC(1000));
          await mint(A, f.owner, m.symbol === "NEAR" ? NEAR_(200) : worth(500));
          await deposit(owner, U, T, USDC(10));
          await call(owner, T, "deposit_bond", { amount: DEVNET_CONFIG.minBond.toString() }, 1n);
          await deposit(owner, U, T, gambler ? USDC(60) : USDC(200), { Credit: f.account });
          await deposit(owner, A, T, gambler ? NEAR_(2) : m.symbol === "NEAR" ? NEAR_(40) : worth(150), { Credit: f.account });
          if (gambler) await call(owner, T, "set_policy", { firm_id: f.id, policy: { max_asset_bps: 10000, band_bps: 1000, paused: false } }, 1n);
          const spec = houseOf(m.symbol).find((s) => s.name === f.strategy)?.spec;
          if (spec) await call(owner, T, "set_firm_profile", { firm_id: f.id, profile: JSON.stringify(spec) }, 1n);
        });
    }
  }

  const swarms = new Map<string, Swarm>();
  const handles = (s: AssetSymbol): FirmHandle[] =>
    st.markets[s].firms.map((f) => ({
      id: f.id,
      account: f.account,
      owner: acct(f.owner),
      agentTender: serialize(account(f.account, provider, f.tender as any)),
      agentFirm: serialize(account(f.account, provider, f.firm as any)),
      strategy: houseOf(s).find((x) => x.name === f.strategy)!,
    }));

  /** Keep each house account's tender storage above STORAGE_LOW: every order and bid is stored. */
  async function topUp(s: AssetSymbol) {
    const T = tenderOf(s);
    for (const a of [id("client"), ...st.markets[s].firms.flatMap((f) => [f.owner, f.account])]) {
      if (BigInt(await view(provider, T, "storage_balance_of", { account_id: a })) < STORAGE_LOW) await call(root, T, "storage_deposit", { account_id: a }, STORAGE);
    }
  }

  /**
   * Orders an auction left open (an RPC refusal in the middle of it) are settled once their reveal phase is
   * over, by anyone (here a firm's agent): filled or refunded. Their saved status follows.
   */
  async function settleStale(s: AssetSymbol) {
    const T = tenderOf(s);
    const open = [...st.orders.filter((o) => o.symbol === s), ...(s === "NEAR" ? st.wallets.map((w) => ({ ...w, id: w.orderId })) : [])].filter((o) => o.status === "Open");
    if (!open.length) return;
    const now = BigInt(((await provider.viewBlock({ finality: "final" } as any)) as any).header.timestamp_nanosec);
    for (const o of open) {
      const order = await view(provider, T, "get_order", { order_id: o.id });
      if (order.status === "Open") {
        const a = await view(provider, T, "get_auction", { auction_id: order.auction });
        if (!a.settled && BigInt(a.reveal_end) < now) await call(swarms.get(s)!.firms[0].agentTender, T, "settle", { auction_id: order.auction }).catch(() => null);
      }
      const after = await view(provider, T, "get_order", { order_id: o.id });
      for (const x of [...st.orders.filter((y) => y.symbol === s && y.id === o.id), ...(s === "NEAR" ? st.wallets.filter((w) => w.orderId === o.id) : [])]) {
        x.status = after.status;
        x.out = after.status === "Filled" ? String(after.out) : null;
      }
    }
    save();
  }

  async function order(s: AssetSymbol) {
    await settleStale(s).catch((e) => log(`${s} settle: ${(e as Error).message}`));
    await topUp(s);
    const n = st.orders.filter((o) => o.symbol === s).length;
    const buy = n % 2 === 0;
    const side = buy ? "Buy" : "Sell";
    const mid = (await reference("Buy", USDC(100), -1, s)).mid;
    const amountIn = buy ? USDC(10 + Math.floor(Math.random() * 20)) : units((5 + Math.floor(Math.random() * 15)) / mid, ASSETS[s].decimals);
    const q = await reference(side, amountIn, -1, s);
    const posted = await deposit(acct(id("client")), buy ? U : tokenOf(s), tenderOf(s), amountIn, {
      PostOrder: { side, amount_in: amountIn.toString(), min_out: q.out.toString(), reference_out: q.out.toString(), commit_secs: 20, reveal_secs: 15 },
    });
    const oid = posted.events.find((e) => e.event === "order_posted")?.data[0].order_id as number;
    const r = await swarms.get(s)!.runOrder(oid);
    st.orders.unshift({ symbol: s, id: oid, side, amountIn: amountIn.toString(), out: r.order.status === "Filled" ? String(r.order.out) : null, status: r.order.status, postTx: posted.txHash, settleTx: r.auction.txHash, at: Date.now() });
    st.orders = st.orders.slice(0, 30);
    save();
  }

  /** An epoch tick, then any liquidation auction the house firms can bid in (Gambler Inc's, in time). */
  async function epoch(s: AssetSymbol) {
    const sw = swarms.get(s)!;
    await sw.tick().catch(() => false);
    for (const f of await view<any[]>(provider, tenderOf(s), "get_firms"))
      if (f.status === "Liquidating" && f.liquidation_auction !== null) await sw.runLiquidation(f.id).catch((e) => log(`${s} liquidation ${f.id}: ${(e as Error).message}`));
  }

  /** The first NEAR firm's EVM key signs a Base Sepolia USDC transfer through the MPC network, within its owner's policy. */
  async function evmProof() {
    const [f] = handles("NEAR");
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

  /**
   * One NEAR order from each wallet standard: a fresh key's implicit account gets 10 USDC in NEAR Intents, signs
   * a transfer intent to the tender in its wallet's format, the relayer submits it with execute_intents, the
   * swarm auctions it, and the payout keeper's withdraw_to_intents pays the fill back to its NEAR Intents account.
   */
  async function walletProof(standard: Standard) {
    const T = tenderOf("NEAR");
    const curve = standard === "erc191" || standard === "tip191" ? secp256k1 : standard === "webauthn" ? p256 : ed25519;
    const key = curve.utils.randomSecretKey();
    const who = accountOf(standard, key);
    await credit(U, who, USDC(10));
    const ref = (await reference("Buy", USDC(10), -1, "NEAR")).out;
    const text = orderPayload({
      signer: who,
      intents: I,
      tender: T,
      token: `nep141:${U}`,
      amount: USDC(10),
      order: { side: "Buy", amount_in: USDC(10).toString(), min_out: ref.toString(), reference_out: ref.toString(), commit_secs: 20, reveal_secs: 15 },
      salt: await view(provider, I, "current_salt"),
      deadlineMs: Date.now() + 5 * 60_000,
    });
    const signed = signAs(standard, text, key, { domain: "tontine.fyra.fun" });
    const relayer = acct(id("relayer"));
    const posted = await submitRelay(relayer, provider, I, signed, checkRelay(signed, { intents: I, tenders: { [T]: [`nep141:${U}`, `nep141:${tokenOf("NEAR")}`] } }));
    const r = await swarms.get("NEAR")!.runOrder(posted.orderId);
    if (r.order.status === "Filled") await call(relayer, T, "withdraw_to_intents", { account_id: who }, 0n, TGAS(100)).catch(() => null);
    st.wallets.push({ standard, account: who, orderId: posted.orderId, relayTx: posted.txHash, settleTx: r.auction.txHash, status: r.order.status, out: r.order.status === "Filled" ? String(r.order.out) : null, at: Date.now() });
    save();
    log(`wallet ${standard}: order #${posted.orderId} ${r.order.status} (${who})`);
  }

  void (async () => {
    // Set up, waiting for NEAR when the master has too little.
    for (;;) {
      try {
        strategies = await loadStrategies();
        const remaining = MARKETS.some((m) => !st.done.includes(`fund:${m.symbol}:${houseOf(m.symbol).length - 1}`));
        if (remaining) {
          const have = await balance();
          if (have < SHOWCASE_NEED) {
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
    const llm = makeLlm();
    for (const m of MARKETS) {
      const { unit } = ASSETS[m.symbol];
      swarms.set(m.symbol, new Swarm(provider, tenderOf(m.symbol), handles(m.symbol), llm, id("inference"), async () => (await reference("Buy", USDC(100), -1, m.symbol)).mid, (s) => log(`swarm ${m.symbol} ${s.trim()}`), { symbol: m.symbol, unit }));
    }
    v.status = "running";
    v.message = `a house order every ${ORDER_MIN} minutes, on each market in turn`;
    log(`running: ${MARKETS.map((m) => tenderOf(m.symbol)).join(", ")}; ${v.message}`);
    // Once each, in turn (a few tries, 30 minutes apart): Chain Signatures, then one order per wallet standard.
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
    // Managers retune their quotes from their results (Atlas AI with the LLM, the others by rule or bandit).
    void (async () => {
      for (;;) {
        await sleep(MANAGER_SECS * 1000);
        for (const m of MARKETS)
          for (const f of handles(m.symbol).filter((x) => x.strategy.managed)) await swarms.get(m.symbol)!.manage(f).catch((e) => log(`manager ${f.strategy.name}: ${(e as Error).message}`));
      }
    })();
    let turn = 0;
    let lastTick = 0;
    for (;;) {
      try {
        await balance();
        // A standard whose order did not fill (an RPC refusal in its auction) tries again, three times at most.
        const tries = (s: Standard) => st.wallets.filter((w) => w.standard === s).length;
        for (const std of STANDARDS.filter((s) => !st.wallets.some((w) => w.standard === s && w.status === "Filled") && tries(s) < 3 && !st.wallets.some((w) => w.standard === s && w.status === "Open")).slice(0, 1))
          await walletProof(std).catch((e) => log(`wallet ${std}: ${(e as Error).message}`));
        if (Date.now() - lastTick > 3600_000) {
          for (const m of MARKETS) await epoch(m.symbol).catch((e) => log(`${m.symbol} epoch: ${(e as Error).message}`));
          lastTick = Date.now();
        }
        await order(MARKETS[turn++ % MARKETS.length].symbol);
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
      contracts: st.done.includes("intents") ? { intents: I, tokens: ["usdc", "wnear", "weth", "wsol"].filter((t) => st.done.includes(`token:${t}`)).map(id) } : null,
      markets: MARKETS.filter((m) => st.done.includes(`tender:${m.symbol}`)).map((m) => ({ symbol: m.symbol, tender: tenderOf(m.symbol), firms: st.markets[m.symbol].firms.map((f) => ({ id: f.id, name: f.strategy, account: f.account })) })),
      orders: st.orders,
      evm: st.evm,
      evmError: st.evm ? null : v.evmError,
      wallets: st.wallets,
    }),
  };
}
