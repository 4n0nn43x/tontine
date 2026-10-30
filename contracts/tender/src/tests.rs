use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const USDC: u128 = 1_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(who: &str, yocto: u128, t: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("tender.near"))
        .predecessor_account_id(acc(who))
        .signer_account_id(acc(who))
        .block_timestamp(t)
        .attached_deposit(NearToken::from_yoctonear(yocto));
    testing_env!(b.build());
}

struct T {
    c: Tender,
    t: u64,
}

impl T {
    fn new() -> Self {
        ctx("admin.near", 0, 1_000 * SEC);
        let c = Tender::new(Config {
            admin: acc("admin.near"),
            judge: acc("judge.near"),
            payment: Payment::Ft { token: acc("usdc.near") },
            dividend_bps: 3000,
            liquidation_fee_bps: 200,
            min_bond: U128(5 * USDC),
            slash: U128(5 * USDC),
            treasury_floor: U128(2 * USDC),
            epochs_before_liquidation: 2,
            epoch_secs: 10,
            liquidation_commit_secs: 2,
            liquidation_reveal_secs: 2,
            // Fees and keeper rewards are off here so the base tests keep their figures; see the fee tests.
            job_fee_bps: 0,
            trade_fee_bps: 0,
            keeper_reward: U128(0),
            dispute_bond: U128(0),
            eval_stake: U128(0),
            panel_size: 0,
            vote_secs: 0,
        });
        let mut t = T { c, t: 1_000 * SEC };
        // Every caller now prepays the storage it creates (storage_deposit, NEP-145 style).
        for who in [
            "o1.near", "o2.near", "o3.near", "o4.near", "nobond.near", "client.near", "lender.near", "payer.near",
            "x.near", "investor.near", "anyone.near", "w1.tender.near", "w2.tender.near", "w3.tender.near",
        ] {
            ctx(who, 10 * 10u128.pow(24), t.t);
            t.c.storage_deposit(None);
        }
        ctx("admin.near", 0, t.t);
        // Five firms: w1..w4 owned by distinct owners, w5 shares owner o1 with w1 (shill test).
        for (w, o) in [("w1", "o1"), ("w2", "o2"), ("w3", "o3"), ("w4", "o4"), ("w5", "o1")] {
            t.c.register_firm(acc(&format!("{w}.tender.near")), acc(&format!("{o}.near")));
        }
        for o in ["o1", "o2", "o3", "o4", "client.near", "lender.near"] {
            let o = if o.contains('.') { o.to_string() } else { format!("{o}.near") };
            t.deposit(&o, 100 * USDC);
            if !o.starts_with("client") && !o.starts_with("lender") {
                t.as_(&o, 1);
                t.c.deposit_bond(U128(10 * USDC));
            }
        }
        t
    }

    /// Set predecessor, attached yocto, and the current fake clock.
    fn as_(&mut self, who: &str, yocto: u128) {
        ctx(who, yocto, self.t);
    }

    fn wait(&mut self, secs: u64) {
        self.t += secs * SEC;
        self.as_("anyone.near", 0);
    }

    fn deposit(&mut self, who: &str, amount: u128) {
        self.as_("usdc.near", 0);
        let _ = self.c.ft_on_transfer(acc(who), U128(amount), String::new());
    }

    fn bal(&self, who: &str) -> u128 {
        self.c.balance_of(acc(who)).0
    }

    fn post(&mut self, budget: u128) -> (u64, u64) {
        self.as_("client.near", 1);
        let id = self.c.post_job(PostJob { budget: U128(budget), brief: "translate README".into(), commit_secs: 2, reveal_secs: 2, deliver_secs: 60, criteria: String::new(), verify: Verify::Judge });
        (id, self.c.get_job(id).auction)
    }

    fn bid(&mut self, auction: u64, firm: u32, owner: &str, amount: u128) {
        self.as_(owner, 0);
        self.c.commit_bid(auction, firm, bid_hash(amount, &format!("s{firm}")));
    }

    fn reveal(&mut self, auction: u64, firm: u32, owner: &str, amount: u128) {
        self.as_(owner, 0);
        self.c.reveal_bid(auction, firm, U128(amount), format!("s{firm}"));
    }
}

