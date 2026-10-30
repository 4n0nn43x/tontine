use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const USDC: u128 = 1_000_000;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

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
            payment: Payment::Ft { token: acc("usdc.near") },
            asset: Payment::Ft { token: acc("wnear.near") },
            asset_unit: U128(NEAR),
            initial_price: U128(4 * USDC),
            dividend_bps: 3000,
            liquidation_fee_bps: 200,
            min_bond: U128(5 * USDC),
            slash: U128(5 * USDC),
            treasury_floor: U128(2 * USDC),
            epochs_before_liquidation: 2,
            epoch_secs: 10,
            liquidation_commit_secs: 2,
            liquidation_reveal_secs: 2,
            // Fees, keeper rewards and the no-reveal rate are off here so the base tests keep their figures.
            order_fee_bps: 0,
            trade_fee_bps: 0,
            keeper_reward: U128(0),
            no_reveal_slash_bps: 0,
            min_bidders: 0,
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
        t.deposit_asset("client.near", 100 * NEAR);
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

    fn deposit_asset(&mut self, who: &str, amount: u128) {
        self.as_("wnear.near", 0);
        let _ = self.c.ft_on_transfer(acc(who), U128(amount), String::new());
    }

    fn bal(&self, who: &str) -> u128 {
        self.c.balance_of(acc(who)).0
    }

    fn asset(&self, who: &str) -> u128 {
        self.c.asset_balance_of(acc(who)).0
    }

    /// client.near posts an order (2 s commit, 2 s reveal).
    fn post(&mut self, side: Side, amount_in: u128, min_out: u128) -> (u64, u64) {
        self.as_("client.near", 1);
        let id = self.c.post_order(PostOrder { side, amount_in: U128(amount_in), min_out: U128(min_out), reference_out: None, commit_secs: 2, reveal_secs: 2 });
        (id, self.c.get_order(id).auction)
    }

    fn bid(&mut self, auction: u64, firm: u32, owner: &str, amount: u128) {
        self.as_(owner, 0);
        self.c.commit_bid(auction, firm, bid_hash(amount, &format!("s{firm}")));
    }

    fn reveal(&mut self, auction: u64, firm: u32, owner: &str, amount: u128) {
        self.as_(owner, 0);
        self.c.reveal_bid(auction, firm, U128(amount), format!("s{firm}"));
    }

    /// Commit, reveal (both phases elapse) and settle.
    fn run(&mut self, auction: u64, bids: &[(u32, &str, u128)]) {
        for &(f, o, v) in bids {
            self.bid(auction, f, o, v);
        }
        self.wait(2);
        for &(f, o, v) in bids {
            self.reveal(auction, f, o, v);
        }
        self.wait(2);
        self.c.settle(auction);
    }
}

/// Firms w1..w5 get 1000 USDC and 100 NEAR of inventory (NAV 1400 USDC at 4 USDC, 29% in NEAR).
fn stock(t: &mut T) {
    for w in ["w1", "w2", "w3", "w4", "w5"] {
        t.c.balances.insert(acc(&format!("{w}.tender.near")), 1000 * USDC);
        t.c.assets.insert(acc(&format!("{w}.tender.near")), 100 * NEAR);
    }
}

fn panics(f: impl FnOnce()) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
}

// ---------------------------------------------------------------- orders

