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
        });
        let mut t = T { c, t: 1_000 * SEC };
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
        let id = self.c.post_job(PostJob { budget: U128(budget), brief: "translate README".into(), commit_secs: 2, reveal_secs: 2, deliver_secs: 60 });
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
    assert_eq!(t.bal("o3.near"), 90 * USDC + 11 * USDC - 220_000 - USDC, "rest to old shareholders");
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
    t.as_("o1.near", 0);
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