/// Full job cycle: reverse Vickrey, second price, 70/30 split, dividends claimable by holders.
#[test]
fn reverse_vickrey_pays_second_price_and_dividends() {
    let mut t = T::new();
    let (job, a) = t.post(10 * USDC);
    assert_eq!(t.bal("client.near"), 90 * USDC);
    t.bid(a, 0, "o1.near", 6 * USDC);
    t.bid(a, 1, "o2.near", 4 * USDC);
    t.bid(a, 2, "o3.near", 8 * USDC);
    t.wait(2);
    t.reveal(a, 0, "o1.near", 6 * USDC);
    t.reveal(a, 1, "o2.near", 4 * USDC);
    t.reveal(a, 2, "o3.near", 8 * USDC);
    t.wait(2);
    t.c.settle(a);
    let au = t.c.get_auction(a);
    assert_eq!(au.winner, Some(1));
    assert_eq!(au.price.unwrap().0, 6 * USDC, "winner paid the second-lowest price");
    assert_eq!(t.bal("client.near"), 94 * USDC, "client refunded budget minus price");

    t.as_("w2.tender.near", 0);
    t.c.deliver(job, "ipfs://result".into());
    t.as_("judge.near", 0);
    t.c.verdict(job, true, "{\"signature\":\"0x..\"}".into());
    assert_eq!(t.c.get_job(job).status, JobStatus::Paid);
    assert_eq!(t.bal("w2.tender.near"), 4_200_000, "70% to the firm");
    assert_eq!(t.c.pending_dividends(1, acc("o2.near")).0, 1_800_000, "30% to holders");

    // Holder sells 40 shares; dividends already accrued stay with the seller.
    t.as_("o2.near", 1);
    t.c.mt_transfer(acc("investor.near"), "1".into(), U128(40), None, None);
    assert_eq!(t.bal("o2.near"), 90 * USDC + 1_800_000);
    assert_eq!(t.c.mt_balance_of(acc("investor.near"), "1".into()).0, 40);
    assert_eq!(t.c.get_firm(1).delivered, 1);
}

#[test]
fn single_bid_paid_at_budget() {
    let mut t = T::new();
    let (_, a) = t.post(10 * USDC);
    t.bid(a, 0, "o1.near", 3 * USDC);
    t.wait(2);
    t.reveal(a, 0, "o1.near", 3 * USDC);
    t.wait(2);
    t.c.settle(a);
    assert_eq!(t.c.get_auction(a).price.unwrap().0, 10 * USDC);
}

#[test]
#[should_panic(expected = "one bid per owner (anti-shill)")]
fn anti_shill_one_bid_per_owner() {
    let mut t = T::new();
    let (_, a) = t.post(10 * USDC);
    t.bid(a, 0, "o1.near", 6 * USDC);
    // o1 also owns w5 (id 4): a second bid would let o1 push the second price up.
    t.bid(a, 4, "o1.near", 9 * USDC);
}

#[test]
#[should_panic(expected = "owner bond too low")]
fn bid_requires_bond() {
    let mut t = T::new();
    t.as_("admin.near", 0);
    t.c.register_firm(acc("w6.tender.near"), acc("nobond.near"));
    let (_, a) = t.post(10 * USDC);
    t.bid(a, 5, "nobond.near", 1);
}

#[test]
#[should_panic(expected = "hash mismatch")]
fn reveal_must_match_commit() {
    let mut t = T::new();
    let (_, a) = t.post(10 * USDC);
    t.bid(a, 0, "o1.near", 6 * USDC);
    t.wait(2);
    t.reveal(a, 0, "o1.near", 5 * USDC);
}

#[test]
#[should_panic(expected = "commit phase over")]
fn no_commit_after_deadline() {
    let mut t = T::new();
    let (_, a) = t.post(10 * USDC);
    t.wait(2);
    t.bid(a, 0, "o1.near", 6 * USDC);
}

#[test]
fn rejected_delivery_slashes_bond_and_refunds_client() {
    let mut t = T::new();
    let (job, a) = t.post(10 * USDC);
    t.bid(a, 2, "o3.near", 7 * USDC);
    t.wait(2);
    t.reveal(a, 2, "o3.near", 7 * USDC);
    t.wait(2);
    t.c.settle(a);
    // Bond locked while the job is open.
    t.as_("o3.near", 1);
    let locked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.withdraw_bond(U128(1))));
    assert!(locked.is_err());
    t.as_("w3.tender.near", 0);
    t.c.deliver(job, "".into());
    t.as_("judge.near", 0);
    t.c.verdict(job, false, "{}".into());
    assert_eq!(t.c.get_job(job).status, JobStatus::Rejected);
    assert_eq!(t.c.bond_of(acc("o3.near")).0, 5 * USDC);
    assert_eq!(t.bal("client.near"), 105 * USDC, "full refund plus slashed bond");
    let f = t.c.get_firm(2);
    assert_eq!((f.rejected, f.slashed.0), (1, 5 * USDC));
    t.as_("o3.near", 1);
    t.c.withdraw_bond(U128(5 * USDC));
}

