// Real network (testnet or mainnet). The human runs these: they sign transactions and spend NEAR.
//
//   npx tsx src/network.ts deploy   deploy tender on TENDER_ID, create one firm per strategy, write KEYS_FILE
//   npx tsx src/network.ts run      run the swarm forever: bid on open jobs, settle, deliver, tick, liquidate
//
// Config comes from the environment (see .env.example). Keys are written to KEYS_FILE (gitignored), never committed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { JsonRpcProvider, type KeyPairString } from "near-api-js";
import { account, call, sleep, view, USDC } from "./chain.ts";
import { createFirm, deployContract, wasm } from "./deploy.ts";
import { makeLlm } from "./llm.ts";
import { loadStrategies } from "./strategy.ts";
import { Swarm, type FirmHandle } from "./swarm.ts";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k} (see .env.example)`);
  return v;
};

const provider = new JsonRpcProvider({ url: env("NEAR_RPC") });
const KEYS_FILE = env("KEYS_FILE", "../keys/firms.json");

type Keys = { firms: { id: number; account: string; owner: string; ownerKey: string; tenderKey: string; firmKey: string; strategy: string }[] };

function payment() {
  return env("PAYMENT", "intents") === "ft"
    ? { Ft: { token: env("USDC_TOKEN") } }
    : { Intents: { contract: env("INTENTS_CONTRACT", "intents.near"), token_id: env("INTENTS_TOKEN_ID") } };
}

async function deploy() {
  if (existsSync(KEYS_FILE)) throw new Error(`${KEYS_FILE} exists: refusing to redeploy over it`);
  const tender = account(env("TENDER_ID"), provider, env("TENDER_KEY") as KeyPairString);
  await deployContract(tender, wasm("tender"), "new", {
    config: {
      admin: tender.accountId,
      judge: env("JUDGE_ID"),
      payment: payment(),
      dividend_bps: 3000,
      liquidation_fee_bps: 200,
      min_bond: USDC(Number(env("MIN_BOND_USDC", "1"))).toString(),
      slash: USDC(Number(env("SLASH_USDC", "1"))).toString(),
      treasury_floor: USDC(Number(env("FLOOR_USDC", "0.5"))).toString(),
      epochs_before_liquidation: 3,
      epoch_secs: Number(env("EPOCH_SECS", "3600")),
      liquidation_commit_secs: 30,
      liquidation_reveal_secs: 30,
    },
  });
  // One owner account per firm, given as OWNER_IDS / OWNER_KEYS (comma separated, same order as strategies/).
  const ownerIds = env("OWNER_IDS").split(",");
  const ownerKeys = env("OWNER_KEYS").split(",");
  const strategies = await loadStrategies();
  const keys: Keys = { firms: [] };
  for (let i = 0; i < strategies.length; i++) {
    const owner = account(ownerIds[i % ownerIds.length], provider, ownerKeys[i % ownerKeys.length] as KeyPairString);
    const f = await createFirm({ tenderAcct: tender, provider, n: i + 1, owner, strategy: strategies[i], budget: USDC(Number(env("FIRM_BUDGET_USDC", "2"))), maxPerCall: USDC(1), budgetEpochSecs: 86400 });
    keys.firms.push({ id: f.id, account: f.account, owner: owner.accountId, ownerKey: ownerKeys[i % ownerKeys.length], tenderKey: f.keys.tender, firmKey: f.keys.firm, strategy: strategies[i].name });
    console.log(`firm #${f.id} ${f.account} ${strategies[i].name}`);
  }
  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
  console.log(`keys written to ${KEYS_FILE}. Owners must now deposit USDC, deposit_bond and fund their firm.`);
}

async function loadSwarm(): Promise<Swarm> {
  const keys: Keys = JSON.parse(readFileSync(KEYS_FILE, "utf8"));
  const strategies = await loadStrategies();
  const firms: FirmHandle[] = keys.firms.map((k) => ({
    id: k.id,
    account: k.account,
    owner: account(k.owner, provider, k.ownerKey as KeyPairString),
    agentTender: account(k.account, provider, k.tenderKey as KeyPairString),
    agentFirm: account(k.account, provider, k.firmKey as KeyPairString),
    strategy: strategies.find((s) => s.name === k.strategy) ?? (() => { throw new Error(`strategy ${k.strategy} not in strategies/`); })(),
  }));
  const judge = account(env("JUDGE_ID"), provider, env("JUDGE_KEY") as KeyPairString);
  return new Swarm(provider, env("TENDER_ID"), firms, judge, makeLlm(), env("INFERENCE_PROVIDER_ID"));
}

// ponytail: one job at a time (each auction blocks the loop for its commit+reveal phases); run jobs concurrently if volume grows.
async function run() {
  const swarm = await loadSwarm();
  const T = swarm.tender;
  const seen = new Set<string>();
  for (;;) {
    try {
      const jobs: any[] = await view(provider, T, "get_jobs", { from: 0, limit: 1000 });
      for (const j of jobs.filter((x) => x.status === "Bidding" && !seen.has(`job${x.id}`))) {
        seen.add(`job${j.id}`);
        const a = await view(provider, T, "get_auction", { auction_id: j.auction });
        const now: any = await provider.viewBlock({ finality: "optimistic" } as any);
        if (BigInt(now.header.timestamp_nanosec) < BigInt(a.commit_end)) await swarm.runJob(j.id).catch((e) => console.error(`job ${j.id}:`, e.message));
      }
      await swarm.tick();
      const firms: any[] = await view(provider, T, "get_firms");
      for (const f of firms.filter((x) => x.status === "Liquidating" && x.liquidation_auction !== null && !seen.has(`liq${x.liquidation_auction}`))) {
        seen.add(`liq${f.liquidation_auction}`);
        if (swarm.firms.some((h) => h.id === f.id)) await swarm.runLiquidation(f.id).catch((e) => console.error(`liquidation ${f.id}:`, e.message));
      }
    } catch (e) {
      console.error("loop:", (e as Error).message);
    }
    await sleep(Number(env("POLL_MS", "5000")));
  }
}

const cmd = process.argv[2];
if (cmd === "deploy") await deploy();
else if (cmd === "run") await run();
else throw new Error("usage: network.ts deploy|run");
