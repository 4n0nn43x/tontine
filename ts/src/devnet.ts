// A long-running NEAR devnet for the hosted app: a local sandbox node with one tender per market (NEAR, ETH
// and SOL against USDC), the firm contracts, the exact intents.near mainnet code and mock tokens, plus the
// house firms, their owners and a house client.
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { JsonRpcProvider, KeyPair, actions, nearToYocto, type Account } from "near-api-js";
import { account, call, USDC, TGAS } from "./chain.ts";
import { createAccount, createFirm, deployContract, wasm } from "./deploy.ts";
import { loadStrategies, type Strategy } from "./strategy.ts";
import type { FirmHandle } from "./swarm.ts";
import { ASSETS, reference, type AssetSymbol, type Reference } from "./prices.ts";

export const NEAR_ = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
/** `n` whole tokens in base units of a token with `decimals` (6 or more). */
export const units = (n: number, decimals: number) => BigInt(Math.round(n * 1e6)) * 10n ** BigInt(decimals - 6);

/** The mock fungible tokens of the devnet: USDC and the wrapped assets. */
export type TokenKey = "usdc" | "wnear" | "weth" | "wsol";

/** What the faucet and a new demo account get in their trading balance (NEAR Intents), in whole tokens. */
export const FAUCET: Record<TokenKey, number> = { usdc: 100, wnear: 20, weth: 0.04, wsol: 1 };

/** One market: a tender instance trading one asset against USDC. */
export type DevMarket = {
  symbol: AssetSymbol;
  decimals: number;
  unit: bigint;
  color: string;
  tender: Account;
  /** The mock token of the asset and its intents.near token id. */
  token: TokenKey;
  ft: Account;
  assetToken: string;
  firms: FirmHandle[];
  /** The reference when the tender was deployed. */
  start: Reference;
};

const MARKETS: { symbol: AssetSymbol; token: TokenKey; tender: string; color: string }[] = [
  { symbol: "NEAR", token: "wnear", tender: "tender", color: "#5ee6c8" },
  { symbol: "ETH", token: "weth", tender: "tender-eth", color: "#9fb4ff" },
  { symbol: "SOL", token: "wsol", tender: "tender-sol", color: "#d7a6ff" },
];

/** House firms of the ETH and SOL markets: rule or bandit managers, never an LLM. */
export function marketHouse(symbol: AssetSymbol): Strategy[] {
  const firms: Record<string, [string, "rule" | "bandit", number, string][]> = {
    ETH: [
      ["Ether Forge", "rule", 6, "Starts 6 bp from the ETH mid and retunes its spread from its results."],
      ["Gaslight & Co", "bandit", 10, "A UCB1 bandit picks its ETH spread from the edge each one earned."],
      ["Blob Brothers", "rule", 14, "Wider ETH quotes, retuned by the rule; fills when the others pass."],
    ],
    SOL: [
      ["Sunspot Labs", "rule", 6, "Starts 6 bp from the SOL mid and retunes its spread from its results."],
      ["Lamport Lane", "bandit", 10, "A UCB1 bandit picks its SOL spread from the edge each one earned."],
      ["Solstice Fund", "rule", 14, "Wider SOL quotes, retuned by the rule; fills when the others pass."],
    ],
  };
  return (firms[symbol] ?? []).map(([name, managed, spreadBps, description]) => ({
    name,
    spec: { name, description, skills: [`${symbol}/USDC`] },
    author: "tontine (house)",
    house: true,
    managed,
    params: { spreadBps, targetAssetShare: 0.3, skewBps: 10 },
  }));
}

export const DEVNET_CONFIG = {
  dividendBps: 3000,
  liquidationFeeBps: 200,
  minBond: USDC(5),
  /** Smallest slash for an unrevealed order bid; otherwise 1% of the order. */
  slash: USDC(1),
  noRevealSlashBps: 100,
  /** Cash floor: a firm whose stable treasury stays under it for 3 epochs is liquidated. */
  floor: USDC(40),
  epochsBeforeLiquidation: 3,
  epochSecs: Number(process.env.EPOCH_SECS ?? 30),
  liquidationPhaseSecs: 6,
  orderFeeBps: 2,
  tradeFeeBps: 50,
  keeperReward: USDC(0.02),
  minBidders: 2,
  minOrder: USDC(1),
  maxMoveBps: 300,
  /** Tontine's share of a fill's gain over the client's minimum, and of the shares of each launched firm. */
  surplusBps: 3000,
  launchShares: 2,
};