#[test]
fn undelivered_job_expires() {
    let mut t = T::new();
    let (job, a) = t.post(10 * USDC);
    t.bid(a, 0, "o1.near", 7 * USDC);
    t.wait(2);
    t.reveal(a, 0, "o1.near", 7 * USDC);
    t.wait(2);
    t.c.settle(a);
    t.wait(61);
    t.as_("anyone.near", 0);
    t.c.expire(job);
    assert_eq!(t.c.get_job(job).status, JobStatus::Rejected);
}

#[test]
#[should_panic(expected = "judge only")]
fn only_judge_gives_verdict() {
    let mut t = T::new();
    t.as_("o1.near", 0);
    t.c.verdict(0, true, "".into());
}

#[test]
fn no_bids_cancels_and_refunds() {
    let mut t = T::new();
    let (job, a) = t.post(10 * USDC);
    t.wait(4);
    t.c.settle(a);
    assert_eq!(t.c.get_job(job).status, JobStatus::Cancelled);
    assert_eq!(t.bal("client.near"), 100 * USDC);
}

/// w3 stays under the treasury floor for 2 epochs, is auctioned, and w2 buys it at the second price.
/// Cascade: 2% fee to admin, creditor repaid, the rest to the old shareholders.
#[test]
fn liquidation_cascade_and_takeover() {
    let mut t = T::new();
    for w in ["w1", "w2", "w4", "w5"] {
        t.as_("admin.near", 1);
        t.c.balances.insert(acc(&format!("{w}.tender.near")), 50 * USDC);
    }
    t.as_("lender.near", 1);
    t.c.lend(2, U128(USDC)); // w3 owes 1 USDC, treasury 1 USDC < floor 2
    for _ in 0..2 {
        t.wait(10);
        t.as_("anyone.near", 0);
        t.c.epoch_tick();
    }
    let f = t.c.get_firm(2);
    assert_eq!(f.status, FirmStatus::Liquidating);
    let a = f.liquidation_auction.unwrap();
    // Owner o3 cannot buy back its own firm.
    t.as_("o3.near", 0);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.commit_bid(a, 2, "0".repeat(64)))).is_err());

    t.bid(a, 1, "o2.near", 20 * USDC);
    t.bid(a, 3, "o4.near", 11 * USDC);
    t.wait(2);
    t.reveal(a, 1, "o2.near", 20 * USDC);
    t.reveal(a, 3, "o4.near", 11 * USDC);
    t.wait(2);
    t.c.settle(a);

    let f = t.c.get_firm(2);
    assert_eq!(f.owner, acc("o2.near"));
    assert_eq!(f.status, FirmStatus::Solvent);
    assert_eq!(t.c.mt_balance_of(acc("w2.tender.near"), "2".into()).0, 100);
    assert_eq!(t.bal("w2.tender.near"), 39 * USDC, "buyer pays the second price (11)");
    assert_eq!(t.bal("w4.tender.near"), 50 * USDC, "loser refunded");
    assert_eq!(t.bal("admin.near"), 220_000, "2% fee");
    assert_eq!(t.bal("lender.near"), 99 * USDC + USDC, "creditor repaid first");
    // w3's remaining treasury (the 1 USDC loan) is sold with the firm and joins the pot (finding F4):
    // price 11 + treasury 1 - fee 0.22 - creditor 1 goes to the old shareholders.
    assert_eq!(t.bal("o3.near"), 90 * USDC + 11 * USDC + USDC - 220_000 - USDC, "rest to old shareholders");
    assert_eq!(t.bal("w3.tender.near"), 0, "treasury left the firm with the sale");
}

#[test]
fn mt_on_transfer_credits_intents_deposits() {
    let mut t = T::new();
    t.c.config.payment = Payment::Intents { contract: acc("intents.near"), token_id: "nep141:usdc.near".into() };
    t.as_("intents.near", 0);
    let r = t.c.mt_on_transfer(acc("payer.near"), vec![acc("payer.near")], vec!["nep141:usdc.near".into()], vec![U128(USDC)], String::new());
    assert!(matches!(r, PromiseOrValue::Value(ref v) if v[0].0 == 0));
    assert_eq!(t.bal("payer.near"), USDC);
}

#[test]
#[should_panic(expected = "wrong mt contract")]
fn mt_on_transfer_rejects_impostor() {
    let mut t = T::new();
    t.c.config.payment = Payment::Intents { contract: acc("intents.near"), token_id: "nep141:usdc.near".into() };
    t.as_("fake-intents.near", 0);
    let _ = t.c.mt_on_transfer(acc("x.near"), vec![acc("x.near")], vec!["nep141:usdc.near".into()], vec![U128(USDC)], String::new());
}

