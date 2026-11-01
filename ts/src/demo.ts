// `make demo`: the whole Tontine loop on a local NEAR sandbox. No funds, no keys, no network
// (NEAR prices replay fixtures/near-usd-5m.json; NEAR AI Cloud answers only with NEARAI_API_KEY).
// Every claim prints PASS or FAIL; the exit code is non-zero if any check fails.
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { JsonRpcProvider, KeyPair, nearToYocto, type Account } from "near-api-js";
import { account, call, view, fmt, USDC, sleep, TGAS, waitUntilChainTime } from "./chain.ts";
import { createAccount, createFirm, deployContract, wasm } from "./deploy.ts";
import { loadStrategies } from "./strategy.ts";
import { makeLlm } from "./llm.ts";
import { Swarm, bidHash, type FirmHandle } from "./swarm.ts";
import { CLIENT_TOLERANCE_BPS, outAt, replayPrices, toBase } from "./prices.ts";
import { marketHouse } from "./devnet.ts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { checkRelay, evmAccount, orderPayload, Payouts, signErc191, submitRelay } from "./relay.ts";

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
const STABLE = `nep141:usdc.${DEFAULT_ACCOUNT_ID}`;
const ASSET = `nep141:wnear.${DEFAULT_ACCOUNT_ID}`;
const NEAR = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
const fmtNear = (v: bigint | string) => (Number(BigInt(v)) / 1e24).toFixed(4);
const FLOOR = USDC(40);
/** Tontine's share of a fill's gain over the client's minimum. */
const SURPLUS_BPS = 3000;
// Replayed NEAR price: 2026-10-08 08:10 UTC, 5.347 USD (Binance 5-minute close).
const AT = 10776;

