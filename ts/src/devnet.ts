// A long-running NEAR devnet for the hosted app: a local sandbox node with tender, the firm contracts,
// the exact intents.near mainnet code and a mock USDC, plus the house firms, their owners and a house client.
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { JsonRpcProvider, KeyPair, actions, nearToYocto, type Account } from "near-api-js";
import { account, call, USDC, TGAS } from "./chain.ts";
import { createAccount, createFirm, deployContract, wasm } from "./deploy.ts";
import { loadStrategies, type Strategy } from "./strategy.ts";
import type { FirmHandle } from "./swarm.ts";

export const DEVNET_CONFIG = {
  dividendBps: 3000,
  liquidationFeeBps: 200,
  minBond: USDC(5),
  slash: USDC(5),
  floor: USDC(2),
  epochsBeforeLiquidation: 3,
  epochSecs: Number(process.env.EPOCH_SECS ?? 30),
  liquidationPhaseSecs: 6,
  jobFeeBps: 100,
  tradeFeeBps: 50,
  keeperReward: USDC(0.02),
  disputeBond: USDC(1),
  evalStake: USDC(1),
  panelSize: 3,
  voteSecs: 8,
};

export type Devnet = {
  sandbox: Sandbox;
  provider: JsonRpcProvider;
  rpcUrl: string;
  root: Account;
  tender: Account;
  usdc: Account;
  intents: string;
  token: string;
  judge: Account;
  inference: string;
  houseClient: Account;
  firms: FirmHandle[];
  strategies: Strategy[];
  /** Deposit USDC from `from`'s wallet into tender, with an optional tender message (two steps, mainnet path). */
  deposit(from: Account, amount: bigint, msg?: object): Promise<unknown>;
  /** Create a visitor account controlled by a key the visitor generated in their browser. */
  createVisitor(publicKey: string): Promise<string>;
  mint(accountId: string, amount: bigint): Promise<void>;
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
  const tender = await mk("tender", "80");
  const judge = await mk("judge", "20");
  const inferenceAcct = await mk("inference", "5");
  const houseClient = await mk("client", "40");
  const intentsAcct = await mk("intents", "100");
  const strategies = await loadStrategies();
  const owners: Account[] = [];
  for (let i = 0; i < strategies.length; i++) owners.push(await mk(`o${i + 1}`, "30"));

  const I = intentsAcct.accountId;
  const T = tender.accountId;
  const token = `nep141:${usdc.accountId}`;
  await deployContract(intentsAcct, wasm("intents_mainnet"), "new", {
    config: { wnear_id: `wrap.${DEFAULT_ACCOUNT_ID}`, fees: { fee: 0, fee_collector: I }, roles: {} },
  });
  await deployContract(usdc, wasm("mock_ft"), "new", {});
  await deployContract(tender, wasm("tender"), "new", {
    config: {
      admin: T,
      judge: judge.accountId,
      payment: { Intents: { contract: I, token_id: token } },
      dividend_bps: DEVNET_CONFIG.dividendBps,
      liquidation_fee_bps: DEVNET_CONFIG.liquidationFeeBps,
      min_bond: DEVNET_CONFIG.minBond.toString(),
      slash: DEVNET_CONFIG.slash.toString(),
      treasury_floor: DEVNET_CONFIG.floor.toString(),
      epochs_before_liquidation: DEVNET_CONFIG.epochsBeforeLiquidation,
      epoch_secs: DEVNET_CONFIG.epochSecs,
      liquidation_commit_secs: DEVNET_CONFIG.liquidationPhaseSecs,
      liquidation_reveal_secs: DEVNET_CONFIG.liquidationPhaseSecs,
      job_fee_bps: DEVNET_CONFIG.jobFeeBps,
      trade_fee_bps: DEVNET_CONFIG.tradeFeeBps,
      keeper_reward: DEVNET_CONFIG.keeperReward.toString(),
      dispute_bond: DEVNET_CONFIG.disputeBond.toString(),
      eval_stake: DEVNET_CONFIG.evalStake.toString(),
      panel_size: DEVNET_CONFIG.panelSize,
      vote_secs: DEVNET_CONFIG.voteSecs,
    },
  });
  // The code `create_firm` deploys when anyone launches a firm.
  await call(tender, T, "set_firm_code", { code: Buffer.from(wasm("firm")).toString("base64") }, 0n, TGAS(200));
  log(`contracts: tender=${T} intents=${I} (mainnet code) usdc=${usdc.accountId} (mock)`);

  const firms: FirmHandle[] = [];
  for (let i = 0; i < strategies.length; i++) {
    const f = await createFirm({ tenderAcct: tender, provider, n: i + 1, owner: owners[i], strategy: strategies[i], budget: USDC(20), maxPerCall: USDC(25), budgetEpochSecs: 3600 });
    serialize(f.agentTender);
    serialize(f.agentFirm);
    firms.push(f);
  }

  const mint = async (accountId: string, amount: bigint) => {
    await call(usdc, usdc.accountId, "mint", { account_id: accountId, amount: amount.toString() });
  };
  const deposit = async (from: Account, amount: bigint, msg?: object) => {
    await call(from, usdc.accountId, "ft_transfer_call", { receiver_id: I, amount: amount.toString(), msg: "" }, 1n, TGAS(100));
    return call(from, I, "mt_transfer_call", { receiver_id: T, token_id: token, amount: amount.toString(), approval: null, memo: null, msg: msg ? JSON.stringify(msg) : "" }, 1n, TGAS(250));
  };
  const storage = (payer: Account, forId: string) => call(payer, T, "storage_deposit", { account_id: forId }, nearToYocto("0.5"));

  await mint(I, 0n);
  for (const a of [houseClient, ...owners]) await storage(root, a.accountId);
  for (const f of firms) await storage(root, f.account);
  await mint(houseClient.accountId, USDC(1_000_000));
  // A ledger buffer for the house client's dispute bonds.
  await deposit(houseClient, USDC(20));
  for (let i = 0; i < firms.length; i++) {
    const f = firms[i];
    await mint(f.owner.accountId, USDC(1000));
    await deposit(f.owner, USDC(30));
    await call(f.owner, T, "deposit_bond", { amount: USDC(10).toString() }, 1n);
    // Gambler Inc starts thin (1 USDC, under the 2 USDC floor): it will be liquidated and bought.
    await deposit(f.owner, i === 2 ? USDC(1) : USDC(20), { Credit: f.account });
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
    intents: I,
    token,
    judge,
    inference: inferenceAcct.accountId,
    houseClient,
    firms,
    strategies,
    deposit,
    createVisitor,
    mint,
  };
}