export type Devnet = {
  sandbox: Sandbox;
  provider: JsonRpcProvider;
  rpcUrl: string;
  root: Account;
  /** The NEAR market's tender, its wNEAR token and house firms (the first market). */
  tender: Account;
  usdc: Account;
  wnear: Account;
  intents: string;
  /** intents.near token ids of the stable token and the NEAR market's asset. */
  token: string;
  assetToken: string;
  inference: string;
  houseClient: Account;
  /** Pays the gas of signed intents (`/api/relay`), new accounts' tender storage and the payout keeper's calls. */
  relayer: Account;
  firms: FirmHandle[];
  strategies: Strategy[];
  /** Every market, NEAR first. */
  markets: DevMarket[];
  /** Deposit from `from`'s wallet into a tender (NEAR's by default), with an optional tender message (two steps, mainnet path). */
  deposit(from: Account, amount: bigint, msg?: object, t?: TokenKey, tender?: string): Promise<any>;
  /** Create a visitor account controlled by a key the visitor generated in their browser. */
  createVisitor(publicKey: string): Promise<string>;
  mint(accountId: string, amount: bigint, t?: TokenKey): Promise<void>;
  /** Credit test tokens to an account inside NEAR Intents (its trading balance), e.g. a simulated deposit to a wallet's implicit account (`0x...` or 64 hex). */
  credit(accountId: string, amount: bigint, t?: TokenKey): Promise<void>;
  /** The faucet: FAUCET of every token, into the trading balance. */
  drip(accountId: string): Promise<void>;
  /** Root tops the relayer back up to 200 NEAR when it has under 50 available; returns what it sent (0n: nothing). */
  fundRelayer(): Promise<bigint>;
};

/** One transaction at a time per account: concurrent auctions share firm keys, and nonces must not race. */
export function serialize(acct: Account): Account {
  const send = acct.signAndSendTransaction.bind(acct);
  let queue: Promise<unknown> = Promise.resolve();
  acct.signAndSendTransaction = ((args: Parameters<Account["signAndSendTransaction"]>[0]) => {
    const run = queue.then(() => send(args));
    queue = run.catch(() => {});
    return run;
  }) as Account["signAndSendTransaction"];
  return acct;
}