async function main() {
  section("sandbox");
  // 2.13.4 runs protocol 86, as mainnet until its upgrade: the wasm must deploy there, not only on newer nodes.
  const sandbox = await Sandbox.start({ version: process.env.SANDBOX_VERSION ?? "2.13.4" });
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const root = account(DEFAULT_ACCOUNT_ID, provider, DEFAULT_PRIVATE_KEY as any);
  const st: any = (await (await fetch(sandbox.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }) })).json()).result;
  console.log(`sandbox ${st.version.version}, protocol ${st.protocol_version}`);
  const prices = replayPrices().prices;
  const at = AT;
  const mid = async () => prices[at];
  try {
    const mk = (name: string, near = "20") => createAccount(root, `${name}.${DEFAULT_ACCOUNT_ID}`, near, provider);
    const strategies = await loadStrategies();
    const [usdc, wnear, tender, client, inference, ...owners] = await Promise.all(
      ["usdc", "wnear", "tender", "client", "inference", ...strategies.map((_, i) => `o${i + 1}`)].map((n) => mk(n, n === "tender" ? "60" : "20")),
    );
    // The exact intents.near code running on mainnet (defuse 0.4.5, code hash BtA1BEFN...), see wasm/README.md.
    const intents = await mk("intents", "100");
    const I = intents.acct.accountId;
    await deployContract(intents.acct, wasm("intents_mainnet"), "new", {
      config: { wnear_id: `wrap.${DEFAULT_ACCOUNT_ID}`, fees: { fee: 0, fee_collector: I }, roles: {} },
    });
    const T = tender.acct.accountId;
    // Two mock NEP-141 tokens (sandbox only): USDC (6 decimals) and wNEAR (24 decimals by convention).
    await deployContract(usdc.acct, wasm("mock_ft"), "new", {});
    await deployContract(wnear.acct, wasm("mock_ft"), "new", {});
    await deployContract(tender.acct, wasm("tender"), "new", {
      config: {
        admin: T,
        payment: { Intents: { contract: I, token_id: STABLE } },
        asset: { Intents: { contract: I, token_id: ASSET } },
        asset_unit: (10n ** 24n).toString(),
        initial_price: toBase(prices[at]).toString(),
        dividend_bps: 3000,
        liquidation_fee_bps: 200,
        min_bond: USDC(5).toString(),
        slash: USDC(1).toString(),
        treasury_floor: FLOOR.toString(),
        epochs_before_liquidation: 2,
        epoch_secs: EPOCH_SECS,
        liquidation_commit_secs: 3,
        liquidation_reveal_secs: 3,
        order_fee_bps: 2,
        no_reveal_slash_bps: 100,
        surplus_bps: SURPLUS_BPS,
      },
    });
    console.log(`tender=${T}  intents=${I} (mainnet code)  usdc, wnear (mocks, sandbox only)`);

    const firms: FirmHandle[] = [];
    for (let i = 0; i < strategies.length; i++) {
      firms.push(
        await createFirm({ tenderAcct: tender.acct, provider, n: i + 1, owner: owners[i].acct, strategy: strategies[i], budget: USDC(20), maxPerCall: USDC(25), budgetEpochSecs: 3600 }),
      );
    }
    // A second firm of o1, outside the swarm, used only to show the anti-shill rule.
    const o1Shell = await createFirm({ tenderAcct: tender.acct, provider, n: 9, owner: owners[0].acct, strategy: { name: "o1 shell", author: "test", house: true, params: { spreadBps: 0, targetAssetShare: 0, skewBps: 0 } }, budget: 0n, maxPerCall: 0n, budgetEpochSecs: 3600 });
    for (const f of firms) console.log(`firm #${f.id} ${f.account.padEnd(24)} ${f.strategy.name} (${f.strategy.house ? "house" : "third party"}) owner ${f.owner.accountId}`);

    const keys: any = await (provider as any).query({ request_type: "view_access_key_list", account_id: firms[0].account, finality: "final" });
    const perms = (keys.keys ?? []).map((k: any) => k.access_key.permission);
    check("firm accounts have no full access key", perms.length === 2 && perms.every((p: any) => p !== "FullAccess" && p.FunctionCall), `${perms.length} function call keys`);

    section("funding through the mainnet intents.near code (mock USDC and wNEAR)");
    // Mainnet payment path, two steps: deposit into intents.near, then mt_transfer_call to tender, which
    // receives mt_on_transfer. (defuse 0.4.5 removed the notification on deposits: a deposit credited
    // straight to tender would never reach its ledger.)
    const tokenOf = (t: "usdc" | "wnear") => (t === "usdc" ? usdc : wnear);
    const deposit = async (from: Account, t: "usdc" | "wnear", amount: bigint, msg: object | "" = "") => {
      await call(from, tokenOf(t).acct.accountId, "ft_transfer_call", { receiver_id: I, amount: amount.toString(), msg: "" }, 1n, TGAS(100));
      return call(from, I, "mt_transfer_call", { receiver_id: T, token_id: t === "usdc" ? STABLE : ASSET, amount: amount.toString(), approval: null, memo: null, msg: msg === "" ? "" : JSON.stringify(msg) }, 1n, TGAS(250));
    };
    const mint = (t: "usdc" | "wnear", to: string, amount: bigint) => call(tokenOf(t).acct, tokenOf(t).acct.accountId, "mint", { account_id: to, amount: amount.toString() });
    await mint("usdc", I, 0n);
    await mint("wnear", I, 0n);
    // Callers prepay the storage they create in tender (NEP-145 style, audit finding F3).
    const storage = (a: Account, forId?: string) => call(a, T, "storage_deposit", forId ? { account_id: forId } : {}, nearToYocto("0.5"));
    await Promise.all([client.acct, ...owners.map((o) => o.acct)].map((a) => storage(a)));
    await Promise.all(firms.map((f) => storage(f.owner, f.account)));
    await mint("usdc", client.acct.accountId, USDC(500));
    await mint("wnear", client.acct.accountId, NEAR(50));
    const gambler = firms.find((f) => f.strategy.name === "Gambler Inc")!;
    await Promise.all(
      firms.map(async (f) => {
        await mint("usdc", f.owner.accountId, USDC(1000));
        await mint("wnear", f.owner.accountId, NEAR(100));
        await deposit(f.owner, "usdc", USDC(10));
        await call(f.owner, T, "deposit_bond", { amount: USDC(10).toString() }, 1n);
        // Gambler Inc starts with 60 USDC of cash (the floor is 40) and 2 NEAR; it spends its cash on NEAR.
        const all = f === gambler;
        await deposit(f.owner, "usdc", all ? USDC(60) : USDC(300), { Credit: f.account });
        await deposit(f.owner, "wnear", all ? NEAR(2) : NEAR(40), { Credit: f.account });
      }),
    );
    // Its owner lets it hold up to 100% of its value in NEAR.
    await call(gambler.owner, T, "set_policy", { firm_id: gambler.id, policy: { max_asset_bps: 10000, band_bps: 1000, paused: false } }, 1n);
    await deposit(owners[0].acct, "usdc", USDC(5), { Credit: o1Shell.account });
    const navOf = async (id: number) => BigInt(await view(provider, T, "nav_of", { firm_id: id }));
    check(
      "owners bonded, firms hold a USDC treasury and a wNEAR inventory",
      BigInt(await view(provider, T, "asset_balance_of", { account_id: firms[0].account })) === NEAR(40) && BigInt(await view(provider, T, "balance_of", { account_id: firms[0].account })) === USDC(300),
      `firm #0 NAV ${fmt(await navOf(firms[0].id))} USDC at ${prices[at]} USD per NEAR`,
    );

    const swarm = new Swarm(provider, T, firms, makeLlm(), inference.acct.accountId, mid, (s) => console.log(s));
    const fill = (from: Account, side: "Buy" | "Sell", amountIn: bigint) => {
      // The client's minimum is the market reference (replayed here): the mid less the client tolerance.
      const ref = outAt(side, amountIn, prices[at], CLIENT_TOLERANCE_BPS);
      return deposit(from, side === "Buy" ? "usdc" : "wnear", amountIn, { PostOrder: { side, amount_in: amountIn.toString(), min_out: ref.toString(), reference_out: ref.toString(), commit_secs: 3, reveal_secs: 3 } });
    };
    const orderId = (r: any) => r.events.find((e: any) => e.event === "order_posted")?.data[0].order_id as number;

    section("1. a client buys NEAR: deposit and order in one NEAR Intents transfer, never worse than the market");
    const p1 = await fill(client.acct, "Buy", USDC(40));
    const o1 = orderId(p1);
    check("order posted, the 40 USDC escrowed by the deposit", o1 !== undefined && (await view(provider, T, "get_order", { order_id: o1 })).status === "Open", `tx ${p1.txHash}`);

    section("2. sealed bids between the firms, the best fills at the second best, atomically");
    let shill: string | null = null;
    const assetBefore = BigInt(await view(provider, T, "asset_balance_of", { account_id: client.acct.accountId }));
    const adminAssetBefore = BigInt(await view(provider, T, "asset_balance_of", { account_id: T })); // tender is its own admin here
    const r1 = await swarm.runOrder(o1, async () => {
      const ord = await view(provider, T, "get_order", { order_id: o1 });
      shill = await rejects(call(o1Shell.agentTender, T, "commit_bid", { auction_id: ord.auction, firm_id: o1Shell.id, hash: bidHash(ord.auction, o1Shell.id, 1n, "x") }), "one bid per owner");
    });
    check("anti-shill: a second firm of the same owner cannot bid", shill !== null && !String(shill).startsWith("unexpected"), shill ?? "");
    const revealed = r1.auction.bids.map((b: any) => b.revealed).filter(Boolean).map(BigInt).sort((a: bigint, b: bigint) => (a < b ? 1 : -1));
    // The firm delivers the auction's price; the client receives the stored `out`, that less the surplus share.
    const delivered1 = BigInt(r1.auction.price);
    const out1 = BigInt(r1.order.out);
    check("the best quote wins and delivers the second best", revealed.length >= 2 && delivered1 === revealed[1], `${fmtNear(delivered1)} NEAR, bids ${revealed.map(fmtNear).join(" > ")}`);
    const ref1 = BigInt(r1.order.reference_out);
    check(
      "the client got at least the market reference",
      out1 >= ref1,
      `+${((Number(out1 - ref1) / Number(ref1)) * 1e4).toFixed(1)} bp over the market reference ${fmtNear(ref1)} NEAR`,
    );
    const filled1 = r1.auction.events.find((e: any) => e.event === "order_filled")?.data[0];
    const surplus1 = ((delivered1 - BigInt(r1.order.min_out)) * BigInt(SURPLUS_BPS)) / 10_000n;
    const adminGain = BigInt(await view(provider, T, "asset_balance_of", { account_id: T })) - adminAssetBefore;
    check(
      "Tontine took its 30% share of the gain over the client's minimum, in NEAR",
      surplus1 > 0n && BigInt(filled1?.surplus_fee ?? -1) === surplus1 && adminGain === surplus1 && out1 === delivered1 - surplus1,
      `${fmtNear(surplus1)} NEAR to Tontine, the client keeps ${fmtNear(out1)} NEAR`,
    );
    check(
      "settlement is atomic: the client's NEAR and the firm's USDC move in the settle transaction",
      BigInt(await view(provider, T, "asset_balance_of", { account_id: client.acct.accountId })) - assetBefore === out1 && filled1?.order_id === o1,
      `tx ${r1.auction.txHash}`,
    );

    section("3. 30% of the fill's edge goes to the winner's shareholders, withdrawn through intents.near");
    const w1 = swarm.firm(r1.auction.winner);
    const edge1 = BigInt(filled1?.edge ?? 0);
    const pending = BigInt(await view(provider, T, "pending_dividends", { firm_id: w1.id, account_id: w1.owner.accountId }));
    check("30% of the edge accrued to shareholders", edge1 > 0n && pending === (edge1 * 3000n) / 10000n, `edge ${fmt(edge1)} USDC, ${fmt(pending)} USDC to ${w1.owner.accountId}`);
    const mtBal = async (a: string) => BigInt(await view(provider, I, "mt_balance_of", { account_id: a, token_id: STABLE }));
    const usdcBefore = BigInt(await view(provider, usdc.acct.accountId, "ft_balance_of", { account_id: w1.owner.accountId }));
    const intentsBefore = await mtBal(w1.owner.accountId);
    await call(w1.owner, T, "claim_dividends", { firm_id: w1.id }, 1n);
    // tender moves its intents.near balance as predecessor (mt_transfer, 1 yocto), no intent signed.
    await call(w1.owner, T, "withdraw", { amount: pending.toString() }, 1n, TGAS(100));
    check("tender paid the dividend through intents.near mt_transfer", (await mtBal(w1.owner.accountId)) - intentsBefore === pending);
    await call(w1.owner, I, "ft_withdraw", { token: usdc.acct.accountId, receiver_id: w1.owner.accountId, amount: pending.toString(), memo: null, msg: null }, 1n, TGAS(100));
    const usdcAfter = BigInt(await view(provider, usdc.acct.accountId, "ft_balance_of", { account_id: w1.owner.accountId }));
    check("shareholder withdrew the dividend from intents.near to its wallet", usdcAfter - usdcBefore === pending);

    section("4. a client sells NEAR for USDC");
    const r4 = await swarm.runOrder(orderId(await fill(client.acct, "Sell", NEAR(2))));
    check("sell order filled at least at the market reference",r4.order.status === "Filled" && BigInt(r4.order.out) >= BigInt(r4.order.reference_out), `${fmt(r4.order.out)} USDC for 2 NEAR`);

    section("5. Atlas AI's manager retunes its quotes from its results");
    const atlas = firms.find((f) => f.strategy.managed === true)!;
    const d = await swarm.manage(atlas);
    check(
      `manager decision recorded (${d.source === "rule" ? "rule: no LLM key" : d.source === "anthropic" ? "LLM, Claude" : "LLM on NEAR AI Cloud"}), params bounded`,
      d.after.spreadBps >= 1 && d.after.spreadBps <= 300 && d.after.targetAssetShare <= 0.8,
      `spread ${d.before.spreadBps} -> ${d.after.spreadBps} bp: ${d.reason}`,
    );

    section("6. a committed bid that is never revealed costs its owner's bond");
    const p6 = await fill(client.acct, "Buy", USDC(20));
    const a6 = (await view(provider, T, "get_order", { order_id: orderId(p6) })).auction;
    const [quiet, honest] = [firms[3], firms[1]];
    const fair6 = outAt("Buy", USDC(20), prices[at], 5);
    await call(quiet.agentTender, T, "commit_bid", { auction_id: a6, firm_id: quiet.id, hash: bidHash(a6, quiet.id, fair6, "q") });
    await call(honest.agentTender, T, "commit_bid", { auction_id: a6, firm_id: honest.id, hash: bidHash(a6, honest.id, fair6, "h") });
    const clientStable = BigInt(await view(provider, T, "balance_of", { account_id: client.acct.accountId }));
    const a6v = await view(provider, T, "get_auction", { auction_id: a6 });
    await waitUntilChainTime(provider, a6v.commit_end);
    await call(honest.agentTender, T, "reveal_bid", { auction_id: a6, firm_id: honest.id, amount: fair6.toString(), salt: "h" });
    await waitUntilChainTime(provider, a6v.reveal_end);
    await call(honest.agentTender, T, "settle", { auction_id: a6 });
    const quietBond = BigInt(await view(provider, T, "bond_of", { account_id: quiet.owner.accountId }));
    const gain = BigInt(await view(provider, T, "balance_of", { account_id: client.acct.accountId })) - clientStable;
    check("the silent bidder's owner bond paid the client", quietBond === USDC(9) && gain === USDC(1), `bond 10 -> ${fmt(quietBond)} USDC, client +${fmt(gain)} USDC`);

    section("7. a hijacked agent cannot dump its firm's inventory: the owner's band holds on chain");
    // Prompt injection in a market feed: "liquidate all NEAR at any price". The agent bids half the price.
    const victim = firms[1];
    const p7 = await fill(client.acct, "Buy", USDC(20));
    const a7 = (await view(provider, T, "get_order", { order_id: orderId(p7) })).auction;
    const dump = outAt("Buy", USDC(20), prices[at] / 2, 0);
    const victimAsset = BigInt(await view(provider, T, "asset_balance_of", { account_id: victim.account }));
    await call(victim.agentTender, T, "commit_bid", { auction_id: a7, firm_id: victim.id, hash: bidHash(a7, victim.id, dump, "inj") });
    const a7v = await view(provider, T, "get_auction", { auction_id: a7 });
    await waitUntilChainTime(provider, a7v.commit_end);
    const refused = await rejects(call(victim.agentTender, T, "reveal_bid", { auction_id: a7, firm_id: victim.id, amount: dump.toString(), salt: "inj" }), "bid outside the firm's price band");
    check("the 50%-off bid is refused at reveal by the owner's price band", refused !== null && !refused.startsWith("unexpected"), refused ?? "");
    await waitUntilChainTime(provider, a7v.reveal_end);
    await call(victim.agentTender, T, "settle", { auction_id: a7 });
    check(
      "the firm kept its inventory (it lost only the no-reveal slash)",
      BigInt(await view(provider, T, "asset_balance_of", { account_id: victim.account })) === victimAsset,
      `${fmtNear(victimAsset)} NEAR untouched`,
    );

    section("8. a firm that turns its cash into NEAR becomes illiquid: liquidated, bought, its NEAR to its shareholders");
    const cash = async (f: FirmHandle) => BigInt(await view(provider, T, "balance_of", { account_id: f.account }));
    console.log(`  Gambler Inc cash ${fmt(await cash(gambler))} USDC (floor ${fmt(FLOOR)}), it buys NEAR from every seller`);
    for (let i = 0; i < 4 && (await cash(gambler)) >= FLOOR; i++) await swarm.runOrder(orderId(await fill(client.acct, "Sell", NEAR(4))));
    const gamblerNear = BigInt(await view(provider, T, "asset_balance_of", { account_id: gambler.account }));
    check("Gambler Inc spent its cash on NEAR, under the floor", (await cash(gambler)) < FLOOR, `cash ${fmt(await cash(gambler))} USDC, ${fmtNear(gamblerNear)} NEAR`);
    let ticks = 0;
    for (let i = 0; i < 8 && (await view(provider, T, "get_firm", { firm_id: gambler.id })).status !== "Liquidating"; i++) {
      if (await swarm.tick()) ticks++;
      else await sleep(EPOCH_SECS * 500);
    }
    const g = await view(provider, T, "get_firm", { firm_id: gambler.id });
    check("cash under the floor for 2 epochs -> Liquidating", g.status === "Liquidating", `${ticks} epoch ticks`);
    const oldOwner = gambler.owner.accountId;
    const oldOwnerBal = BigInt(await view(provider, T, "balance_of", { account_id: oldOwner }));
    const oldOwnerNear = BigInt(await view(provider, T, "asset_balance_of", { account_id: oldOwner }));
    // Dividends from its own fills, not yet claimed, are paid out with the sale.
    const pendingBefore = BigInt(await view(provider, T, "pending_dividends", { firm_id: gambler.id, account_id: oldOwner }));
    const reserve = BigInt((await view(provider, T, "get_auction", { auction_id: g.liquidation_auction })).reserve);
    const liq = await swarm.runLiquidation(gambler.id);
    const g2 = await view(provider, T, "get_firm", { firm_id: gambler.id });
    const buyer = liq.winner !== null ? swarm.firm(liq.winner) : null;
    check("a rival bought the firm at the second-highest price", buyer !== null && g2.owner === buyer.owner.accountId && BigInt(liq.price) >= reserve, `${buyer?.strategy.name} paid ${fmt(liq.price ?? 0)} USDC`);
    check(
      "its NEAR went to its old shareholder in kind, not to the buyer",
      BigInt(await view(provider, T, "asset_balance_of", { account_id: oldOwner })) - oldOwnerNear === gamblerNear &&
        BigInt(await view(provider, T, "asset_balance_of", { account_id: gambler.account })) === 0n,
      `${fmtNear(gamblerNear)} NEAR to ${oldOwner}`,
    );
    if (buyer) {
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
      check(
        "cascade: 2% fee, then shareholders",
        BigInt(ev?.fee ?? -1) === (BigInt(liq.price) * 200n) / 10000n && oldOwnerGain === toHolders + pendingBefore,
        `fee ${fmt(ev?.fee ?? 0)}, old owner +${fmt(oldOwnerGain)} USDC (pot ${fmt(toHolders)} + unclaimed dividends ${fmt(pendingBefore)})`,
      );
    }

    section("9. budgets: the firm contract refuses a 21 USDC spend on a 20 USDC budget");
    const over = await rejects(call(firms[0].agentFirm, firms[0].account, "spend", { receiver_id: inference.acct.accountId, amount: USDC(21).toString() }), "over budget");
    check("21 USDC spend on a 20 USDC budget rejected", over !== null && !over.startsWith("unexpected"), over ?? "");
    const noDeposit = await rejects(call(firms[0].agentTender, T, "withdraw", { amount: "1" }, 1n), "");
    check("agent key cannot call a deposit-taking method (withdraw)", noDeposit !== null);

    section("10. open market: an account that is not the admin launches its own firm");
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
      openState.owner === client.acct.accountId && openPerms.length === 2 && openPerms.every((p: any) => p !== "FullAccess" && p.FunctionCall),
      `${openPerms.length} function call keys`,
    );

    section("11. a second market: ETH/USDC on its own tender, same contract, same rules");
    // One tender per pair: the asset is wETH (18 decimals) inside intents.near, prices in USDC per ETH.
    const ETH_UNIT = 10n ** 18n;
    const ethMid = replayPrices("ETH").prices[at];
    const [weth, tenderEth, ...ethOwners] = await Promise.all(["weth", "tender-eth", "oeth1", "oeth2"].map((n) => mk(n, n === "tender-eth" ? "60" : "20")));
    const TE = tenderEth.acct.accountId;
    const WETH = `nep141:${weth.acct.accountId}`;
    await deployContract(weth.acct, wasm("mock_ft"), "new", {});
    await deployContract(tenderEth.acct, wasm("tender"), "new", {
      config: {
        admin: TE,
        payment: { Intents: { contract: I, token_id: STABLE } },
        asset: { Intents: { contract: I, token_id: WETH } },
        asset_unit: ETH_UNIT.toString(),
        initial_price: toBase(ethMid).toString(),
        dividend_bps: 3000,
        liquidation_fee_bps: 200,
        min_bond: USDC(5).toString(),
        slash: USDC(1).toString(),
        treasury_floor: FLOOR.toString(),
        epochs_before_liquidation: 2,
        epoch_secs: EPOCH_SECS,
        liquidation_commit_secs: 3,
        liquidation_reveal_secs: 3,
        order_fee_bps: 2,
        no_reveal_slash_bps: 100,
        surplus_bps: SURPLUS_BPS,
      },
    });
    const toTender = async (from: Account, ft: string, tender: string, amount: bigint, msg: object | "" = "") => {
      await call(from, ft, "ft_transfer_call", { receiver_id: I, amount: amount.toString(), msg: "" }, 1n, TGAS(100));
      return call(from, I, "mt_transfer_call", { receiver_id: tender, token_id: `nep141:${ft}`, amount: amount.toString(), approval: null, memo: null, msg: msg === "" ? "" : JSON.stringify(msg) }, 1n, TGAS(250));
    };
    await call(weth.acct, weth.acct.accountId, "mint", { account_id: I, amount: "0" });
    const ethHouse = marketHouse("ETH").slice(0, 2);
    const ethFirms: FirmHandle[] = [];
    for (let i = 0; i < ethHouse.length; i++) {
      ethFirms.push(await createFirm({ tenderAcct: tenderEth.acct, provider, n: i + 1, owner: ethOwners[i].acct, strategy: ethHouse[i], budget: 0n, maxPerCall: 0n, budgetEpochSecs: 3600 }));
    }
    const ethWorth = (usd: number) => (BigInt(Math.round((usd / ethMid) * 1e6)) * ETH_UNIT) / 1_000_000n;
    await Promise.all([client.acct, ...ethOwners.map((o) => o.acct)].map((a) => call(a, TE, "storage_deposit", {}, nearToYocto("0.5"))));
    await Promise.all(ethFirms.map((f) => call(f.owner, TE, "storage_deposit", { account_id: f.account }, nearToYocto("0.5"))));
    for (const f of ethFirms) {
      await mint("usdc", f.owner.accountId, USDC(400));
      await call(weth.acct, weth.acct.accountId, "mint", { account_id: f.owner.accountId, amount: ethWorth(200).toString() });
      await toTender(f.owner, usdc.acct.accountId, TE, USDC(10));
      await call(f.owner, TE, "deposit_bond", { amount: USDC(10).toString() }, 1n);
      await toTender(f.owner, usdc.acct.accountId, TE, USDC(300), { Credit: f.account });
      await toTender(f.owner, weth.acct.accountId, TE, ethWorth(150), { Credit: f.account });
    }
    const ethSwarm = new Swarm(provider, TE, ethFirms, makeLlm(), inference.acct.accountId, async () => ethMid, (s) => console.log(s), { symbol: "ETH", unit: ETH_UNIT });
    const ethRef = outAt("Buy", USDC(40), ethMid, CLIENT_TOLERANCE_BPS, ETH_UNIT);
    const pe = await toTender(client.acct, usdc.acct.accountId, TE, USDC(40), { PostOrder: { side: "Buy", amount_in: USDC(40).toString(), min_out: ethRef.toString(), reference_out: ethRef.toString(), commit_secs: 3, reveal_secs: 3 } });
    const re = await ethSwarm.runOrder(orderId(pe));
    const ethGot = BigInt(await view(provider, TE, "asset_balance_of", { account_id: client.acct.accountId }));
    check(
      "an ETH/USDC order filled on the ETH tender, at least the market reference",
      re.order.status === "Filled" && ethGot === BigInt(re.order.out) && ethGot >= ethRef,
      `${(Number(ethGot) / 1e18).toFixed(6)} ETH for 40 USDC at ${ethMid} USD, ${ethFirms.map((f) => f.strategy.name).join(" and ")} bid, tx ${re.auction.txHash}`,
    );

    section("12. a Base (EVM) user trades without a NEAR account: an ERC-191 intent, a relay, a payout");
    // NEAR Intents' implicit account of a secp256k1 key is its lower-case 0x address; it signs with personal_sign.
    const sk = secp256k1.utils.randomSecretKey();
    const evm = evmAccount(sk);
    // On mainnet the USDC arrives from Base through NEAR Intents (1Click or the bridge); here a deposit with msg = the 0x account.
    await mint("usdc", usdc.acct.accountId, USDC(40));
    await call(usdc.acct, usdc.acct.accountId, "ft_transfer_call", { receiver_id: I, amount: USDC(40).toString(), msg: evm }, 1n, TGAS(100));
    check("a fresh EVM key's 0x account holds USDC in NEAR Intents (simulated Base deposit)", (await mtBal(evm)) === USDC(40), `${evm}, 40 USDC`);
    const evmRef = outAt("Buy", USDC(40), prices[at], CLIENT_TOLERANCE_BPS);
    const payload = orderPayload({
      signer: evm,
      intents: I,
      tender: T,
      token: STABLE,
      amount: USDC(40),
      order: { side: "Buy", amount_in: USDC(40).toString(), min_out: evmRef.toString(), reference_out: evmRef.toString(), commit_secs: 3, reveal_secs: 3 },
      salt: await view(provider, I, "current_salt"),
      deadlineMs: Date.now() + 5 * 60_000,
    });
    const signed = signErc191(payload, sk);
    const targets = { intents: I, tenders: { [T]: [STABLE, ASSET] as [string, string] } };
    const relayer = (await mk("relayer", "20")).acct;
    const relayed = await submitRelay(relayer, provider, I, signed, checkRelay(signed, targets));
    const evmOrder = await view(provider, T, "get_order", { order_id: relayed.orderId });
    check(
      "the relayer paid the gas and the 0x account's storage; tender saw the 0x account as the client",
      relayed.storagePaid && evmOrder.client === evm && evmOrder.status === "Open" && (await mtBal(evm)) === 0n,
      `execute_intents tx ${relayed.txHash}, order #${relayed.orderId}`,
    );
    const misdirected = JSON.parse(payload);
    misdirected.intents[0].receiver_id = client.acct.accountId;
    let misrouted = "";
    try {
      checkRelay(signErc191(JSON.stringify(misdirected), sk), targets);
    } catch (e) {
      misrouted = (e as Error).message;
    }
    const replay = await rejects(submitRelay(relayer, provider, I, signed, checkRelay(signed, targets)), "nonce");
    check("the relay refuses a transfer to an account that is not a tender, and intents.near a replayed intent", misrouted.includes("receiver_id") && replay !== null && !replay.startsWith("unexpected"), `${misrouted}; ${replay}`);
    const re12 = await swarm.runOrder(relayed.orderId);
    check("the 0x account's order filled, at least the market reference", re12.order.status === "Filled" && BigInt(re12.order.out) >= evmRef, `${fmtNear(re12.order.out)} NEAR for 40 USDC`);
    // The server's keeper does this on every order_filled and order_refunded event (ts/src/server.ts).
    const keeper = new Payouts(
      (t, c) => call(relayer, t, "withdraw_to_intents", { account_id: c }, 0n, TGAS(100)),
      async (t, c) => (await view(provider, t, "firm_id_of", { account_id: c })) !== null,
    );
    keeper.push(T, evm);
    keeper.push(T, firms[0].account); // a firm account: skipped
    for (let i = 0; i < 100 && keeper.pending; i++) await sleep(100);
    const evmNear = BigInt(await view(provider, I, "mt_balance_of", { account_id: evm, token_id: ASSET }));
    check(
      "the keeper paid the fill back to the 0x account in NEAR Intents (withdraw_to_intents)",
      evmNear === BigInt(re12.order.out) && BigInt(await view(provider, T, "asset_balance_of", { account_id: evm })) === 0n,
      `${fmtNear(evmNear)} wNEAR on ${evm} in intents.near, 0 left in tender`,
    );

    section("P&L per firm (on-chain)");
    for (const f of await view(provider, T, "get_firms")) {
      const name = firms.find((x) => x.id === f.id)?.strategy.name ?? (f.id === o1Shell.id ? "o1 shell" : "open firm");
      console.log(
        `  #${f.id} ${name.padEnd(17)} ${f.status.padEnd(11)} NAV ${fmt(await navOf(f.id)).padStart(7)}  fills ${String(f.fills).padStart(2)}  volume ${fmt(f.volume).padStart(6)}  edge ${fmt(f.edge).padStart(6)}  dividends ${fmt(f.dividends).padStart(5)}  slashed ${fmt(f.slashed)}  owner ${f.owner}`,
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