#[test]
fn deposit_msg_posts_job() {
    let mut t = T::new();
    t.as_("usdc.near", 0);
    let msg = r#"{"PostJob":{"budget":"5000000","brief":"x","commit_secs":2,"reveal_secs":2,"deliver_secs":30}}"#;
    let _ = t.c.ft_on_transfer(acc("payer.near"), U128(5 * USDC), msg.into());
    assert_eq!(t.c.get_job(0).client, acc("payer.near"));
    assert_eq!(t.bal("payer.near"), 0);
}

#[test]
fn share_market_buy() {
    let mut t = T::new();
    t.as_("o1.near", 1);
    t.c.list_shares(0, 10, U128(USDC));
    t.as_("client.near", 1);
    t.c.buy_shares(0, acc("o1.near"), 10);
    assert_eq!(t.c.mt_balance_of(acc("client.near"), "0".into()).0, 10);
    assert_eq!(t.bal("o1.near"), 90 * USDC + 10 * USDC);
    assert!(t.c.get_ask(0, acc("o1.near")).is_none());
}

#[test]
fn failed_withdraw_is_refunded() {
    let mut t = T::new();
    t.as_("tender.near", 0);
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("tender.near")).predecessor_account_id(acc("tender.near"));
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![near_sdk::PromiseResult::Failed]
    );
    assert!(!t.c.on_withdraw(acc("o1.near"), U128(USDC)));
    assert_eq!(t.bal("o1.near"), 91 * USDC);
}

#[test]
fn bid_hash_vector() {
    ctx("a.near", 0, 0);
    // Same vector is asserted in ts/src/swarm.test.ts: the off-chain commit must match the contract.
    assert_eq!(bid_hash(6_000_000, "s0"), "bb0041d21898d7bb4e1c67959ec2beaa5e433ead7084e524f13dfc179744f9fd");
}

// ---- regressions from the security review

fn won_job(t: &mut T, firm: u32, owner: &str) -> u64 {
    let (job, a) = t.post(10 * USDC);
    t.bid(a, firm, owner, 7 * USDC);
    t.wait(2);
    t.reveal(a, firm, owner, 7 * USDC);
    t.wait(2);
    t.c.settle(a);
    job
}

#[test]
#[should_panic(expected = "deliver_secs out of range")]
fn huge_deliver_secs_refused() {
    let mut t = T::new();
    t.as_("client.near", 1);
    t.c.post_job(PostJob { budget: U128(1), brief: "x".into(), commit_secs: 2, reveal_secs: 2, deliver_secs: 20_000_000_000, criteria: String::new(), verify: Verify::Judge });
}

#[test]
#[should_panic(expected = "firm in liquidation")]
fn no_loans_to_a_firm_in_liquidation() {
    let mut t = T::new();
    t.c.firms.get_mut(2).unwrap().status = FirmStatus::Liquidating;
    t.as_("lender.near", 1);
    t.c.lend(2, U128(USDC));
}

#[test]
fn lock_and_slash_follow_the_owner_who_bid() {
    let mut t = T::new();
    let job = won_job(&mut t, 2, "o3.near");
    assert_eq!(t.c.get_job(job).winner_owner, Some(acc("o3.near")));
    // The firm is sold to o2 before the job resolves.
    t.c.firms.get_mut(2).unwrap().owner = acc("o2.near");
    t.wait(61);
    t.c.expire(job);
    assert_eq!(t.c.bond_of(acc("o3.near")).0, 5 * USDC, "slash hits the owner who bid");
    assert_eq!(t.c.bond_of(acc("o2.near")).0, 10 * USDC, "new owner untouched");
    t.as_("o3.near", 1);
    t.c.withdraw_bond(U128(5 * USDC)); // lock released on the right owner
}

#[test]
fn delivered_job_without_verdict_times_out_without_slash() {
    let mut t = T::new();
    let job = won_job(&mut t, 0, "o1.near");
    t.as_("w1.tender.near", 0);
    t.c.deliver(job, "work".into());
    t.wait(60 + JUDGE_TIMEOUT_SECS + 1);
    t.c.expire(job);
    assert_eq!(t.c.get_job(job).status, JobStatus::Cancelled);
    assert_eq!(t.bal("client.near"), 100 * USDC);
    assert_eq!(t.c.bond_of(acc("o1.near")).0, 10 * USDC);
}

