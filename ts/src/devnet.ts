// A long-running NEAR devnet for the hosted app: a local sandbox node with tender, the firm contracts,
// the exact intents.near mainnet code and a mock USDC, plus the house firms, their owners and a house client.
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { JsonRpcProvider, KeyPair, actions, nearToYocto, type Account } from "near-api-js";
import { account, call, USDC, TGAS } from "./chain.ts";
import { createAccount, createFirm, deployContract, wasm } from "./deploy.ts";
import { loadStrategies, type Strategy } from "./strategy.ts";
import type { FirmHandle } from "./swarm.ts";
import { reference } from "./prices.ts";

export const NEAR_ = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;

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
};

export type Devnet = {
  sandbox: Sandbox;
  provider: JsonRpcProvider;
  rpcUrl: string;
  root: Account;
  tender: Account;
  usdc: Account;
  wnear: Account;
  intents: string;
  /** intents.near token ids of the stable token and the asset. */
  token: string;
  assetToken: string;
  inference: string;
  houseClient: Account;
  firms: FirmHandle[];
  strategies: Strategy[];
  /** Deposit from `from`'s wallet into tender, with an optional tender message (two steps, mainnet path). */
  deposit(from: Account, amount: bigint, msg?: object, t?: "usdc" | "wnear"): Promise<any>;
  /** Create a visitor account controlled by a key the visitor generated in their browser. */
  createVisitor(publicKey: string): Promise<string>;
  mint(accountId: string, amount: bigint, t?: "usdc" | "wnear"): Promise<void>;
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
  const sandbox = await Sandbox.start({ version: process.env.SANDBOX_VERSION ?? "2.13.4", config: { rpcPort } });
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
  const wnear = await mk("wnear", "20");
  const tender = await mk("tender", "80");
  const inferenceAcct = await mk("inference", "5");
  const houseClient = await mk("client", "40");
  const intentsAcct = await mk("intents", "100");
  const strategies = await loadStrategies();
  const owners: Account[] = [];
  for (let i = 0; i < strategies.length; i++) owners.push(await mk(`o${i + 1}`, "30"));

  const I = intentsAcct.accountId;
  const T = tender.accountId;
  const token = `nep141:${usdc.accountId}`;
  const assetToken = `nep141:${wnear.accountId}`;
  await deployContract(intentsAcct, wasm("intents_mainnet"), "new", {
    config: { wnear_id: `wrap.${DEFAULT_ACCOUNT_ID}`, fees: { fee: 0, fee_collector: I }, roles: {} },
  });
  // Two mock NEP-141 tokens: USDC (6 decimals) and wNEAR (24 decimals by convention).
  await deployContract(usdc, wasm("mock_ft"), "new", {});
  await deployContract(wnear, wasm("mock_ft"), "new", {});
  // The real NEAR price to start from: a NEAR Intents 1Click quote, or the replay when offline.
  const start = await reference("Buy", USDC(100));
  await deployContract(tender, wasm("tender"), "new", {
    config: {
      admin: T,
      payment: { Intents: { contract: I, token_id: token } },
      asset: { Intents: { contract: I, token_id: assetToken } },
      asset_unit: (10n ** 24n).toString(),
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
    },
  });
  // The code `create_firm` deploys when anyone launches a firm.
  await call(tender, T, "set_firm_code", { code: Buffer.from(wasm("firm")).toString("base64") }, 0n, TGAS(200));
  log(`contracts: tender=${T} intents=${I} (mainnet code) usdc, wnear (mocks), NEAR ${start.mid.toFixed(3)} USD (${start.source})`);

  const firms: FirmHandle[] = [];
  for (let i = 0; i < strategies.length; i++) {
    const f = await createFirm({ tenderAcct: tender, provider, n: i + 1, owner: owners[i], strategy: strategies[i], budget: USDC(20), maxPerCall: USDC(25), budgetEpochSecs: 3600 });
    serialize(f.agentTender);
    serialize(f.agentFirm);
    firms.push(f);
  }

  const ft = (t: "usdc" | "wnear") => (t === "usdc" ? usdc : wnear);
  const mint = async (accountId: string, amount: bigint, t: "usdc" | "wnear" = "usdc") => {
    await call(ft(t), ft(t).accountId, "mint", { account_id: accountId, amount: amount.toString() });
  };
  const deposit = async (from: Account, amount: bigint, msg?: object, t: "usdc" | "wnear" = "usdc") => {
    await call(from, ft(t).accountId, "ft_transfer_call", { receiver_id: I, amount: amount.toString(), msg: "" }, 1n, TGAS(100));
    return call(from, I, "mt_transfer_call", { receiver_id: T, token_id: t === "usdc" ? token : assetToken, amount: amount.toString(), approval: null, memo: null, msg: msg ? JSON.stringify(msg) : "" }, 1n, TGAS(250));
  };
  const storage = (payer: Account, forId: string) => call(payer, T, "storage_deposit", { account_id: forId }, nearToYocto("0.5"));

  await mint(I, 0n);
  await mint(I, 0n, "wnear");
  for (const a of [houseClient, ...owners]) await storage(root, a.accountId);
  for (const f of firms) await storage(root, f.account);
  await mint(houseClient.accountId, USDC(1_000_000));
  await mint(houseClient.accountId, NEAR_(200_000), "wnear");
  for (let i = 0; i < firms.length; i++) {
    const f = firms[i];
    await mint(f.owner.accountId, USDC(2000));
    await mint(f.owner.accountId, NEAR_(500), "wnear");
    await deposit(f.owner, USDC(30));
    await call(f.owner, T, "deposit_bond", { amount: USDC(10).toString() }, 1n);
    // Gambler Inc starts with 60 USDC of cash (the floor is 40) and spends it on NEAR: it will be
    // illiquid, liquidated and bought. The others hold 400 USDC and 60 NEAR.
    const gambler = f.strategy.name === "Gambler Inc";
    await deposit(f.owner, gambler ? USDC(60) : USDC(400), { Credit: f.account });
    await deposit(f.owner, gambler ? NEAR_(2) : NEAR_(60), { Credit: f.account }, "wnear");
    if (gambler) await call(f.owner, T, "set_policy", { firm_id: f.id, policy: { max_asset_bps: 10000, band_bps: 1000, paused: false } }, 1n);
  }
  // Each owner publishes its firm's spec on chain (name, description, skills, model).
  for (const f of firms) if (f.strategy.spec) await call(f.owner, T, "set_firm_profile", { firm_id: f.id, profile: JSON.stringify(f.strategy.spec) }, 1n);
  // Owners sell part of their firm so visitors can invest and receive dividends.
  for (const f of firms) await call(f.owner, T, "list_shares", { firm_id: f.id, amount: 40, price_per_share: USDC(0.4).toString() }, 1n);
  log(`${firms.length} house firms funded and bonded, 40 shares each for sale`);

  let visitors = 0;
  const createVisitor = async (publicKey: string) => {
    const id = `v${Date.now().toString(36)}${(visitors++).toString(36)}.${DEFAULT_ACCOUNT_ID}`;
    await root.createAccount({ newAccountId: id, publicKey, nearToTransfer: nearToYocto("5") }); // enough to launch a firm (3 NEAR)
    await mint(id, USDC(100));
    await mint(id, NEAR_(20), "wnear");
    await storage(root, id);
    return id;
  };

  return {
    sandbox,
    provider,
    rpcUrl: sandbox.rpcUrl,
    root,
    tender,
    usdc,
    wnear,
    intents: I,
    token,
    assetToken,
    inference: inferenceAcct.accountId,
    houseClient,
    firms,
    strategies,
    deposit,
    createVisitor,
    mint,
  };
}
