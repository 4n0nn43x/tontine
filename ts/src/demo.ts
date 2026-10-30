// `make demo`: the whole Tontine loop on a local NEAR sandbox. No funds, no keys, no network
// (NEAR AI Cloud and market.near.ai are replayed from fixtures/ unless their env vars are set).
// Every claim prints PASS or FAIL; the exit code is non-zero if any check fails.
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { JsonRpcProvider, KeyPair, nearToYocto, type Account } from "near-api-js";
import { account, call, view, fmt, USDC, sleep, TGAS } from "./chain.ts";
import { createAccount, createFirm, deployContract, wasm } from "./deploy.ts";
import { loadStrategies } from "./strategy.ts";
import { makeLlm } from "./llm.ts";
import { Swarm, bidHash, type FirmHandle } from "./swarm.ts";
import { board, placeBid } from "./market.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
async function rejects(p: Promise<unknown>, expect: string): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const m = String((e as Error).message ?? e);
    return m.includes(expect) ? m : `unexpected: ${m}`;
  }
}
const section = (s: string) => console.log(`\n== ${s}`);

const EPOCH_SECS = 4;
const TOKEN = `nep141:usdc.${DEFAULT_ACCOUNT_ID}`;
const FLOOR = USDC(2);

async function main() {
  section("sandbox");
  // 2.13.4 runs the protocol mainnet runs today (86): the wasm must deploy there, not only on newer nodes.
  const sandbox = await Sandbox.start({ version: process.env.SANDBOX_VERSION ?? "2.13.4" });
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const root = account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as any);
  const st: any = (await (await fetch(sandbox.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }) })).json()).result;
  console.log(`sandbox ${st.version.version}, protocol ${st.protocol_version}`);
  try {
    const mk = (name: string, near = "20") => createAccount(root, `${name}.${DEFAULT_ACCOUNT_ID}`, near, provider);
    const [usdc, tender, judgeA, client, inference, ...owners] = await Promise.all(
      ["usdc", "tender", "judge", "client", "inference", "o1", "o2", "o3", "o4", "o5"].map((n) => mk(n, n === "tender" ? "60" : "20")),
    );
    // The exact intents.near code running on mainnet (defuse 0.4.5, code hash BtA1BEFN...), see wasm/README.md.
    const intents = await mk("intents", "100");
    const I = intents.acct.accountId;
    await deployContract(intents.acct, wasm("intents_mainnet"), "new", {
      config: { wnear_id: `wrap.${DEFAULT_ACCOUNT_ID}`, fees: { fee: 0, fee_collector: I }, roles: {} },
    });
    const T = tender.acct.accountId;
    await deployContract(usdc.acct, wasm("mock_ft"), "new", {});
    await deployContract(tender.acct, wasm("tender"), "new", {
      config: {
        admin: T,
        judge: judgeA.acct.accountId,
        payment: { Intents: { contract: I, token_id: TOKEN } },
        dividend_bps: 3000,
        liquidation_fee_bps: 200,
        min_bond: USDC(5).toString(),
        slash: USDC(5).toString(),
        treasury_floor: FLOOR.toString(),
        epochs_before_liquidation: 2,
        epoch_secs: EPOCH_SECS,
        liquidation_commit_secs: 3,
        liquidation_reveal_secs: 3,
        dispute_bond: USDC(1).toString(),
        eval_stake: USDC(1).toString(),
        vote_secs: 4,
      },
    });
    console.log(`tender=${T}  intents=${I} (mainnet code)  usdc=${usdc.acct.accountId} (mock, sandbox only)`);

    const strategies = await loadStrategies();
    const firms: FirmHandle[] = [];
    for (let i = 0; i < strategies.length; i++) {
      firms.push(
        await createFirm({ tenderAcct: tender.acct, provider, n: i + 1, owner: owners[i].acct, strategy: strategies[i], budget: USDC(20), maxPerCall: USDC(25), budgetEpochSecs: 3600 }),
      );
    }
    // A second firm of o1, outside the swarm, used only to show the anti-shill rule.
    const o1Shell = await createFirm({ tenderAcct: tender.acct, provider, n: 9, owner: owners[0].acct, strategy: { name: "o1 shell", author: "test", house: true, bid: () => null, work: async () => "" }, budget: 0n, maxPerCall: 0n, budgetEpochSecs: 3600 });
    for (const f of firms) console.log(`firm #${f.id} ${f.account.padEnd(24)} ${f.strategy.name} (${f.strategy.house ? "house" : "third party"}) owner ${f.owner.accountId}`);

    const keys: any = await provider.viewAccessKeyList({ accountId: firms[0].account, finalityQuery: { finality: "final" } } as any).catch(() =>
      (provider as any).query({ request_type: "view_access_key_list", account_id: firms[0].account, finality: "final" }),
    );
    const perms = (keys.keys ?? []).map((k: any) => k.access_key.permission);
    check("firm accounts have no full access key", perms.length === 2 && perms.every((p: any) => p !== "FullAccess" && p.FunctionCall), `${perms.length} function call keys`);

    section("funding (mock USDC)");
    // Mainnet payment path, two steps: deposit USDC into intents.near, then mt_transfer_call to tender,
    // which receives mt_on_transfer. (defuse 0.4.5 has no deposit-and-notify: a deposit credited straight
    // to tender would never reach its ledger.)
    const ftCall = async (from: Account, amount: bigint, msg: object | "") => {
      await call(from, usdc.acct.accountId, "ft_transfer_call", { receiver_id: I, amount: amount.toString(), msg: "" }, 1n, TGAS(100));
      return call(from, I, "mt_transfer_call", { receiver_id: T, token_id: TOKEN, amount: amount.toString(), approval: null, memo: null, msg: msg === "" ? "" : JSON.stringify(msg) }, 1n, TGAS(250));
    };
    await call(usdc.acct, usdc.acct.accountId, "mint", { account_id: I, amount: "0" });
    // Callers prepay the storage they create in tender (NEP-145 style, audit finding F3).
    const storage = (a: Account, forId?: string) => call(a, T, "storage_deposit", forId ? { account_id: forId } : {}, nearToYocto("0.5"));
    await Promise.all([client.acct, ...owners.map((o) => o.acct)].map((a) => storage(a)));
    await Promise.all(firms.map((f) => storage(f.owner, f.account)));
    await call(usdc.acct, usdc.acct.accountId, "mint", { account_id: client.acct.accountId, amount: USDC(100).toString() });
    await Promise.all(
      firms.map(async (f, i) => {
        await call(usdc.acct, usdc.acct.accountId, "mint", { account_id: f.owner.accountId, amount: USDC(100).toString() });
        await ftCall(f.owner, USDC(10), "");
        await call(f.owner, T, "deposit_bond", { amount: USDC(10).toString() }, 1n);
        // Gambler Inc (firm 2) starts thin: 1 USDC treasury, under the 2 USDC floor.
        await ftCall(f.owner, i === 2 ? USDC(1) : USDC(20), { Credit: f.account });
      }),
    );
    await ftCall(owners[0].acct, USDC(5), { Credit: o1Shell.account });
    check("owners bonded, firm treasuries funded", BigInt(await view(provider, T, "balance_of", { account_id: firms[0].account })) === USDC(20));

    const llm = makeLlm();
    const swarm = new Swarm(provider, T, firms, judgeA.acct, llm, inference.acct.accountId, (s) => console.log(s));

    section("1. a client pays a job on-chain (ft_transfer_call with a PostJob message)");
    const brief1 = "Translate the README of a hackathon project from English to French, keep the markdown.";
    const post = (budget: bigint, brief: string) =>
      ftCall(client.acct, budget, { PostJob: { budget: budget.toString(), brief, commit_secs: 3, reveal_secs: 3, deliver_secs: 120 } });
    const p1 = await post(USDC(10), brief1);
    check("job posted and escrowed by the deposit", p1.events.some((e) => e.event === "job_posted"), `tx ${p1.txHash}`);

    section("2. reverse Vickrey between the firms");
    // o1 owns firm 0. A second firm of the same owner would let it pump the second price.
    let shill: string | null = null;
    const r1 = await swarm.runJob(0, async () => {
      shill = await rejects(call(o1Shell.owner, T, "commit_bid", { auction_id: (await swarm.job(0)).auction, firm_id: o1Shell.id, hash: bidHash(1n, "x") }), "one bid per owner");
    });
    check("anti-shill: a second firm of the same owner cannot bid", shill !== null && !String(shill).startsWith("unexpected"), shill ?? "");
    const revealed = r1.auction.bids.filter((b: any) => b.revealed).map((b: any) => BigInt(b.revealed)).sort((a: bigint, b: bigint) => (a < b ? -1 : 1));
    check("lowest bid wins, paid the second-lowest price", BigInt(r1.auction.price) === revealed[1], `price ${fmt(r1.auction.price)} USDC, bids ${revealed.map(fmt).join(" < ")}`);
    const w1 = swarm.firm(r1.auction.winner);
    const jobAfter = await swarm.job(0);
    check("delivery accepted by the judge, job paid", r1.verdict?.accept === true && jobAfter.status === "Paid");
    const pending = BigInt(await view(provider, T, "pending_dividends", { firm_id: w1.id, account_id: w1.owner.accountId }));
    check("30% of the price accrued to shareholders", pending === (BigInt(r1.auction.price) * 3000n) / 10000n, `${fmt(pending)} USDC to ${w1.owner.accountId}`);
    const mtBal = async (a: string) => BigInt(await view(provider, I, "mt_balance_of", { account_id: a, token_id: TOKEN }));
    const usdcBefore = BigInt(await view(provider, usdc.acct.accountId, "ft_balance_of", { account_id: w1.owner.accountId }));
    const intentsBefore = await mtBal(w1.owner.accountId);
    await call(w1.owner, T, "claim_dividends", { firm_id: w1.id }, 1n);
    // tender moves its intents.near balance as predecessor (mt_transfer, 1 yocto), no intent signed.
    await call(w1.owner, T, "withdraw", { amount: pending.toString() }, 1n, TGAS(100));
    check("tender paid the dividend through intents.near mt_transfer", (await mtBal(w1.owner.accountId)) - intentsBefore === pending);
    await call(w1.owner, I, "ft_withdraw", { token: usdc.acct.accountId, receiver_id: w1.owner.accountId, amount: pending.toString(), memo: null, msg: null }, 1n, TGAS(100));
    const usdcAfter = BigInt(await view(provider, usdc.acct.accountId, "ft_balance_of", { account_id: w1.owner.accountId }));
    check("shareholder withdrew the dividend from intents.near to its wallet", usdcAfter - usdcBefore === pending);
    check("firm paid its own inference from its treasury", BigInt(await view(provider, T, "balance_of", { account_id: inference.acct.accountId })) > 0n);

    section("3. a firm delivers nothing, the judge rejects it, its owner's bond is slashed");
    const clientBefore = BigInt(await view(provider, T, "balance_of", { account_id: client.acct.accountId }));
    await post(USDC(4), "Write three unit tests for a JSON-lines parser.");
    const r2 = await swarm.runJob(1);
    const loser = swarm.firm(r2.auction.winner);
    const bond = BigInt(await view(provider, T, "bond_of", { account_id: loser.owner.accountId }));
    check("empty delivery rejected", r2.verdict?.accept === false, loser.strategy.name);
    check("owner bond slashed by 5 USDC", bond === USDC(5), `bond now ${fmt(bond)}`);
    const clientAfter = BigInt(await view(provider, T, "balance_of", { account_id: client.acct.accountId }));
    check("client refunded the 4 USDC budget plus the 5 USDC slash", clientAfter - clientBefore === USDC(9), `+${fmt(clientAfter - clientBefore)} USDC in the ledger`);

    section("4. the illiquid firm is liquidated and bought by a rival (same auction code)");
    const gambler = firms[2];
    let ticks = 0;
    for (let i = 0; i < 6 && (await view(provider, T, "get_firm", { firm_id: gambler.id })).status !== "Liquidating"; i++) {
      if (await swarm.tick()) ticks++;
      else await sleep(EPOCH_SECS * 500);
    }
    const g = await view(provider, T, "get_firm", { firm_id: gambler.id });
    check("below the floor for 2 epochs -> Liquidating", g.status === "Liquidating", `${ticks} epoch ticks`);
    const oldOwner = gambler.owner.accountId;
    const oldOwnerBal = BigInt(await view(provider, T, "balance_of", { account_id: oldOwner }));
    const liq = await swarm.runLiquidation(gambler.id);
    const g2 = await view(provider, T, "get_firm", { firm_id: gambler.id });
    const buyer = swarm.firm(liq.winner);
    check("rival bought the firm at the second-highest price", liq.winner !== null && g2.owner === buyer.owner.accountId, `${buyer.strategy.name} paid ${fmt(liq.price)} USDC`);
    check("buyer firm holds 100% of the shares", (await view(provider, T, "mt_balance_of", { account_id: buyer.account, token_id: String(gambler.id) })) === "100");
    await sleep(1500);
    const fs = await view(provider, gambler.account, "get_state");
    const synced = (await view(provider, T, "get_firm", { firm_id: gambler.id })).owner_synced;
    check("firm contract owner changed by tender, confirmed by callback", fs.owner === buyer.owner.accountId && synced === true);
    const oldAgent = await rejects(call(gambler.agentFirm, gambler.account, "spend", { receiver_id: inference.acct.accountId, amount: "1" }), "");
    check("old owner's agent keys deleted on takeover", fs.agent_keys.length === 0 && oldAgent !== null, oldAgent ?? "");
    const ev = liq.events.find((e: { event: string }) => e.event === "liquidated")?.data[0];
    const toHolders = BigInt(ev?.to_shareholders ?? 0);
    const oldOwnerGain = BigInt(await view(provider, T, "balance_of", { account_id: oldOwner })) - oldOwnerBal;
    check("cascade: 2% fee, then shareholders", BigInt(ev?.fee ?? -1) === (BigInt(liq.price) * 200n) / 10000n && oldOwnerGain === toHolders, `fee ${fmt(ev?.fee ?? 0)}, old owner +${fmt(oldOwnerGain)}`);

    section("5. budgets: the firm contract refuses a 21 USDC spend on a 20 USDC budget");
    const over = await rejects(call(firms[0].agentFirm, firms[0].account, "spend", { receiver_id: inference.acct.accountId, amount: USDC(21).toString() }), "over budget");
    check("21 USDC spend on a 20 USDC budget rejected", over !== null && !over.startsWith("unexpected"), over ?? "");
    const noDeposit = await rejects(call(firms[0].agentTender, T, "withdraw", { amount: "1" }, 1n), "");
    check("agent key cannot call a deposit-taking method (withdraw)", noDeposit !== null);

    section("5b. open market: an account that is not the admin launches its own firm");
    await call(tender.acct, T, "set_firm_code", { code: Buffer.from(wasm("firm")).toString("base64") }, 0n, TGAS(200));
    const openKeys = [KeyPair.fromRandom("ed25519"), KeyPair.fromRandom("ed25519")].map((k) => k.getPublicKey().toString());
    const created = await call<number>(
      client.acct,
      T,
      "create_firm",
      { agent_keys: openKeys, budget: USDC(5).toString(), max_per_call: USDC(1).toString(), epoch_secs: 3600 },
      nearToYocto("3"),
      TGAS(250),
    );
    const openFirm = await view(provider, T, "get_firm", { firm_id: created.value });
    const openShares = await view(provider, T, "mt_balance_of", { account_id: client.acct.accountId, token_id: String(created.value) });
    check("a non-admin account launched a firm and holds its 100 shares", openFirm.owner === client.acct.accountId && openShares === "100", `${openFirm.account}, tx ${created.txHash}`);
    const openPerms = ((await (provider as any).query({ request_type: "view_access_key_list", account_id: openFirm.account, finality: "optimistic" })).keys ?? []).map((k: any) => k.access_key.permission);
    const openState = await view(provider, openFirm.account, "get_state");
    check(
      "tender created its account with the firm contract and two function call keys only",
      openPerms.length === 2 && openPerms.every((p: any) => p !== "FullAccess" && p.FunctionCall) && openState.owner === client.acct.accountId && openState.tender === T,
      `${openPerms.length} function call keys`,
    );

    section("5c. optimistic review: the client disputes an empty delivery, a panel of firms decides");
    const o = await ftCall(client.acct, USDC(4), {
      PostJob: { budget: USDC(4).toString(), brief: "Summarize the NEAR Intents fee page", commit_secs: 3, reveal_secs: 3, deliver_secs: 120, criteria: "min words: 8", verify: { Optimistic: { review_secs: 60 } } },
    });
    const oJob = (o.events.find((e) => e.event === "job_posted")?.data as any)?.[0]?.job_id as number;
    const seller = firms[1];
    await swarm.auction((await swarm.job(oJob)).auction, new Map([[seller.id, USDC(3)]]), false);
    await call(seller.agentTender, T, "deliver", { job_id: oJob, result: "" });
    const sellerBond = BigInt(await view(provider, T, "bond_of", { account_id: seller.owner.accountId }));
    await call(client.acct, T, "dispute", { job_id: oJob }, 1n);
    const panel: any[] = (await view(provider, T, "get_dispute", { job_id: oJob })).panel;
    const evalBefore = await Promise.all(panel.map(async (b) => BigInt(await view(provider, T, "balance_of", { account_id: (await view(provider, T, "get_firm", { firm_id: b.firm_id })).account }))));
    for (let i = 0; i < 40 && (await view(provider, T, "get_job", { job_id: oJob })).status === "Disputed"; i++) {
      await swarm.serveDispute(oJob);
      await sleep(1000);
    }
    const dOut = await view(provider, T, "get_dispute", { job_id: oJob });
    const noVotes = dOut.panel.filter((b: any) => b.vote === false).length;
    check(
      "a panel of firms that did not do the job rejected the empty delivery",
      (await view(provider, T, "get_job", { job_id: oJob })).status === "Rejected" && noVotes > dOut.panel.length / 2,
      `${noVotes} of ${dOut.panel.length} evaluators rejected, ${dOut.panel.filter((b: any) => b.vote === null).length} silent`,
    );
    const evalAfter = await Promise.all(dOut.panel.map(async (b: any) => BigInt(await view(provider, T, "balance_of", { account_id: (await view(provider, T, "get_firm", { firm_id: b.firm_id })).account }))));
    const paidEvaluators = dOut.panel.filter((b: any, i: number) => b.vote === false && evalAfter[i] > evalBefore[i]).length;
    const slashed = sellerBond - BigInt(await view(provider, T, "bond_of", { account_id: seller.owner.accountId }));
    check("the losing owner's slashed bond paid the majority evaluators", slashed === USDC(5) && paidEvaluators === noVotes, `bond -${fmt(slashed)}, ${paidEvaluators} evaluators paid`);

    section("6. market.near.ai as demand source (off-chain revenue, booked apart)");
    const mb = await board();
    for (const mj of mb.jobs.slice(0, 2)) {
      const budget = USDC(Number(mj.budgetAmount ?? 0));
      const offers = firms
        .map((f) => ({ f, p: f.strategy.bid({ id: -1, client: "market.near.ai", budget, brief: mj.description }, { id: f.id, account: f.account, treasury: 0n, delivered: 0, rejected: 0 }) }))
        .filter((o) => o.p !== null && o.p <= budget)
        .sort((a, b) => (a.p! < b.p! ? -1 : 1));
      if (!offers.length) continue;
      const status = await placeBid(mj.jobId, fmt(offers[0].p!), `${offers[0].f.strategy.name}: ${mj.title}`);
      console.log(`  [${mb.source}] ${mj.title}: ${offers[0].f.strategy.name} bids ${fmt(offers[0].p!)} ${mj.budgetToken} (${status}, off-chain)`);
    }

    section("P&L per firm (on-chain)");
    for (const f of await view(provider, T, "get_firms")) {
      const bal = BigInt(await view(provider, T, "balance_of", { account_id: f.account }));
      console.log(
        `  #${f.id} ${(firms[f.id]?.strategy.name ?? (f.id === o1Shell.id ? "o1 shell" : "open firm")).padEnd(18)} ${f.status.padEnd(11)} treasury ${fmt(bal).padStart(6)}  revenue ${fmt(f.revenue).padStart(6)}  dividends ${fmt(f.dividends).padStart(5)}  delivered ${f.delivered} rejected ${f.rejected} slashed ${fmt(f.slashed)}  owner ${f.owner}`,
      );
    }
  } finally {
    await sandbox.tearDown();
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nALL CHECKS PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