#[test]
#[should_panic(expected = "firm already bid")]
fn one_bid_per_firm_even_after_a_sale() {
    let mut t = T::new();
    let (_, a) = t.post(10 * USDC);
    t.bid(a, 2, "o3.near", 6 * USDC);
    t.c.firms.get_mut(2).unwrap().owner = acc("o2.near");
    t.bid(a, 2, "o2.near", 5 * USDC);
}

#[test]
fn dividend_rounding_never_pays_more_than_distributed() {
    let mut t = T::new();
    let mut f = t.c.firm(0);
    Tender::distribute(&mut f, 1);
    t.c.save_firm(f);
    let before = t.bal("o1.near") + t.bal("x.near");
    t.as_("o1.near", 1);
    t.c.mt_transfer(acc("x.near"), "0".into(), U128(50), None, None);
    let mut f = t.c.firm(0);
    Tender::distribute(&mut f, 1);
    t.c.save_firm(f);
    for who in ["o1.near", "x.near"] {
        t.as_(who, 1);
        t.c.claim_dividends(0);
    }
    assert!(t.bal("o1.near") + t.bal("x.near") - before <= 2, "paid at most the 2 units distributed");
}

#[test]
#[should_panic(expected = "ask voided by a takeover")]
fn takeover_voids_old_asks() {
    let mut t = T::new();
    t.as_("o1.near", 1);
    t.c.list_shares(0, 10, U128(USDC));
    t.c.firms.get_mut(0).unwrap().takeovers += 1;
    t.as_("client.near", 1);
    t.c.buy_shares(0, acc("o1.near"), 10);
}

#[test]
fn failed_owner_sync_can_be_retried() {
    let mut t = T::new();
    {
        let f = t.c.firms.get_mut(2).unwrap();
        f.owner = acc("o2.near");
        f.owner_synced = false;
    }
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("tender.near")).predecessor_account_id(acc("tender.near"));
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![near_sdk::PromiseResult::Failed]
    );
    assert!(!t.c.on_set_owner(2, acc("o2.near")));
    assert!(!t.c.get_firm(2).owner_synced);
    t.as_("anyone.near", 0);
    let _ = t.c.sync_owner(2);
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![near_sdk::PromiseResult::Successful(vec![])]
    );
    assert!(t.c.on_set_owner(2, acc("o2.near")));
    assert!(t.c.get_firm(2).owner_synced);
}

/// F4 PoC: a lone takeover bid at the reserve (1 base unit) buys the firm's remaining treasury,
/// while the creditor who funded that treasury gets nothing.
#[test]
fn poc_f4_lone_buyer_takes_the_treasury_creditor_gets_nothing() {
    let mut t = T::new();
    for w in ["w1", "w2", "w4", "w5"] {
        t.c.balances.insert(acc(&format!("{w}.tender.near")), 50 * USDC);
    }
    // w3 has 1.99 USDC of treasury, all of it lent by `lender` (floor is 2).
    t.as_("lender.near", 1);
    t.c.lend(2, U128(1_990_000));
    for _ in 0..2 {
        t.wait(10);
        t.c.epoch_tick();
    }
    let a = t.c.get_firm(2).liquidation_auction.unwrap();
    t.bid(a, 1, "o2.near", 1);
    t.wait(2);
    t.reveal(a, 1, "o2.near", 1);
    t.wait(2);
    let lender_before = t.bal("lender.near");
    t.c.settle(a);
    let creditor_got = t.bal("lender.near") - lender_before;
    let treasury_kept = t.bal("w3.tender.near");
    println!("price 1 unit, creditor repaid {creditor_got} of 1990000, treasury left to the buyer {treasury_kept}");
    assert!(creditor_got >= 1_990_000 - 1, "creditor must be repaid from the treasury: got {creditor_got}");
}

// ---------------------------------------------------------------- open firms, fees, loans, keepers

const PK1: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
const PK2: &str = "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847";

fn keys() -> Vec<PublicKey> {
    vec![PK1.parse().unwrap(), PK2.parse().unwrap()]
}

fn with_fees() -> T {
    let mut t = T::new();
    t.c.config.job_fee_bps = 100;
    t.c.config.trade_fee_bps = 50;
    t.c.config.keeper_reward = U128(20_000);
    t
}