export async function startDevnet(log: (s: string) => void = console.log): Promise<Devnet> {
  const rpcPort = Number(process.env.SANDBOX_RPC_PORT ?? 3030);
  // 2.13.4 runs the protocol mainnet runs today (86): what deploys here deploys there.
  // neard's default caches (512 MB of state, 128 MB of flat state, 500 MB of trie, 50 MB for views) fill up
  // under the swarm's load until the container's memory limit kills the node (OOM on the VPS, 2026-11-01).
  // The devnet's state is under 100 MB: small caches cost nothing.
  const store = { col_state_cache_size: 64 << 20, col_flat_state_cache_size: 32 << 20, trie_cache: { default_max_bytes: 64 << 20 }, view_trie_cache: { default_max_bytes: 16 << 20 } };
  const sandbox = await Sandbox.start({ version: process.env.SANDBOX_VERSION ?? "2.13.4", config: { rpcPort, additionalConfig: { store } } });
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  log(`devnet node at ${sandbox.rpcUrl}`);

  // The sandbox root key is public knowledge: replace it before anything else is exposed.
  const rootKey = KeyPair.fromRandom("ed25519");
  const genesisRoot = account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as any);
  await genesisRoot.signAndSendTransaction({
    receiverId: DEFAULT_ACCOUNT_ID,
    actions: [actions.addFullAccessKey(rootKey.getPublicKey()), actions.deleteKey(KeyPair.fromString(DEFAULT_PRIVATE_KEY as any).getPublicKey())],
    throwOnFailure: true,
  });
  const root = serialize(account(DEFAULT_ACCOUNT_ID, provider, rootKey));

  const mk = async (name: string, near: string) => {
    const a = await createAccount(root, `${name}.${DEFAULT_ACCOUNT_ID}`, near, provider);
    return serialize(a.acct);
  };
  const usdc = await mk("usdc", "20");
  const fts = new Map<TokenKey, Account>([["usdc", usdc]]);
  for (const m of MARKETS) fts.set(m.token, await mk(m.token, "20"));
  const tenders = new Map<AssetSymbol, Account>();
  for (const m of MARKETS) tenders.set(m.symbol, await mk(m.tender, "80"));
  const inferenceAcct = await mk("inference", "5");
  const houseClient = await mk("client", "40");
  const relayer = await mk("relayer", "200");
  const intentsAcct = await mk("intents", "100");
  const strategies = await loadStrategies();
  // The NEAR market runs the strategies in strategies/; ETH and SOL run their own house firms.
  const houseOf = (s: AssetSymbol) => (s === "NEAR" ? strategies : marketHouse(s));
  const owners = new Map<AssetSymbol, Account[]>();
  for (const m of MARKETS) {
    const prefix = m.symbol === "NEAR" ? "o" : `o${m.symbol.toLowerCase()}`;
    const list: Account[] = [];
    for (let i = 0; i < houseOf(m.symbol).length; i++) list.push(await mk(`${prefix}${i + 1}`, "30"));
    owners.set(m.symbol, list);
  }

  const I = intentsAcct.accountId;
  const token = `nep141:${usdc.accountId}`;
  await deployContract(intentsAcct, wasm("intents_mainnet"), "new", {
    config: { wnear_id: `wrap.${DEFAULT_ACCOUNT_ID}`, fees: { fee: 0, fee_collector: I }, roles: {} },
  });
  // Mock NEP-141 tokens: USDC (6 decimals), wNEAR (24), wETH (18) and wSOL (9).
  for (const ft of fts.values()) await deployContract(ft, wasm("mock_ft"), "new", {});

  const markets: DevMarket[] = [];
  for (const def of MARKETS) {
    const tender = tenders.get(def.symbol)!;
    const T = tender.accountId;
    const ft = fts.get(def.token)!;
    const assetToken = `nep141:${ft.accountId}`;
    const { decimals, unit } = ASSETS[def.symbol];
    // The real price to start from: the market mid, or the replay when offline.
    const start = await reference("Buy", USDC(100), -1, def.symbol);
    await deployContract(tender, wasm("tender"), "new", {
      config: {
        admin: T,
        payment: { Intents: { contract: I, token_id: token } },
        asset: { Intents: { contract: I, token_id: assetToken } },
        asset_unit: unit.toString(),
        initial_price: BigInt(Math.round(start.mid * 1e6)).toString(),
        dividend_bps: DEVNET_CONFIG.dividendBps,
        liquidation_fee_bps: DEVNET_CONFIG.liquidationFeeBps,
        min_bond: DEVNET_CONFIG.minBond.toString(),
        slash: DEVNET_CONFIG.slash.toString(),
        treasury_floor: DEVNET_CONFIG.floor.toString(),
        epochs_before_liquidation: DEVNET_CONFIG.epochsBeforeLiquidation,
        epoch_secs: DEVNET_CONFIG.epochSecs,
        liquidation_commit_secs: DEVNET_CONFIG.liquidationPhaseSecs,
        liquidation_reveal_secs: DEVNET_CONFIG.liquidationPhaseSecs,
        order_fee_bps: DEVNET_CONFIG.orderFeeBps,
        trade_fee_bps: DEVNET_CONFIG.tradeFeeBps,
        keeper_reward: DEVNET_CONFIG.keeperReward.toString(),
        no_reveal_slash_bps: DEVNET_CONFIG.noRevealSlashBps,
        min_bidders: DEVNET_CONFIG.minBidders,
        min_order: DEVNET_CONFIG.minOrder.toString(),
        max_move_bps: DEVNET_CONFIG.maxMoveBps,
        surplus_bps: DEVNET_CONFIG.surplusBps,
        launch_shares: DEVNET_CONFIG.launchShares,
      },
    });
    // The code `create_firm` deploys when anyone launches a firm.
    await call(tender, T, "set_firm_code", { code: Buffer.from(wasm("firm")).toString("base64") }, 0n, TGAS(200));
    log(`market ${def.symbol}/USDC: tender=${T}, ${ft.accountId} (mock), ${def.symbol} ${start.mid.toFixed(3)} USD (${start.source})`);

    const firms: FirmHandle[] = [];
    const house = houseOf(def.symbol);
    const own = owners.get(def.symbol)!;
    for (let i = 0; i < house.length; i++) {
      const f = await createFirm({ tenderAcct: tender, provider, n: i + 1, owner: own[i], strategy: house[i], budget: USDC(20), maxPerCall: USDC(25), budgetEpochSecs: 3600 });
      serialize(f.agentTender);
      serialize(f.agentFirm);
      firms.push(f);
    }
    markets.push({ symbol: def.symbol, decimals, unit, color: def.color, tender, token: def.token, ft, assetToken, firms, start });
  }
  const near = markets[0];
  log(`contracts: intents=${I} (mainnet code), usdc (mock), ${markets.map((m) => m.tender.accountId).join(", ")}`);

  const mint = async (accountId: string, amount: bigint, t: TokenKey = "usdc") => {
    const ft = fts.get(t)!;
    await call(ft, ft.accountId, "mint", { account_id: accountId, amount: amount.toString() });
  };
  const deposit = async (from: Account, amount: bigint, msg?: object, t: TokenKey = "usdc", tender = near.tender.accountId) => {
    const ft = fts.get(t)!;
    await call(from, ft.accountId, "ft_transfer_call", { receiver_id: I, amount: amount.toString(), msg: "" }, 1n, TGAS(100));
    return call(from, I, "mt_transfer_call", { receiver_id: tender, token_id: `nep141:${ft.accountId}`, amount: amount.toString(), approval: null, memo: null, msg: msg ? JSON.stringify(msg) : "" }, 1n, TGAS(250));
  };
  // Each tender keeps its own storage deposits.
  const storage = (payer: Account, forId: string, tenders = markets) =>
    Promise.all(tenders.map((m) => call(payer, m.tender.accountId, "storage_deposit", { account_id: forId }, nearToYocto("0.5"))));

  for (const t of fts.keys()) await mint(I, 0n, t);
  await storage(root, houseClient.accountId);
  await mint(houseClient.accountId, USDC(1_000_000));
  for (const m of markets) {
    const T = m.tender.accountId;
    const worth = (usd: number) => units(usd / m.start.mid, m.decimals);
    const nearMarket = m.symbol === "NEAR";
    await mint(houseClient.accountId, nearMarket ? NEAR_(200_000) : worth(500_000), m.token);
    for (const f of m.firms) {
      await storage(root, f.owner.accountId, [m]);
      await storage(root, f.account, [m]);
    }
    for (const f of m.firms) {
      await mint(f.owner.accountId, USDC(2000));
      await mint(f.owner.accountId, nearMarket ? NEAR_(500) : worth(500), m.token);
      await deposit(f.owner, USDC(30), undefined, "usdc", T);
      await call(f.owner, T, "deposit_bond", { amount: USDC(10).toString() }, 1n);
      // Gambler Inc starts with 60 USDC of cash (the floor is 40) and spends it on NEAR: it will be
      // illiquid, liquidated and bought. The others hold 400 USDC and 60 NEAR, or 150 USD of ETH or SOL.
      const gambler = f.strategy.name === "Gambler Inc";
      await deposit(f.owner, gambler ? USDC(60) : USDC(400), { Credit: f.account }, "usdc", T);
      await deposit(f.owner, !nearMarket ? worth(150) : gambler ? NEAR_(2) : NEAR_(60), { Credit: f.account }, m.token, T);
      if (gambler) await call(f.owner, T, "set_policy", { firm_id: f.id, policy: { max_asset_bps: 10000, band_bps: 1000, paused: false } }, 1n);
    }
    // Each owner publishes its firm's spec on chain (name, description, skills, model).
    for (const f of m.firms) if (f.strategy.spec) await call(f.owner, T, "set_firm_profile", { firm_id: f.id, profile: JSON.stringify(f.strategy.spec) }, 1n);
    // Owners sell part of their firm so visitors can invest and receive dividends.
    for (const f of m.firms) await call(f.owner, T, "list_shares", { firm_id: f.id, amount: 40, price_per_share: USDC(0.4).toString() }, 1n);
    log(`${m.symbol}: ${m.firms.length} house firms funded and bonded, 40 shares each for sale`);
  }

  const decimalsOf = (t: TokenKey) => (t === "usdc" ? 6 : markets.find((m) => m.token === t)!.decimals);
  // The token mints to itself, then deposits into intents.near for `accountId` (deposit msg = receiver id).
  const credit = async (accountId: string, amount: bigint, t: TokenKey = "usdc") => {
    const ft = fts.get(t)!;
    await mint(ft.accountId, amount, t);
    await call(ft, ft.accountId, "ft_transfer_call", { receiver_id: I, amount: amount.toString(), msg: accountId }, 1n, TGAS(100));
  };
  const drip = async (id: string) => {
    await Promise.all([...fts.keys()].map((t) => credit(id, units(FAUCET[t], decimalsOf(t)), t)));
  };
  let visitors = 0;
  const createVisitor = async (publicKey: string) => {
    const id = `v${Date.now().toString(36)}${(visitors++).toString(36)}.${DEFAULT_ACCOUNT_ID}`;
    await root.createAccount({ newAccountId: id, publicKey, nearToTransfer: nearToYocto("5") }); // enough to launch a firm (3 NEAR)
    await drip(id);
    // Registered with every token at 0, so a withdrawal from NEAR Intents to the wallet (ft_withdraw) lands.
    await Promise.all([...fts.keys()].map((t) => mint(id, 0n, t)));
    await storage(root, id);
    return id;
  };
  const fundRelayer = async () => {
    const have = await relayer.getBalance();
    if (have >= NEAR_(50)) return 0n;
    await root.transfer({ receiverId: relayer.accountId, amount: NEAR_(200) - have });
    return NEAR_(200) - have;
  };

  return {
    sandbox,
    provider,
    rpcUrl: sandbox.rpcUrl,
    root,
    tender: near.tender,
    usdc,
    wnear: near.ft,
    intents: I,
    token,
    assetToken: near.assetToken,
    inference: inferenceAcct.accountId,
    houseClient,
    relayer,
    firms: near.firms,
    strategies,
    markets,
    deposit,
    createVisitor,
    mint,
    credit,
    drip,
    fundRelayer,
  };
}