/// Buy 40 USDC of NEAR, at least 9 NEAR. Three firms bid what they deliver; the best (9.9) fills at the
/// second best (9.7), atomically. Edge against the previous price (4 USDC): 40 - 9.7 * 4 = 1.2 USDC, 30% to holders.
#[test]
fn order_fills_at_the_second_best_quote_and_pays_dividends() {
    let mut t = T::new();
    stock(&mut t);
    let (o, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    assert_eq!(t.bal("client.near"), 60 * USDC, "the client's stable is escrowed");
    t.run(a, &[(0, "o1.near", 95 * NEAR / 10), (1, "o2.near", 99 * NEAR / 10), (2, "o3.near", 97 * NEAR / 10)]);
    let au = t.c.get_auction(a);
    assert_eq!(au.winner, Some(1));
    assert_eq!(au.price.unwrap().0, 97 * NEAR / 10, "the best bid fills at the second-best amount");
    assert_eq!(t.asset("client.near"), 100 * NEAR + 97 * NEAR / 10);
    assert_eq!(t.asset("w2.tender.near"), 100 * NEAR - 97 * NEAR / 10, "winner delivered 9.7 and got the rest of its 9.9 escrow back");
    assert_eq!(t.asset("w1.tender.near"), 100 * NEAR, "losers refunded");
    assert_eq!(t.asset("w3.tender.near"), 100 * NEAR, "losers refunded");
    let f = t.c.get_firm(1);
    assert_eq!(f.edge.0, 1_200_000);
    assert_eq!((f.fills, f.volume.0), (1, 40 * USDC));
    assert_eq!(t.c.pending_dividends(1, acc("o2.near")).0, 360_000, "30% of the edge");
    assert_eq!(t.bal("w2.tender.near"), 1000 * USDC + 40 * USDC - 360_000);
    assert_eq!(t.c.get_order(o).status, OrderStatus::Filled);
    assert_eq!(t.c.get_order(o).out.unwrap().0, 97 * NEAR / 10);
    assert_eq!(t.c.get_last_price().0, 40 * USDC * NEAR / (97 * NEAR / 10));
}

#[test]
fn a_lone_bid_fills_at_the_client_minimum() {
    let mut t = T::new();
    stock(&mut t);
    let (_, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    t.run(a, &[(0, "o1.near", 95 * NEAR / 10)]);
    assert_eq!(t.c.get_auction(a).price.unwrap().0, 9 * NEAR);
    assert_eq!(t.asset("client.near"), 109 * NEAR);
}

#[test]
#[should_panic(expected = "bid below reserve")]
fn a_bid_below_the_client_minimum_is_refused() {
    let mut t = T::new();
    stock(&mut t);
    let (_, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    t.run(a, &[(0, "o1.near", 8 * NEAR)]);
}

#[test]
fn no_bid_refunds_the_client() {
    let mut t = T::new();
    let (o, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    t.run(a, &[]);
    assert_eq!(t.c.get_order(o).status, OrderStatus::Refunded);
    assert_eq!(t.bal("client.near"), 100 * USDC);
}

#[test]
fn too_few_bidders_refund_everyone() {
    let mut t = T::new();
    stock(&mut t);
    t.c.config.min_bidders = 2;
    let (o, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    t.run(a, &[(0, "o1.near", 95 * NEAR / 10)]);
    assert_eq!(t.c.get_order(o).status, OrderStatus::Refunded);
    assert_eq!(t.bal("client.near"), 100 * USDC);
    assert_eq!(t.asset("w1.tender.near"), 100 * NEAR, "the lone bidder's escrow is returned");
}

#[test]
#[should_panic(expected = "one bid per owner (anti-shill)")]
fn anti_shill_one_bid_per_owner() {
    let mut t = T::new();
    let (_, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    t.bid(a, 0, "o1.near", 95 * NEAR / 10);
    // o1 also owns w5 (id 4): a second bid would let o1 push the second price up.
    t.bid(a, 4, "o1.near", 99 * NEAR / 10);
}

#[test]
#[should_panic(expected = "owner bond too low")]
fn bid_requires_bond() {
    let mut t = T::new();
    t.as_("admin.near", 0);
    t.c.register_firm(acc("w6.tender.near"), acc("nobond.near"));
    let (_, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    t.bid(a, 5, "nobond.near", 95 * NEAR / 10);
}

#[test]
#[should_panic(expected = "hash mismatch")]
fn reveal_must_match_commit() {
    let mut t = T::new();
    stock(&mut t);
    let (_, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    t.bid(a, 0, "o1.near", 95 * NEAR / 10);
    t.wait(2);
    t.reveal(a, 0, "o1.near", 96 * NEAR / 10);
}

#[test]
#[should_panic(expected = "commit phase over")]
fn no_commit_after_deadline() {
    let mut t = T::new();
    let (_, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    t.wait(2);
    t.bid(a, 0, "o1.near", 95 * NEAR / 10);
}

#[test]
#[should_panic(expected = "phase too long")]
fn huge_phases_refused() {
    let mut t = T::new();
    t.as_("client.near", 1);
    t.c.post_order(PostOrder { side: Side::Buy, amount_in: U128(USDC), min_out: U128(1), reference_out: None, commit_secs: 20_000_000_000, reveal_secs: 2 });
}

#[test]
#[should_panic(expected = "cannot fill your own order")]
fn the_client_cannot_fill_its_own_order() {
    let mut t = T::new();
    t.as_("o3.near", 1);
    let id = t.c.post_order(PostOrder { side: Side::Buy, amount_in: U128(40 * USDC), min_out: U128(9 * NEAR), reference_out: None, commit_secs: 2, reveal_secs: 2 });
    let a = t.c.get_order(id).auction;
    t.bid(a, 2, "o3.near", 95 * NEAR / 10);
}

/// A committed bid is a free option on the price unless not revealing costs something: the owner's bond
/// pays the client.
#[test]
fn an_unrevealed_bid_pays_the_client_from_the_owner_bond() {
    let mut t = T::new();
    stock(&mut t);
    t.c.config.no_reveal_slash_bps = 100; // 1% of 40 USDC = 0.4, under the 5 USDC minimum
    let (_, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    t.bid(a, 0, "o1.near", 99 * NEAR / 10); // never revealed
    t.run(a, &[(1, "o2.near", 95 * NEAR / 10)]);
    assert_eq!(t.c.get_auction(a).winner, Some(1));
    assert_eq!(t.c.bond_of(acc("o1.near")).0, 5 * USDC);
    assert_eq!(t.bal("client.near"), 60 * USDC + 5 * USDC, "the slash goes to the client");
    assert_eq!(t.c.get_firm(0).slashed.0, 5 * USDC);
    t.as_("o1.near", 1);
    t.c.withdraw_bond(U128(5 * USDC)); // its lock was released
}

/// The owner's price band is enforced by the contract: an agent told to dump its inventory (or tricked
/// into it) cannot reveal a bid far from the last price.
#[test]
fn the_price_band_blocks_an_out_of_band_bid() {
    let mut t = T::new();
    stock(&mut t);
    let (_, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    t.bid(a, 1, "o2.near", 12 * NEAR); // 3.33 USDC per NEAR, 16.7% under the last price
    t.wait(2);
    assert!(panics(|| t.reveal(a, 1, "o2.near", 12 * NEAR)), "outside the default 10% band");
    assert_eq!(t.asset("w2.tender.near"), 100 * NEAR, "nothing escrowed");
    t.as_("o2.near", 1);
    t.c.set_policy(1, Policy { max_asset_bps: 8000, band_bps: 0, paused: false });
    let (_, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    t.run(a, &[(1, "o2.near", 12 * NEAR)]);
    assert_eq!(t.c.get_auction(a).winner, Some(1), "without a band the owner takes that risk");
}

#[test]
#[should_panic(expected = "fill over the firm's inventory limit")]
fn the_inventory_limit_caps_what_a_firm_buys() {
    let mut t = T::new();
    stock(&mut t);
    t.as_("o2.near", 1);
    t.c.set_policy(1, Policy { max_asset_bps: 5000, band_bps: 1000, paused: false });
    // Sell 100 NEAR for at least 380 USDC: after the fill w2 would hold 200 NEAR (800) of a 1405 NAV.
    let (_, a) = t.post(Side::Sell, 100 * NEAR, 380 * USDC);
    t.run(a, &[(1, "o2.near", 395 * USDC)]);
}

#[test]
#[should_panic(expected = "firm paused by its owner")]
fn a_paused_firm_cannot_bid() {
    let mut t = T::new();
    t.as_("o2.near", 1);
    t.c.set_policy(1, Policy { max_asset_bps: 8000, band_bps: 1000, paused: true });
    let (_, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    t.bid(a, 1, "o2.near", 95 * NEAR / 10);
}

#[test]
#[should_panic(expected = "owner only")]
fn only_the_owner_sets_the_policy() {
    let mut t = T::new();
    t.as_("w2.tender.near", 1);
    t.c.set_policy(1, Policy { max_asset_bps: 10000, band_bps: 0, paused: false });
}

/// Sell 10 NEAR for at least 38 USDC with a 1% fee: the client gets the second best (39), Tontine takes
/// 1% of the 10 NEAR the firm receives, and the firm's edge is 9.9 * 4 - 39 = 0.6 USDC.
#[test]
fn sell_orders_pay_stable_and_the_fee_comes_out_of_what_the_firm_receives() {
    let mut t = with_fees();
    stock(&mut t);
    let (_, a) = t.post(Side::Sell, 10 * NEAR, 38 * USDC);
    assert_eq!(t.asset("client.near"), 90 * NEAR);
    t.run(a, &[(1, "o2.near", 395 * USDC / 10), (2, "o3.near", 39 * USDC)]);
    assert_eq!(t.bal("client.near"), 100 * USDC + 39 * USDC);
    assert_eq!(t.asset("w2.tender.near"), 100 * NEAR + 99 * NEAR / 10);
    assert_eq!(t.asset("admin.near"), NEAR / 10, "1% of the 10 NEAR");
    assert_eq!(t.c.get_firm(1).edge.0, 600_000);
    assert_eq!(t.c.pending_dividends(1, acc("o2.near")).0, 180_000);
    assert_eq!(t.bal("w2.tender.near"), 1000 * USDC - 39 * USDC - 180_000);
}

#[test]
fn a_losing_fill_pays_no_dividend() {
    let mut t = T::new();
    stock(&mut t);
    let (_, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    // 10.3 NEAR delivered for 40 USDC: worth 41.2 at the previous price.
    t.run(a, &[(1, "o2.near", 104 * NEAR / 10), (2, "o3.near", 103 * NEAR / 10)]);
    assert_eq!(t.c.get_firm(1).edge.0, -1_200_000);
    assert_eq!(t.c.pending_dividends(1, acc("o2.near")).0, 0);
    assert_eq!(t.bal("w2.tender.near"), 1040 * USDC);
}

#[test]
fn deposit_msg_posts_order() {
    let mut t = T::new();
    t.as_("wnear.near", 0);
    let msg = format!(r#"{{"PostOrder":{{"side":"Sell","amount_in":"{}","min_out":"38000000","commit_secs":2,"reveal_secs":2}}}}"#, 10 * NEAR);
    let _ = t.c.ft_on_transfer(acc("payer.near"), U128(10 * NEAR), msg.clone());
    assert_eq!(t.c.get_order(0).client, acc("payer.near"));
    assert_eq!(t.asset("payer.near"), 0, "the deposit is escrowed in the order");
    t.as_("usdc.near", 0);
    assert!(panics(|| {
        let _ = t.c.ft_on_transfer(acc("payer.near"), U128(10 * NEAR), msg);
    }), "a sell order needs the asset");
}

#[test]
fn mt_on_transfer_credits_intents_deposits() {
    let mut t = T::new();
    t.c.config.payment = Payment::Intents { contract: acc("intents.near"), token_id: "nep141:usdc.near".into() };
    t.c.config.asset = Payment::Intents { contract: acc("intents.near"), token_id: "nep141:wrap.near".into() };
    t.as_("intents.near", 0);
    let r = t.c.mt_on_transfer(acc("payer.near"), vec![acc("payer.near")], vec!["nep141:usdc.near".into()], vec![U128(USDC)], String::new());
    assert!(matches!(r, PromiseOrValue::Value(ref v) if v[0].0 == 0));
    assert_eq!(t.bal("payer.near"), USDC);
    let _ = t.c.mt_on_transfer(acc("payer.near"), vec![acc("payer.near")], vec!["nep141:wrap.near".into()], vec![U128(NEAR)], String::new());
    assert_eq!(t.asset("payer.near"), NEAR);
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
    assert!(!t.c.on_withdraw(acc("o1.near"), U128(USDC), false));
    assert_eq!(t.bal("o1.near"), 91 * USDC);
    assert!(!t.c.on_withdraw(acc("o1.near"), U128(NEAR), true));
    assert_eq!(t.asset("o1.near"), NEAR, "a failed asset withdrawal comes back to the asset ledger");
}

/// A firm whose treasury is under the floor but whose inventory is worth more is solvent: the floor is on
/// net asset value. When it is liquidated, the reserve is what its inventory is worth.
#[test]
fn the_floor_counts_the_inventory_and_sets_the_takeover_reserve() {
    let mut t = T::new();
    for w in ["w1", "w2", "w4", "w5"] {
        t.c.balances.insert(acc(&format!("{w}.tender.near")), 50 * USDC);
    }
    t.c.assets.insert(acc("w3.tender.near"), NEAR); // 0 USDC + 1 NEAR = 4 USDC >= floor 2
    for _ in 0..2 {
        t.wait(10);
        t.c.epoch_tick();
    }
    assert_eq!(t.c.get_firm(2).status, FirmStatus::Solvent);
    t.c.assets.insert(acc("w3.tender.near"), NEAR / 4); // worth 1 USDC
    for _ in 0..2 {
        t.wait(10);
        t.c.epoch_tick();
    }
    let f = t.c.get_firm(2);
    assert_eq!(f.status, FirmStatus::Liquidating);
    let a = f.liquidation_auction.unwrap();
    assert_eq!(t.c.get_auction(a).reserve.0, USDC, "the inventory's value");
    t.bid(a, 1, "o2.near", USDC / 2);
    t.wait(2);
    assert!(panics(|| t.reveal(a, 1, "o2.near", USDC / 2)), "below the inventory value");
}

#[test]
fn a_closed_firm_gives_its_inventory_to_shareholders_in_kind() {
    let mut t = T::new();
    t.c.balances.insert(acc("w1.tender.near"), 10 * USDC);
    t.c.assets.insert(acc("w1.tender.near"), 4 * NEAR);
    t.as_("o1.near", 1);
    t.c.mt_transfer(acc("investor.near"), "0".into(), U128(25), None, None);
    t.as_("o1.near", 1);
    t.c.close_firm(0);
    assert_eq!(t.bal("investor.near"), 2_500_000);
    assert_eq!(t.asset("investor.near"), NEAR);
    assert_eq!(t.asset("o1.near"), 3 * NEAR);
    assert_eq!(t.asset("w1.tender.near"), 0);
}

#[test]
fn a_firm_with_open_bids_cannot_close() {
    let mut t = T::new();
    stock(&mut t);
    let (_, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    t.bid(a, 1, "o2.near", 95 * NEAR / 10);
    t.as_("o2.near", 1);
    assert!(panics(|| t.c.close_firm(1)), "a bid is still open");
    t.wait(2);
    t.reveal(a, 1, "o2.near", 95 * NEAR / 10);
    t.wait(2);
    t.c.settle(a);
    t.as_("o2.near", 1);
    t.c.close_firm(1);
    assert_eq!(t.c.get_firm(1).status, FirmStatus::Closed);
}

#[test]
fn the_slash_follows_the_owner_who_bid() {
    let mut t = T::new();
    stock(&mut t);
    let (_, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    t.bid(a, 2, "o3.near", 95 * NEAR / 10);
    // The firm changes hands before the auction settles, and its bid is never revealed.
    t.c.firms.get_mut(2).unwrap().owner = acc("o2.near");
    t.wait(4);
    t.c.settle(a);
    assert_eq!(t.c.bond_of(acc("o3.near")).0, 5 * USDC, "slash hits the owner who bid");
    assert_eq!(t.c.bond_of(acc("o2.near")).0, 10 * USDC, "new owner untouched");
    t.as_("o3.near", 1);
    t.c.withdraw_bond(U128(5 * USDC)); // lock released on the right owner
}

#[test]
#[should_panic(expected = "firm already bid")]
fn one_bid_per_firm_even_after_a_sale() {
    let mut t = T::new();
    let (_, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    t.bid(a, 2, "o3.near", 95 * NEAR / 10);
    t.c.firms.get_mut(2).unwrap().owner = acc("o2.near");
    t.bid(a, 2, "o2.near", 96 * NEAR / 10);
}

#[test]
fn bid_hash_vector() {
    ctx("a.near", 0, 0);
    // Same vector is asserted in ts/src/swarm.test.ts: the off-chain commit must match the contract.
    assert_eq!(bid_hash(6_000_000, "s0"), "bb0041d21898d7bb4e1c67959ec2beaa5e433ead7084e524f13dfc179744f9fd");
}

#[test]
fn order_fee_goes_to_tontine() {
    let mut t = with_fees();
    stock(&mut t);
    let (_, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    t.run(a, &[(1, "o2.near", 95 * NEAR / 10)]); // alone: delivers the 9 NEAR minimum
    assert_eq!(t.bal("admin.near"), 400_000, "1% of the 40 USDC the firm receives");
    // Edge: 39.6 - 9 * 4 = 3.6 USDC, 30% to holders.
    assert_eq!(t.c.pending_dividends(1, acc("o2.near")).0, 1_080_000);
}

/// Keepers are paid from Tontine's fees, never from an empty balance, never for an unfilled order.
#[test]
fn keepers_are_paid_from_tontine_fees_when_there_are_any() {
    let mut t = with_fees();
    stock(&mut t);
    t.deposit("payer.near", USDC); // a keeper needs a ledger entry to be paid
    t.wait(10);
    t.as_("payer.near", 0);
    t.c.epoch_tick();
    assert_eq!(t.bal("payer.near"), USDC, "no fees collected yet: no reward, no failure");
    let (_, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    t.bid(a, 1, "o2.near", 95 * NEAR / 10);
    t.wait(2);
    t.reveal(a, 1, "o2.near", 95 * NEAR / 10);
    t.wait(2);
    t.as_("payer.near", 0);
    t.c.settle(a);
    assert_eq!(t.bal("payer.near"), USDC + 20_000, "0.02 USDC for the settlement");
    assert_eq!(t.bal("admin.near"), 400_000 - 20_000, "paid out of the 1% order fee");
    t.wait(10);
    t.as_("anyone.near", 0);
    t.c.epoch_tick();
    assert_eq!(t.bal("anyone.near"), 0, "no ledger entry: not paid, nothing stored");
}

/// F7 PoC: settling a dust order nobody bid on paid the keeper reward out of Tontine's fees.
#[test]
fn poc_f7_keeper_farms_auctions_nobody_bid_on() {
    let mut t = with_fees();
    t.c.balances.insert(acc("admin.near"), USDC);
    t.deposit("payer.near", USDC);
    t.as_("payer.near", 1);
    let o = t.c.post_order(PostOrder { side: Side::Buy, amount_in: U128(1), min_out: U128(1), reference_out: None, commit_secs: 1, reveal_secs: 1 });
    t.wait(2);
    t.as_("payer.near", 0);
    t.c.settle(t.c.get_order(o).auction);
    assert_eq!(t.bal("payer.near"), USDC, "no reward for an auction nobody won");
    assert_eq!(t.bal("admin.near"), USDC);
}

/// Funds are conserved: over a pseudo-random run of buys and sells (some bids unrevealed, some out of
/// band), every stable and asset unit stays in a ledger, a bond, an escrow or an unclaimed dividend.
#[test]
fn funds_are_conserved_across_random_orders() {
    let mut t = with_fees();
    stock(&mut t);
    t.c.config.no_reveal_slash_bps = 100;
    t.c.config.slash = U128(USDC / 2);
    // Unrevealed bids cost 0.5 USDC of bond each: bond enough to stay over the 5 USDC minimum all run.
    for o in ["o1.near", "o2.near", "o3.near", "o4.near"] {
        t.as_(o, 1);
        t.c.deposit_bond(U128(50 * USDC));
    }
    // Enough for 40 orders of up to 35 USDC or 8 NEAR each.
    for who in ["client.near", "payer.near"] {
        t.deposit(who, 1000 * USDC);
        t.deposit_asset(who, 200 * NEAR);
    }
    let people = ["o1.near", "o2.near", "o3.near", "o4.near", "client.near", "payer.near", "lender.near", "admin.near"];
    let firms = [(0u32, "o1.near"), (1, "o2.near"), (2, "o3.near"), (3, "o4.near")];
    let total = |t: &T| -> (u128, u128) {
        let mut stable = 0;
        let mut asset = 0;
        for w in ["w1", "w2", "w3", "w4", "w5"] {
            let w = format!("{w}.tender.near");
            stable += t.bal(&w);
            asset += t.asset(&w);
        }
        for p in people {
            stable += t.bal(p) + t.c.bond_of(acc(p)).0;
            asset += t.asset(p);
            for f in 0..5 {
                stable += t.c.pending_dividends(f, acc(p)).0;
            }
        }
        for o in t.c.get_orders(0, 1000) {
            if o.status == OrderStatus::Open {
                if o.side == Side::Buy { stable += o.amount_in.0 } else { asset += o.amount_in.0 }
            }
        }
        (stable, asset)
    };
    let (s0, a0) = total(&t);
    let mut seed: u64 = 7;
    let mut rnd = |n: u64| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) % n
    };
    let mut fills = 0u128;
    for i in 0..40 {
        let price = t.c.get_last_price().0;
        let buy = rnd(2) == 0;
        let who = if i % 2 == 0 { "client.near" } else { "payer.near" };
        let (side, amount_in) = if buy { (Side::Buy, (5 + rnd(30) as u128) * USDC) } else { (Side::Sell, (1 + rnd(8) as u128) * NEAR) };
        // Fair output at the last price, the client's minimum 2% under it.
        let fair = if buy { amount_in * NEAR / price } else { amount_in * price / NEAR };
        t.as_(who, 1);
        let o = t.c.post_order(PostOrder { side, amount_in: U128(amount_in), min_out: U128(fair * 98 / 100), reference_out: Some(U128(fair)), commit_secs: 2, reveal_secs: 2 });
        let a = t.c.get_order(o).auction;
        let mut bids = vec![];
        for &(f, owner) in &firms {
            match rnd(4) {
                0 => continue,
                1 => {
                    t.bid(a, f, owner, fair); // never revealed
                }
                _ => {
                    let v = fair * (97 + rnd(5) as u128) / 100; // 97% to 101% of fair: some under the minimum
                    t.bid(a, f, owner, v);
                    bids.push((f, owner, v));
                }
            }
        }
        t.wait(2);
        for (f, owner, v) in bids {
            let _ = panics(|| t.reveal(a, f, owner, v)); // under the minimum: refused, then slashed as unrevealed
        }
        t.wait(2);
        t.as_("anyone.near", 0);
        t.c.settle(a);
        if t.c.get_order(o).status == OrderStatus::Filled {
            fills += 1;
        }
        let (s, a1) = total(&t);
        assert_eq!(a1, a0, "asset conserved after order {i}");
        assert!(s <= s0 && s0 - s <= fills, "stable conserved after order {i} (dividend rounding at most 1 unit per fill)");
    }
    assert!(fills > 10, "the run exercised fills: {fills}");
}

// ---------------------------------------------------------------- kept from the job version (jobs-v1)

const PK1: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
const PK2: &str = "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847";

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
#[should_panic(expected = "firm in liquidation")]
fn no_loans_to_a_firm_in_liquidation() {
    let mut t = T::new();
    t.c.firms.get_mut(2).unwrap().status = FirmStatus::Liquidating;
    t.as_("lender.near", 1);
    t.c.lend(2, U128(USDC));
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

fn keys() -> Vec<PublicKey> {
    vec![PK1.parse().unwrap(), PK2.parse().unwrap()]
}

fn with_fees() -> T {
    let mut t = T::new();
    t.c.config.order_fee_bps = 100;
    t.c.config.trade_fee_bps = 50;
    t.c.config.keeper_reward = U128(20_000);
    t
}

#[test]
fn anyone_creates_a_firm_and_owns_its_shares() {
    let mut t = T::new();
    t.as_("investor.near", 3 * 10u128.pow(24));
    let no_code = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        t.c.create_firm(keys(), U128(20 * USDC), U128(USDC), 3600);
    }));
    assert!(no_code.is_err(), "no firm code stored yet");
    t.as_("admin.near", 0);
    t.c.set_firm_code(Base64VecU8(vec![0, 97, 115, 109]));
    t.as_("investor.near", 2 * 10u128.pow(24));
    let cheap = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        t.c.create_firm(keys(), U128(20 * USDC), U128(USDC), 3600);
    }));
    assert!(cheap.is_err(), "2 NEAR do not cover the code and the agent gas");
    t.as_("investor.near", 3 * 10u128.pow(24));
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
fn a_liquidation_without_a_buyer_winds_the_firm_up() {
    let mut t = T::new();
    for w in ["w1", "w2", "w4", "w5"] {
        t.c.balances.insert(acc(&format!("{w}.tender.near")), 50 * USDC);
    }
    t.as_("lender.near", 1);
    t.c.lend(2, U128(USDC)); // w3: 1 USDC treasury, all of it lent, under the 2 USDC floor
    for _ in 0..2 {
        t.wait(10);
        t.c.epoch_tick();
    }
    let a = t.c.get_firm(2).liquidation_auction.unwrap();
    t.wait(5);
    t.c.settle(a);
    let f = t.c.get_firm(2);
    assert_eq!(f.status, FirmStatus::Closed, "nobody bid: the firm is wound up, not auctioned forever");
    assert_eq!(t.bal("lender.near"), 100 * USDC, "creditor repaid from the treasury");
    assert_eq!(t.bal("w3.tender.near"), 0);
    t.wait(10);
    t.c.epoch_tick();
    assert_eq!(t.c.get_firm(2).status, FirmStatus::Closed, "a closed firm stays closed");
}

#[test]
fn an_owner_closes_its_firm_and_the_shareholders_get_the_treasury() {
    let mut t = T::new();
    t.c.balances.insert(acc("w1.tender.near"), 10 * USDC);
    t.as_("o1.near", 1);
    t.c.mt_transfer(acc("investor.near"), "0".into(), U128(25), None, None);
    t.as_("x.near", 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.close_firm(0))).is_err(), "owner only");
    t.as_("o1.near", 1);
    t.c.close_firm(0);
    assert_eq!(t.c.get_firm(0).status, FirmStatus::Closed);
    assert_eq!(t.bal("investor.near"), 2_500_000, "25 shares of a 10 USDC treasury");
    let (_, a) = t.post(Side::Buy, 40 * USDC, 9 * NEAR);
    t.as_("o1.near", 0);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.commit_bid(a, 0, "0".repeat(64)))).is_err(), "a closed firm no longer bids");
    t.as_("lender.near", 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.lend(0, U128(USDC)))).is_err(), "nor borrows");
}

#[test]
fn owners_publish_their_firm_spec() {
    let mut t = T::new();
    let spec = r#"{"name":"Cost Plus Ltd","skills":["translation"],"model":"gpt-oss-120b"}"#;
    t.as_("x.near", 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.set_firm_profile(1, spec.into()))).is_err(), "owner only");
    t.as_("o2.near", 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.set_firm_profile(1, "not json".into()))).is_err(), "JSON object only");
    t.as_("o2.near", 1);
    t.c.set_firm_profile(1, spec.into());
    assert_eq!(t.c.get_firm(1).profile.as_deref(), Some(spec));
}

/// F5 PoC: zero or dust loans, from an account with no USDC, grew `debts` without bound.
#[test]
fn poc_f5_dust_loans_bloat_the_firm() {
    let mut t = T::new();
    for amount in [0, USDC / 2] {
        t.as_("x.near", 1);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.lend(1, U128(amount))));
        assert!(r.is_err(), "a loan of {amount} base units is refused");
    }
    for _ in 0..20 {
        t.as_("lender.near", 1);
        t.c.lend(1, U128(USDC));
    }
    t.as_("lender.near", 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.c.lend(1, U128(USDC)))).is_err(), "at most 20 open loans");
    t.as_("o2.near", 1);
    t.c.repay(1, U128(USDC));
    t.as_("lender.near", 1);
    t.c.lend(1, U128(USDC));
    assert_eq!(t.c.get_firm(1).debts.len(), 20, "a repaid loan frees its slot");
}