#[test]
fn anyone_creates_a_firm_and_owns_its_shares() {
    let mut t = T::new();
    t.as_("investor.near", 2 * 10u128.pow(24));
    let no_code = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        t.c.create_firm(keys(), U128(20 * USDC), U128(USDC), 3600);
    }));
    assert!(no_code.is_err(), "no firm code stored yet");
    t.as_("admin.near", 0);
    t.c.set_firm_code(Base64VecU8(vec![0, 97, 115, 109]));
    t.as_("investor.near", 10u128.pow(24));
    let cheap = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        t.c.create_firm(keys(), U128(20 * USDC), U128(USDC), 3600);
    }));
    assert!(cheap.is_err(), "1 NEAR does not cover the account");
    t.as_("investor.near", 2 * 10u128.pow(24));
    let id = t.c.create_firm(keys(), U128(20 * USDC), U128(USDC), 3600);
    let f = t.c.get_firm(id);
    assert_eq!(id, 5);
    assert_eq!(f.account, acc("w6.tender.near"));
    assert_eq!(f.owner, acc("investor.near"));
    assert_eq!(t.c.mt_balance_of(acc("investor.near"), id.to_string()).0, 100);
    // The creator can sell part of its firm at once.
    t.as_("investor.near", 1);
    t.c.list_shares(id, 40, U128(USDC / 2));
    assert_eq!(t.c.get_ask(id, acc("investor.near")).unwrap().amount, 40);
}

#[test]
fn only_admin_sets_firm_code() {
    let mut t = T::new();
    t.as_("x.near", 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.set_firm_code(Base64VecU8(vec![1]))));
    assert!(r.is_err());
}

#[test]
fn job_fee_goes_to_tontine_before_the_dividend_split() {
    let mut t = with_fees();
    let job = won_job(&mut t, 1, "o2.near"); // alone: paid the 10 USDC budget
    t.as_("w2.tender.near", 0);
    t.c.deliver(job, "done".into());
    t.as_("judge.near", 0);
    t.c.verdict(job, true, "{}".into());
    assert_eq!(t.bal("admin.near"), 100_000, "1% of 10 USDC");
    assert_eq!(t.c.pending_dividends(1, acc("o2.near")).0, 2_970_000, "30% of the 9.90 left");
    assert_eq!(t.bal("w2.tender.near"), 6_930_000, "70% of the 9.90 left");
}

#[test]
fn share_sale_fee_comes_out_of_the_seller_proceeds() {
    let mut t = with_fees();
    t.as_("o1.near", 1);
    t.c.list_shares(0, 10, U128(USDC));
    t.as_("client.near", 1);
    t.c.buy_shares(0, acc("o1.near"), 10);
    assert_eq!(t.bal("client.near"), 90 * USDC, "buyer pays the asked price");
    assert_eq!(t.bal("o1.near"), 90 * USDC + 9_950_000, "seller gets 99.5%");
    assert_eq!(t.bal("admin.near"), 50_000, "0.5% to Tontine");
}

#[test]
fn loans_follow_the_owner_terms_and_earn_interest() {
    let mut t = T::new();
    t.as_("lender.near", 1);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.set_loan_terms(2, 1000, U128(5 * USDC))));
    assert!(r.is_err(), "only the owner sets the terms");
    t.as_("o3.near", 1);
    t.c.set_loan_terms(2, 1000, U128(5 * USDC)); // 10% a year, at most 5 USDC owed
    t.as_("lender.near", 1);
    let over = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.lend(2, U128(6 * USDC))));
    assert!(over.is_err(), "over the cap");
    t.as_("lender.near", 1);
    t.c.lend(2, U128(2 * USDC));
    assert_eq!(t.c.get_firm(2).debts[0].rate_bps, 1000);
    t.wait(365 * 86_400);
    t.as_("o3.near", 1);
    t.c.repay(2, U128(2 * USDC));
    assert_eq!(t.bal("lender.near"), 98 * USDC + 2 * USDC, "2 USDC repaid, interest still owed");
    assert_eq!(t.c.get_firm(2).debts[0].principal.0, 200_000, "a year at 10% on 2 USDC");
    t.c.balances.insert(acc("w3.tender.near"), USDC);
    t.as_("o3.near", 1);
    t.c.repay(2, U128(USDC));
    assert_eq!(t.bal("lender.near"), 100 * USDC + 200_000, "interest paid");
    assert!(t.c.get_firm(2).debts.is_empty());
}

#[test]
fn loans_without_terms_stay_at_zero_interest() {
    let mut t = T::new();
    t.as_("lender.near", 1);
    t.c.lend(2, U128(USDC));
    t.wait(365 * 86_400);
    t.as_("o3.near", 1);
    t.c.repay(2, U128(USDC));
    assert_eq!(t.bal("lender.near"), 100 * USDC);
    assert!(t.c.get_firm(2).debts.is_empty());
}

#[test]
fn keepers_are_paid_from_tontine_fees_when_there_are_any() {
    let mut t = with_fees();
    t.deposit("payer.near", USDC); // a keeper needs a ledger entry to be paid
    let (job, a) = t.post(10 * USDC);
    t.bid(a, 1, "o2.near", 7 * USDC);
    t.wait(2);
    t.reveal(a, 1, "o2.near", 7 * USDC);
    t.wait(2);
    t.as_("payer.near", 0);
    t.c.settle(a);
    assert_eq!(t.bal("payer.near"), USDC, "no fees collected yet: no reward, no failure");
    t.as_("w2.tender.near", 0);
    t.c.deliver(job, "done".into());
    t.as_("judge.near", 0);
    t.c.verdict(job, true, "{}".into());
    t.wait(10);
    t.as_("payer.near", 0);
    t.c.epoch_tick();
    assert_eq!(t.bal("payer.near"), USDC + 20_000, "0.02 USDC for the epoch tick");
    assert_eq!(t.bal("admin.near"), 100_000 - 20_000, "paid out of the 1% job fee");
    t.wait(10);
    t.as_("anyone.near", 0);
    t.c.epoch_tick();
    assert_eq!(t.bal("anyone.near"), 0, "no ledger entry: not paid, nothing stored");
}

// ---------------------------------------------------------------- optimistic review and evaluator disputes

fn with_disputes() -> T {
    let mut t = T::new();
    t.c.config.dispute_bond = U128(USDC);
    t.c.config.eval_stake = U128(USDC);
    t.c.config.vote_secs = 5;
    t
}

/// Optimistic job won alone by firm 1 (owner o2) at the 10 USDC budget, then delivered.
fn delivered_optimistic(t: &mut T, result: &str) -> u64 {
    t.as_("client.near", 1);
    let job = t.c.post_job(PostJob {
        budget: U128(10 * USDC),
        brief: "translate README to Spanish".into(),
        commit_secs: 2,
        reveal_secs: 2,
        deliver_secs: 60,
        criteria: "must include: hola".into(),
        verify: Verify::Optimistic { review_secs: 10 },
    });
    let a = t.c.get_job(job).auction;
    t.bid(a, 1, "o2.near", 7 * USDC);
    t.wait(2);
    t.reveal(a, 1, "o2.near", 7 * USDC);
    t.wait(2);
    t.c.settle(a);
    t.as_("w2.tender.near", 0);
    t.c.deliver(job, result.into());
    job
}

/// Each panel member votes (None = commits nothing), then the vote phases run out.
fn vote(t: &mut T, job: u64, votes: &[Option<bool>]) {
    let panel = t.c.get_dispute(job).unwrap().panel;
    for (b, v) in panel.iter().zip(votes) {
        if let Some(v) = v {
            t.as_(b.owner.as_str(), 0);
            t.c.commit_vote(job, b.firm_id, vote_hash(*v, "salt"));
        }
    }
    t.wait(5);
    for (b, v) in panel.iter().zip(votes) {
        if let Some(v) = v {
            t.as_(b.owner.as_str(), 0);
            t.c.reveal_vote(job, b.firm_id, *v, "salt".into());
        }
    }
    t.wait(5);
}

fn bond(t: &T, who: &str) -> u128 {
    t.c.bond_of(acc(who)).0
}

#[test]
fn client_accepts_and_the_firm_is_paid_at_once() {
    let mut t = with_disputes();
    let job = delivered_optimistic(&mut t, "hola mundo");
    assert_eq!(t.c.get_job(job).criteria, "must include: hola");
    t.as_("x.near", 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.accept_delivery(job))).is_err(), "client only");
    t.as_("client.near", 1);
    t.c.accept_delivery(job);
    assert_eq!(t.c.get_job(job).status, JobStatus::Paid);
    assert_eq!(t.bal("w2.tender.near"), 7 * USDC);
}

#[test]
fn silence_pays_the_firm_after_the_review_window() {
    let mut t = with_disputes();
    let job = delivered_optimistic(&mut t, "hola mundo");
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.finalize(job))).is_err(), "window still open");
    t.wait(11);
    t.c.finalize(job);
    assert_eq!(t.c.get_job(job).status, JobStatus::Paid);
    t.as_("client.near", 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.dispute(job))).is_err(), "too late to dispute");
}

#[test]
fn only_the_client_disputes_and_only_in_the_window() {
    let mut t = with_disputes();
    let job = delivered_optimistic(&mut t, "hola");
    t.as_("x.near", 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.dispute(job))).is_err(), "client only");
    t.wait(11);
    t.as_("client.near", 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.dispute(job))).is_err(), "window closed");
}

#[test]
fn panel_rejects_an_empty_delivery_and_the_loser_pays_the_evaluators() {
    let mut t = with_disputes();
    let job = delivered_optimistic(&mut t, "");
    t.as_("client.near", 1);
    t.c.dispute(job);
    assert_eq!(t.bal("client.near"), 89 * USDC, "1 USDC dispute bond");
    let mut ids: Vec<u32> = t.c.get_dispute(job).unwrap().panel.iter().map(|b| b.firm_id).collect();
    ids.sort();
    assert_eq!(ids, vec![0, 2, 3], "one firm per owner, neither the client nor the winner's owner");
    vote(&mut t, job, &[Some(false), Some(false), Some(false)]);
    t.c.resolve_dispute(job);
    assert_eq!(t.c.get_job(job).status, JobStatus::Rejected);
    assert_eq!(t.bal("client.near"), 100 * USDC, "price and bond back");
    assert_eq!(bond(&t, "o2.near"), 5 * USDC, "winner owner slashed 5 USDC");
    for w in ["w1", "w3", "w4"] {
        assert_eq!(t.bal(&format!("{w}.tender.near")), 1_666_666, "the slash split between the 3 evaluators");
    }
}

#[test]
fn panel_accepts_good_work_and_the_minority_loses_its_stake() {
    let mut t = with_disputes();
    let job = delivered_optimistic(&mut t, "hola mundo");
    t.as_("client.near", 1);
    t.c.dispute(job);
    let panel = t.c.get_dispute(job).unwrap().panel;
    vote(&mut t, job, &[Some(true), Some(true), Some(false)]);
    t.c.resolve_dispute(job);
    assert_eq!(t.c.get_job(job).status, JobStatus::Paid);
    assert_eq!(t.bal("w2.tender.near"), 7 * USDC);
    assert_eq!(t.bal("client.near"), 89 * USDC, "client's bond lost");
    assert_eq!(bond(&t, panel[2].owner.as_str()), 9 * USDC, "minority evaluator lost its 1 USDC stake");
    for b in &panel[..2] {
        assert_eq!(t.bal(t.c.get_firm(b.firm_id).account.as_str()), USDC, "bond + minority stake split by the majority");
    }
}

#[test]
fn a_silent_evaluator_is_slashed_and_a_tie_keeps_the_delivery() {
    let mut t = with_disputes();
    let job = delivered_optimistic(&mut t, "hola mundo");
    t.as_("client.near", 1);
    t.c.dispute(job);
    let panel = t.c.get_dispute(job).unwrap().panel;
    vote(&mut t, job, &[Some(true), Some(false), None]);
    t.c.resolve_dispute(job);
    assert_eq!(t.c.get_job(job).status, JobStatus::Paid, "tie: the delivery stands");
    assert_eq!(t.bal("client.near"), 90 * USDC, "no majority: dispute bond refunded");
    assert_eq!(bond(&t, panel[2].owner.as_str()), 9 * USDC, "silent evaluator slashed");
    assert_eq!(bond(&t, panel[0].owner.as_str()), 10 * USDC);
    assert_eq!(t.bal("admin.near"), USDC, "no majority to pay: the stake goes to Tontine");
}

#[test]
fn votes_are_sealed_and_only_panel_members_vote() {
    let mut t = with_disputes();
    let job = delivered_optimistic(&mut t, "hola");
    t.as_("client.near", 1);
    t.c.dispute(job);
    let b = t.c.get_dispute(job).unwrap().panel[0].clone();
    t.as_("o2.near", 0);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.commit_vote(job, 1, vote_hash(true, "s")))).is_err(), "the winner is not on the panel");
    t.as_(b.owner.as_str(), 0);
    t.c.commit_vote(job, b.firm_id, vote_hash(true, "s"));
    t.wait(5);
    t.as_(b.owner.as_str(), 0);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.reveal_vote(job, b.firm_id, false, "s".into()))).is_err(), "reveal must match the commit");
}

#[test]
fn no_eligible_evaluator_falls_back_to_the_judge() {
    let mut t = with_disputes();
    t.c.config.eval_stake = U128(100 * USDC); // no owner has that much bonded
    let job = delivered_optimistic(&mut t, "");
    t.as_("client.near", 1);
    t.c.dispute(job);
    assert!(t.c.get_dispute(job).unwrap().panel.is_empty());
    t.as_("judge.near", 0);
    t.c.verdict(job, false, "{}".into());
    assert_eq!(t.c.get_job(job).status, JobStatus::Rejected);
    assert_eq!(t.bal("client.near"), 105 * USDC, "price, bond and the owner's slash");
}

#[test]
fn the_judge_cannot_overrule_an_optimistic_delivery() {
    let mut t = with_disputes();
    let job = delivered_optimistic(&mut t, "hola");
    t.as_("judge.near", 0);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.verdict(job, false, "{}".into()))).is_err());
}
