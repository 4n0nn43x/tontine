//! tender: the market contract of Tontine.
//!
//! One sealed-bid second-price auction (commit-reveal, highest bid wins) serves two purposes:
//! - orders: a client swaps the stable token for the asset (or back); firms bid the amount they deliver,
//!   the best bid fills at the second-best amount (or the client's minimum if alone), atomically;
//! - liquidations: the highest bid buys the bankrupt firm at the second-highest price.
//!
//! Money is an internal ledger in two tokens: the stable token (USDC base units: bonds, fees, dividends,
//! loans) and the traded asset (wNEAR). Deposits arrive by `ft_on_transfer` (plain NEP-141) or
//! `mt_on_transfer` (NEAR Intents, NEP-245). Firm shares are NEP-245 tokens (token_id = firm id, 100 per
//! firm) with Synthetix-style dividends.

use near_sdk::json_types::{Base64VecU8, I128, U128};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseOrValue, PublicKey,
};

pub const SHARES: u32 = 100;
const PREC: u128 = 1_000_000_000_000;
const BPS: u128 = 10_000;
const GAS_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const SEC: u64 = 1_000_000_000;
/// Upper bound on any phase or deadline, so `now + secs * SEC` can never overflow.
const MAX_PHASE_SECS: u64 = 30 * 86_400;
/// Order phases are short: a revealed bid's escrow is out of the firm's treasury until settlement.
const MAX_ORDER_PHASE_SECS: u64 = 600;
/// Fills move the reference price by `max_move_bps` at most per window, however many fills there are.
const PRICE_WINDOW_SECS: u64 = 3600;
const YEAR_SECS: u128 = 365 * 86_400;
/// Smallest loan (1 USDC) and most open loans per firm: each loan is a row the firm carries in every call.
const MIN_LOAN: u128 = 1_000_000;
/// ponytail: fixed cap of 20 open loans per firm; merge loans per lender if firms need more creditors.
const MAX_DEBTS: usize = 20;
/// NEAR a creator attaches to `create_firm`: the storage of the firm contract code (about 1.5 NEAR) and
/// the gas its agent keys pay for every transaction.
const FIRM_ACCOUNT_DEPOSIT: NearToken = NearToken::from_near(3);
/// Deploying the firm code and running its `new` takes most of this.
const GAS_CREATE_FIRM: Gas = Gas::from_tgas(150);
const GAS_FIRM_INIT: Gas = Gas::from_tgas(30);
/// Raw storage key of the firm contract code that `create_firm` deploys (set by the admin).
const FIRM_CODE_KEY: &[u8] = b"firm_code";
/// Methods an agent key may call on tender (none takes a deposit). Mirrors contracts/firm and ts/src/deploy.ts.
const AGENT_TENDER_METHODS: &str = "commit_bid,reveal_bid,settle,epoch_tick,settle_dividends";

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub enum Payment {
    /// Plain NEP-141 token (used in the sandbox demo).
    Ft { token: AccountId },
    /// Balance held inside intents.near (mainnet), moved with `mt_transfer` as predecessor.
    Intents { contract: AccountId, token_id: String },
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Config {
    pub admin: AccountId,
    /// The stable token: ledger, bonds, fees, dividends and loans (USDC).
    pub payment: Payment,
    /// The asset that orders trade against the stable token (wNEAR).
    pub asset: Payment,
    /// Base units of one whole asset token (10^24 for wNEAR). Prices are stable base units per asset unit.
    pub asset_unit: U128,
    /// Price that values inventories and anchors price bands until the first order fills.
    pub initial_price: U128,
    pub dividend_bps: u16,
    pub liquidation_fee_bps: u16,
    pub min_bond: U128,
    /// Smallest slash of an owner bond for a committed bid that is never revealed.
    pub slash: U128,
    /// A firm whose net asset value stays under this floor for N epochs is liquidated.
    pub treasury_floor: U128,
    pub epochs_before_liquidation: u32,
    pub epoch_secs: u64,
    pub liquidation_commit_secs: u64,
    pub liquidation_reveal_secs: u64,
    /// Tontine's cut of what the winning firm receives on each filled order. Paid to `admin`.
    #[serde(default)]
    pub order_fee_bps: u16,
    /// Tontine's cut of every share sale, taken from the seller's proceeds. Paid to `admin`.
    #[serde(default)]
    pub trade_fee_bps: u16,
    /// Paid out of `admin`'s fee balance to whoever settles an auction or ticks an epoch.
    #[serde(default)]
    pub keeper_reward: U128,
    /// Slash for an unrevealed order bid, in bps of the order's stable notional (at least `slash`).
    #[serde(default)]
    pub no_reveal_slash_bps: u16,
    /// Fewest revealed bids for an order to fill (0 means 1); with fewer, everyone is refunded.
    #[serde(default)]
    pub min_bidders: u8,
    /// Smallest order, in stable units (amount_in of a buy, min_out of a sell): no dust fills.
    #[serde(default)]
    pub min_order: U128,
    /// Most the reference price moves per hour, however many fills (0 = no limit): fills cannot set it at will.
    #[serde(default)]
    pub max_move_bps: u16,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum FirmStatus {
    Solvent,
    Illiquid,
    Liquidating,
    /// Wound up: by its owner, or because a liquidation found no buyer. It no longer bids or borrows.
    Closed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Holding {
    pub account: AccountId,
    pub shares: u32,
    /// shares * acc_per_share (full precision, not divided by PREC) already paid or forfeited.
    pub debt: U128,
}

/// A loan to a firm. Interest accrues at `rate_bps` a year on `principal` from `since` (ns).
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Debt {
    pub lender: AccountId,
    pub principal: U128,
    pub rate_bps: u16,
    pub since: u64,
}

/// What the owner accepts to borrow: a yearly rate and a cap on the principal owed.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct LoanTerms {
    pub rate_bps: u16,
    pub cap: U128,
}

/// The owner's limits on its firm's agent, checked by the contract on every revealed order bid: the AI
/// chooses prices inside them and cannot step out, whatever it is told.
#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub struct Policy {
    /// Most of the firm's net asset value it may hold in the asset after a fill (10000 = no limit).
    pub max_asset_bps: u16,
    /// Farthest a bid's price may be from the last clearing price (0 = no band).
    pub band_bps: u16,
    /// Kill switch: a paused firm commits no bid.
    pub paused: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Firm {
    pub id: u32,
    pub account: AccountId,
    pub owner: AccountId,
    pub status: FirmStatus,
    pub acc_per_share: U128,
    pub holdings: Vec<Holding>,
    pub debts: Vec<Debt>,
    /// None: loans are accepted at 0% with no cap (lending only moves money into the treasury).
    pub loan_terms: Option<LoanTerms>,
    pub epochs_below_floor: u32,
    pub liquidation_auction: Option<u64>,
    pub policy: Policy,
    // record and P&L
    pub fills: u32,
    /// Stable notional of the orders it filled.
    pub volume: U128,
    /// Sum of each fill's edge: what it received minus what it delivered, valued at the previous clearing price.
    pub edge: I128,
    pub slashed: U128,
    pub dividends: U128,
    pub takeovers: u32,
    /// Stable and asset escrowed in its revealed, unsettled bids: still the firm's, counted in its floor.
    pub escrow: U128,
    pub escrow_asset: U128,
    /// False between a takeover and the firm contract confirming its new owner.
    pub owner_synced: bool,
    /// The firm's spec as published by its owner: JSON (name, description, skills, model, budgets...).
    pub profile: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum AuctionKind {
    Order(u64),
    Liquidation(u32),
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Bid {
    pub firm_id: u32,
    pub owner: AccountId,
    /// hex(sha256("{auction_id}:{firm_id}:{amount}:{salt}")): bound to its auction and firm, so it cannot be copied.
    pub hash: String,
    pub revealed: Option<U128>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Auction {
    pub kind: AuctionKind,
    /// The lowest acceptable bid: the client's minimum for an order, the inventory value for a liquidation.
    pub reserve: U128,
    pub commit_end: u64,
    pub reveal_end: u64,
    pub bids: Vec<Bid>,
    pub settled: bool,
    pub winner: Option<u32>,
    pub price: Option<U128>,
}

/// Buy: the client pays the stable token and receives the asset. Sell: the client pays the asset and
/// receives the stable token.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Side {
    Buy,
    Sell,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum OrderStatus {
    Open,
    Filled,
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Order {
    pub id: u64,
    pub client: AccountId,
    pub side: Side,
    /// Escrowed when posted: stable for a buy, asset for a sell.
    pub amount_in: U128,
    /// The least the client accepts: the auction's reserve.
    pub min_out: U128,
    /// What the client was quoted elsewhere when posting (e.g. NEAR Intents 1Click). Informational.
    pub reference_out: Option<U128>,
    /// The reference price when posted: firms' price bands are checked against it, so a fill elsewhere
    /// during the auction cannot push their bids out of band.
    pub price: U128,
    pub auction: u64,
    pub status: OrderStatus,
    pub firm: Option<u32>,
    /// What the client received.
    pub out: Option<U128>,
}

#[near(serializers = [json])]
pub struct PostOrder {
    pub side: Side,
    pub amount_in: U128,
    pub min_out: U128,
    #[serde(default)]
    pub reference_out: Option<U128>,
    pub commit_secs: u64,
    pub reveal_secs: u64,
}

/// `msg` of a deposit. Empty msg = plain deposit to the sender.
#[near(serializers = [json])]
pub enum DepositAction {
    PostOrder(PostOrder),
    /// Credit another account (e.g. fund a firm's treasury or inventory).
    Credit(AccountId),
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Ask {
    pub amount: u32,
    pub price_per_share: U128,
    /// Firm takeover count when listed: a takeover voids older asks.
    pub takeover: u32,
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Balances,
    Assets,
    Bonds,
    Locks,
    Firms,
    FirmByAccount,
    Orders,
    Auctions,
    Asks,
    Storage,
}

/// The two ledgers.
#[derive(Clone, Copy, PartialEq)]
enum Token {
    Stable,
    Asset,
}

/// What the client pays and what it receives.
fn tokens(side: Side) -> (Token, Token) {
    match side {
        Side::Buy => (Token::Stable, Token::Asset),
        Side::Sell => (Token::Asset, Token::Stable),
    }
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait Ft {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[ext_contract(ext_mt)]
#[allow(dead_code)]
trait Mt {
    fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    );
}

#[ext_contract(ext_firm)]
#[allow(dead_code)]
trait FirmContract {
    fn set_owner(&mut self, owner: AccountId);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Tender {
    config: Config,
    /// Stable token ledger.
    balances: LookupMap<AccountId, u128>,
    /// Asset ledger.
    assets: LookupMap<AccountId, u128>,
    bonds: LookupMap<AccountId, u128>,
    /// Open commitments per owner (bids not yet settled). Bond is locked while > 0.
    locks: LookupMap<AccountId, u32>,
    firms: Vector<Firm>,
    firm_by_account: LookupMap<AccountId, u32>,
    orders: Vector<Order>,
    auctions: Vector<Auction>,
    asks: LookupMap<String, Ask>,
    /// NEP-145-style prepaid storage (yoctoNEAR): whoever grows the state pays for it.
    storage: LookupMap<AccountId, u128>,
    last_epoch: u64,
    /// Stable base units per asset unit at the last fill (`initial_price` before any).
    last_price: u128,
    /// The reference when the current price window opened, and when it opened (ns).
    price_anchor: u128,
    price_anchor_at: u64,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn bid_hash(auction_id: u64, firm_id: u32, amount: u128, salt: &str) -> String {
    hex(&env::sha256(format!("{auction_id}:{firm_id}:{amount}:{salt}").as_bytes()))
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "tontine", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

fn emit_mt(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "nep245", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

fn now() -> u64 {
    env::block_timestamp()
}

#[near]
impl Tender {
    #[init]
    pub fn new(config: Config) -> Self {
        require!(
            [config.dividend_bps, config.liquidation_fee_bps, config.order_fee_bps, config.trade_fee_bps, config.no_reveal_slash_bps]
                .iter()
                .all(|b| *b as u128 <= BPS),
            "bps > 100%"
        );
        require!(config.asset_unit.0 > 0 && config.initial_price.0 > 0, "asset_unit and initial_price must be > 0");
        let mut c = Self {
            last_price: config.initial_price.0,
            price_anchor: config.initial_price.0,
            price_anchor_at: now(),
            config,
            balances: LookupMap::new(Key::Balances),
            assets: LookupMap::new(Key::Assets),
            bonds: LookupMap::new(Key::Bonds),
            locks: LookupMap::new(Key::Locks),
            firms: Vector::new(Key::Firms),
            firm_by_account: LookupMap::new(Key::FirmByAccount),
            orders: Vector::new(Key::Orders),
            auctions: Vector::new(Key::Auctions),
            asks: LookupMap::new(Key::Asks),
            storage: LookupMap::new(Key::Storage),
            last_epoch: now(),
        };
        // Fees land here on every fill: create the entries once, at the contract's cost.
        let admin = c.config.admin.clone();
        c.balances.insert(admin.clone(), 0);
        c.assets.insert(admin, 0);
        c
    }

    // ---------------------------------------------------------------- storage

    /// Bytes the state takes now. `store` collections cache writes until the end of the call,
    /// so flush them first or the growth of this call is invisible.
    fn usage(&mut self) -> u64 {
        self.balances.flush();
        self.assets.flush();
        self.bonds.flush();
        self.locks.flush();
        self.firms.flush();
        self.firm_by_account.flush();
        self.orders.flush();
        self.auctions.flush();
        self.asks.flush();
        env::storage_usage()
    }

    /// Bill `payer`'s storage deposit for the bytes added since `before`.
    /// ponytail: shrinking state is not refunded; add refunds if storage churn matters.
    fn charge(&mut self, payer: &AccountId, before: u64) {
        let after = self.usage();
        if after <= before {
            return;
        }
        let cost = (after - before) as u128 * env::storage_byte_cost().as_yoctonear();
        let have = self.storage.get(payer).copied().unwrap_or(0);
        require!(have >= cost, format!("storage deposit too low: {payer} needs {cost} yoctoNEAR, has {have}"));
        self.storage.insert(payer.clone(), have - cost);
    }

    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) -> U128 {
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        let s0 = self.usage();
        let b = self.storage.get(&who).copied().unwrap_or(0) + env::attached_deposit().as_yoctonear();
        self.storage.insert(who.clone(), b);
        self.storage.flush();
        // A new entry is paid out of the deposit itself: an empty deposit cannot grow the state.
        self.charge(&who, s0);
        self.storage_balance_of(who)
    }

    #[payable]
    pub fn storage_withdraw(&mut self, amount: U128) -> Promise {
        near_sdk::assert_one_yocto();
        require!(amount.0 > 0, "amount must be > 0");
        let me = env::predecessor_account_id();
        let b = self.storage.get(&me).copied().unwrap_or(0);
        require!(b >= amount.0, "insufficient storage deposit");
        self.storage.insert(me.clone(), b - amount.0);
        Promise::new(me).transfer(NearToken::from_yoctonear(amount.0))
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.storage.get(&account_id).copied().unwrap_or(0))
    }

    // ---------------------------------------------------------------- ledger

    fn credit(&mut self, account: &AccountId, amount: u128) {
        let b = self.balances.get(account).copied().unwrap_or(0);
        self.balances.insert(account.clone(), b + amount);
    }

    fn debit(&mut self, account: &AccountId, amount: u128) {
        let b = self.balances.get(account).copied().unwrap_or(0);
        require!(b >= amount, "insufficient balance");
        self.balances.insert(account.clone(), b - amount);
    }

    fn credit_t(&mut self, t: Token, account: &AccountId, amount: u128) {
        match t {
            Token::Stable => self.credit(account, amount),
            Token::Asset => {
                let b = self.assets.get(account).copied().unwrap_or(0);
                self.assets.insert(account.clone(), b + amount);
            }
        }
    }

    fn debit_t(&mut self, t: Token, account: &AccountId, amount: u128) {
        match t {
            Token::Stable => self.debit(account, amount),
            Token::Asset => {
                let b = self.assets.get(account).copied().unwrap_or(0);
                require!(b >= amount, "insufficient asset balance");
                self.assets.insert(account.clone(), b - amount);
            }
        }
    }

    fn asset_of(&self, account: &AccountId) -> u128 {
        self.assets.get(account).copied().unwrap_or(0)
    }

    /// Stable value of an asset amount at the last clearing price.
    fn value(&self, asset: u128) -> u128 {
        asset.saturating_mul(self.last_price) / self.config.asset_unit.0
    }

    /// Principal plus interest the firm owes, all loans.
    fn owed_total(f: &Firm) -> u128 {
        f.debts.iter().map(Self::owed).sum()
    }

    /// Net asset value of a firm: its stable treasury plus its asset inventory at the last clearing price.
    fn nav(&self, f: &Firm) -> u128 {
        self.balances.get(&f.account).copied().unwrap_or(0) + self.value(self.asset_of(&f.account))
    }

    fn apply_deposit(&mut self, t: Token, sender: AccountId, amount: u128, msg: &str) {
        let s0 = self.usage();
        self.apply_deposit_inner(t, sender.clone(), amount, msg);
        // A deposit from someone without storage deposit panics: the token refunds it.
        self.charge(&sender, s0);
    }

    fn apply_deposit_inner(&mut self, t: Token, sender: AccountId, amount: u128, msg: &str) {
        self.credit_t(t, &sender, amount);
        let token = if t == Token::Stable { "stable" } else { "asset" };
        emit("deposit", json!({"account": sender, "amount": U128(amount), "token": token}));
        if msg.is_empty() {
            return;
        }
        match serde_json::from_str::<DepositAction>(msg).unwrap_or_else(|_| env::panic_str("bad msg")) {
            DepositAction::PostOrder(p) => {
                require!(tokens(p.side).0 == t, "deposit the token the order sells");
                self.post_order_from(sender, p);
            }
            DepositAction::Credit(to) => {
                self.debit_t(t, &sender, amount);
                self.credit_t(t, &to, amount);
            }
        }
    }

    /// NEP-141 receiver. Only the configured stable token and asset are accepted.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let who = env::predecessor_account_id();
        let t = match (&self.config.payment, &self.config.asset) {
            (Payment::Ft { token }, _) if token == &who => Token::Stable,
            (_, Payment::Ft { token }) if token == &who => Token::Asset,
            (Payment::Ft { .. }, _) | (_, Payment::Ft { .. }) => env::panic_str("wrong token"),
            _ => env::panic_str("ft deposits disabled"),
        };
        self.apply_deposit(t, sender_id, amount.0, &msg);
        PromiseOrValue::Value(U128(0))
    }

    /// NEP-245 receiver for intents.near balances (`mt_transfer_call` to this contract).
    pub fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        let _ = sender_id;
        let who = env::predecessor_account_id();
        require!(token_ids.len() == 1 && previous_owner_ids.len() == 1 && amounts.len() == 1, "single token only");
        let route = |p: &Payment| matches!(p, Payment::Intents { contract, token_id } if contract == &who && token_id == &token_ids[0]);
        let t = if route(&self.config.payment) {
            Token::Stable
        } else if route(&self.config.asset) {
            Token::Asset
        } else if matches!(self.config.payment, Payment::Intents { .. }) {
            env::panic_str("wrong mt contract or token id")
        } else {
            env::panic_str("intents deposits disabled")
        };
        self.apply_deposit(t, previous_owner_ids[0].clone(), amounts[0].0, &msg);
        PromiseOrValue::Value(vec![U128(0)])
    }

    /// Internal transfer between ledger accounts.
    #[payable]
    pub fn transfer(&mut self, receiver_id: AccountId, amount: U128) {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        let s0 = self.usage();
        self.debit(&me, amount.0);
        self.credit(&receiver_id, amount.0);
        self.charge(&me, s0);
        emit("transfer", json!({"from": me, "to": receiver_id, "amount": amount}));
    }

    /// Withdraw ledger balance out of the contract (ft_transfer or intents mt_transfer).
    #[payable]
    pub fn withdraw(&mut self, amount: U128, receiver_id: Option<AccountId>) -> Promise {
        self.withdraw_t(Token::Stable, amount, receiver_id)
    }

    /// Withdraw asset ledger balance, the same way.
    #[payable]
    pub fn withdraw_asset(&mut self, amount: U128, receiver_id: Option<AccountId>) -> Promise {
        self.withdraw_t(Token::Asset, amount, receiver_id)
    }

    fn withdraw_t(&mut self, t: Token, amount: U128, receiver_id: Option<AccountId>) -> Promise {
        near_sdk::assert_one_yocto();
        require!(amount.0 > 0, "amount must be > 0");
        let me = env::predecessor_account_id();
        let to = receiver_id.unwrap_or_else(|| me.clone());
        self.debit_t(t, &me, amount.0);
        let route = if t == Token::Stable { &self.config.payment } else { &self.config.asset };
        let p = match route {
            Payment::Ft { token } => ext_ft::ext(token.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_TRANSFER)
                .ft_transfer(to, amount, None),
            Payment::Intents { contract, token_id } => ext_mt::ext(contract.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_TRANSFER)
                .mt_transfer(to, token_id.clone(), amount, None, None),
        };
        p.then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_withdraw(me, amount, t == Token::Asset))
    }

    #[private]
    pub fn on_withdraw(&mut self, account: AccountId, amount: U128, asset: bool) -> bool {
        let ok = matches!(env::promise_result_checked(0, 1024), Ok(_));
        let t = if asset { Token::Asset } else { Token::Stable };
        if ok {
            emit("withdraw", json!({"account": account, "amount": amount, "token": if asset { "asset" } else { "stable" }}));
        } else {
            self.credit_t(t, &account, amount.0);
        }
        ok
    }

    // ---------------------------------------------------------------- bonds

    #[payable]
    pub fn deposit_bond(&mut self, amount: U128) {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        let s0 = self.usage();
        self.debit(&me, amount.0);
        let b = self.bonds.get(&me).copied().unwrap_or(0);
        self.bonds.insert(me.clone(), b + amount.0);
        self.charge(&me, s0);
    }

    #[payable]
    pub fn withdraw_bond(&mut self, amount: U128) {
        near_sdk::assert_one_yocto();
        require!(amount.0 > 0, "amount must be > 0");
        let me = env::predecessor_account_id();
        require!(self.locks.get(&me).copied().unwrap_or(0) == 0, "bond locked by open bids");
        let b = self.bonds.get(&me).copied().unwrap_or(0);
        require!(b >= amount.0, "insufficient bond");
        self.bonds.insert(me.clone(), b - amount.0);
        self.credit(&me, amount.0);
    }

    fn lock(&mut self, owner: &AccountId, up: bool) {
        let n = self.locks.get(owner).copied().unwrap_or(0);
        self.locks.insert(owner.clone(), if up { n + 1 } else { n.saturating_sub(1) });
    }

    // ---------------------------------------------------------------- firms & shares

    /// Admin registers a firm contract (deployed on a sub-account without full access key).
    /// The owner receives the 100 shares.
    pub fn register_firm(&mut self, account: AccountId, owner: AccountId) -> u32 {
        require!(env::predecessor_account_id() == self.config.admin, "admin only");
        self.add_firm(account, owner)
    }

    /// Admin stores the firm contract code that `create_firm` deploys.
    pub fn set_firm_code(&mut self, code: Base64VecU8) {
        require!(env::predecessor_account_id() == self.config.admin, "admin only");
        env::storage_write(FIRM_CODE_KEY, &code.0);
    }

    /// Anyone launches a firm: tender creates `w{id+1}.<tender>` with the firm contract and the two agent
    /// keys (bidding on tender, `spend` on the firm), never a full access key. The caller owns the 100
    /// shares and can list them for sale at once. Attach 3 NEAR (code storage and agent gas) and 150 TGas.
    #[payable]
    pub fn create_firm(&mut self, agent_keys: Vec<PublicKey>, budget: U128, max_per_call: U128, epoch_secs: u64) -> u32 {
        let me = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        require!(deposit >= FIRM_ACCOUNT_DEPOSIT, "attach 3 NEAR for the firm account");
        require!(env::prepaid_gas() >= GAS_CREATE_FIRM, "attach 150 TGas");
        require!(agent_keys.len() == 2, "two agent keys: [tender, firm]");
        require!(epoch_secs > 0, "epoch_secs must be > 0");
        let code = env::storage_read(FIRM_CODE_KEY).unwrap_or_else(|| env::panic_str("firm code not set"));
        let account: AccountId = format!("w{}.{}", self.firms.len() + 1, env::current_account_id()).parse().unwrap();
        let s0 = self.usage();
        let id = self.add_firm(account.clone(), me.clone());
        self.charge(&me, s0);
        let init = json!({
            "tender": env::current_account_id(),
            "owner": me,
            "budget": budget,
            "max_per_call": max_per_call,
            "epoch_secs": epoch_secs,
            "agent_keys": agent_keys,
        });
        Promise::new(account.clone())
            .create_account()
            .transfer(deposit)
            .deploy_contract(code)
            .function_call("new".to_string(), init.to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_FIRM_INIT)
            .add_access_key_allowance(agent_keys[0].clone(), Allowance::unlimited(), env::current_account_id(), AGENT_TENDER_METHODS.to_string())
            .add_access_key_allowance(agent_keys[1].clone(), Allowance::unlimited(), account, "spend".to_string())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_firm_created(id, me, U128(deposit.as_yoctonear())))
            .detach();
        id
    }

    /// The account batch failed (e.g. not enough gas): give the NEAR back. The firm stays registered and
    /// its owner can still bid and deliver directly, without the budget guard of a firm contract.
    #[private]
    pub fn on_firm_created(&mut self, firm_id: u32, creator: AccountId, deposit: U128) -> bool {
        let ok = env::promise_result_checked(0, 1024).is_ok();
        if !ok {
            emit("firm_create_failed", json!({"firm_id": firm_id, "creator": creator}));
            Promise::new(creator).transfer(NearToken::from_yoctonear(deposit.0)).detach();
        }
        ok
    }

    fn add_firm(&mut self, account: AccountId, owner: AccountId) -> u32 {
        require!(self.firm_by_account.get(&account).is_none(), "firm exists");
        let id = self.firms.len();
        self.firms.push(Firm {
            id,
            account: account.clone(),
            owner: owner.clone(),
            status: FirmStatus::Solvent,
            acc_per_share: U128(0),
            holdings: vec![Holding { account: owner.clone(), shares: SHARES, debt: U128(0) }],
            debts: vec![],
            loan_terms: None,
            epochs_below_floor: 0,
            liquidation_auction: None,
            // Until its owner says otherwise: bids within 10% of the last price, at most 80% of NAV in the asset.
            policy: Policy { max_asset_bps: 8000, band_bps: 1000, paused: false },
            fills: 0,
            volume: U128(0),
            edge: I128(0),
            slashed: U128(0),
            dividends: U128(0),
            takeovers: 0,
            escrow: U128(0),
            escrow_asset: U128(0),
            owner_synced: true,
            profile: None,
        });
        self.firm_by_account.insert(account.clone(), id);
        emit("firm_registered", json!({"firm_id": id, "account": account, "owner": owner}));
        emit_mt("mt_mint", json!({"owner_id": owner, "token_ids": [id.to_string()], "amounts": [SHARES.to_string()]}));
        id
    }

    fn firm(&self, id: u32) -> Firm {
        self.firms.get(id).cloned().unwrap_or_else(|| env::panic_str("no firm"))
    }

    fn save_firm(&mut self, f: Firm) {
        let id = f.id;
        self.firms.replace(id, f);
    }

    /// Pay a holding its accrued dividends into the ledger.
    fn settle_holding(&mut self, f: &mut Firm, i: usize) {
        let h = &mut f.holdings[i];
        let owed = (h.shares as u128 * f.acc_per_share.0 - h.debt.0) / PREC;
        // Keep the sub-unit remainder: debt advances only by what is paid, so rounding never pays twice.
        h.debt = U128(h.debt.0 + owed * PREC);
        if owed > 0 {
            let who = h.account.clone();
            self.credit(&who, owed);
            emit("dividend_claimed", json!({"firm_id": f.id, "account": who, "amount": U128(owed)}));
        }
    }

    fn holding_index(f: &mut Firm, account: &AccountId) -> usize {
        if let Some(i) = f.holdings.iter().position(|h| &h.account == account) {
            return i;
        }
        // A new holding has 0 shares, so it accrues nothing until move_shares resets its debt.
        f.holdings.push(Holding { account: account.clone(), shares: 0, debt: U128(0) });
        f.holdings.len() - 1
    }

    /// Distribute `amount` to shareholders. Returns the dust not distributed.
    fn distribute(f: &mut Firm, amount: u128) -> u128 {
        let inc = amount * PREC / SHARES as u128;
        f.acc_per_share = U128(f.acc_per_share.0 + inc);
        amount - inc * SHARES as u128 / PREC
    }

    fn move_shares(&mut self, f: &mut Firm, from: &AccountId, to: &AccountId, amount: u32) {
        require!(amount > 0, "zero amount");
        let i = Self::holding_index(f, from);
        let j = Self::holding_index(f, to);
        self.settle_holding(f, i);
        self.settle_holding(f, j);
        require!(f.holdings[i].shares >= amount, "insufficient shares");
        f.holdings[i].shares -= amount;
        f.holdings[j].shares += amount;
        let acc = f.acc_per_share.0;
        for k in [i, j] {
            // Forfeits a remainder below one base unit: never pays more than was distributed.
            f.holdings[k].debt = U128(f.holdings[k].shares as u128 * acc);
        }
        f.holdings.retain(|h| h.shares > 0);
        emit_mt(
            "mt_transfer",
            json!({"old_owner_id": from, "new_owner_id": to, "token_ids": [f.id.to_string()], "amounts": [amount.to_string()]}),
        );
    }

    #[payable]
    pub fn claim_dividends(&mut self, firm_id: u32) {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        let mut f = self.firm(firm_id);
        let i = f.holdings.iter().position(|h| h.account == me).unwrap_or_else(|| env::panic_str("not a holder"));
        let s0 = self.usage();
        self.settle_holding(&mut f, i);
        self.save_firm(f);
        self.charge(&me, s0);
    }

    /// Anyone can pay a holder its accrued dividends, into the holder's own ledger balance. Shares held
    /// by a firm account (after a takeover) have no other way out: firm keys cannot attach a deposit.
    pub fn settle_dividends(&mut self, firm_id: u32, account_id: AccountId) {
        let mut f = self.firm(firm_id);
        let i = f.holdings.iter().position(|h| h.account == account_id).unwrap_or_else(|| env::panic_str("not a holder"));
        let s0 = self.usage();
        self.settle_holding(&mut f, i);
        self.save_firm(f);
        self.charge(&env::predecessor_account_id(), s0);
    }

    /// NEP-245 share transfer (token_id = firm id).
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) {
        near_sdk::assert_one_yocto();
        require!(approval.is_none(), "approvals not supported");
        let _ = memo;
        let id: u32 = token_id.parse().unwrap_or_else(|_| env::panic_str("bad token id"));
        let amount: u32 = amount.0.try_into().unwrap_or_else(|_| env::panic_str("amount too large"));
        let mut f = self.firm(id);
        require!(f.status != FirmStatus::Liquidating, "firm in liquidation");
        let me = env::predecessor_account_id();
        let s0 = self.usage();
        self.move_shares(&mut f, &me, &receiver_id, amount);
        self.save_firm(f);
        self.charge(&me, s0);
    }

    /// Offer shares for sale at a fixed price (USDC base units per share).
    #[payable]
    pub fn list_shares(&mut self, firm_id: u32, amount: u32, price_per_share: U128) {
        near_sdk::assert_one_yocto();
        require!(amount > 0 && price_per_share.0 > 0, "amount and price must be > 0");
        let me = env::predecessor_account_id();
        let f = self.firm(firm_id);
        let held = f.holdings.iter().find(|h| h.account == me).map(|h| h.shares).unwrap_or(0);
        require!(held >= amount, "insufficient shares");
        let s0 = self.usage();
        self.asks.insert(format!("{firm_id}:{me}"), Ask { amount, price_per_share, takeover: f.takeovers });
        self.charge(&me, s0);
        emit("shares_listed", json!({"firm_id": firm_id, "seller": me, "amount": amount, "price_per_share": price_per_share}));
    }

    #[payable]
    pub fn buy_shares(&mut self, firm_id: u32, seller: AccountId, amount: u32, max_price_per_share: U128) {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        let key = format!("{firm_id}:{seller}");
        let mut ask = self.asks.get(&key).cloned().unwrap_or_else(|| env::panic_str("no ask"));
        require!(amount > 0 && ask.amount >= amount, "ask too small");
        // The seller may re-list between the buyer's look and its transaction: never pay more than seen.
        require!(ask.price_per_share.0 <= max_price_per_share.0, "ask above your maximum price");
        let cost = ask.price_per_share.0 * amount as u128;
        let fee = cost * self.config.trade_fee_bps as u128 / BPS;
        let s0 = self.usage();
        self.debit(&me, cost);
        self.credit(&seller, cost - fee);
        self.credit(&self.config.admin.clone(), fee);
        let mut f = self.firm(firm_id);
        require!(f.status != FirmStatus::Liquidating, "firm in liquidation");
        require!(f.status != FirmStatus::Closed, "firm closed");
        require!(ask.takeover == f.takeovers, "ask voided by a takeover");
        self.move_shares(&mut f, &seller, &me, amount);
        self.save_firm(f);
        ask.amount -= amount;
        if ask.amount == 0 {
            self.asks.remove(&key);
        } else {
            self.asks.insert(key, ask);
        }
        self.charge(&me, s0);
        emit("shares_bought", json!({"firm_id": firm_id, "seller": seller, "buyer": me, "amount": amount, "cost": U128(cost), "fee": U128(fee)}));
    }

    /// Lend to a firm treasury. The lender becomes a creditor, paid before shareholders in a liquidation.
    #[payable]
    pub fn lend(&mut self, firm_id: u32, amount: U128) {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        let mut f = self.firm(firm_id);
        // A loan during the sale would be repaid ahead of shareholders out of the buyer's own price.
        require!(f.status != FirmStatus::Liquidating, "firm in liquidation");
        require!(f.status != FirmStatus::Closed, "firm closed");
        // Every loan is loaded with the firm on each call (and by epoch_tick for every firm): dust loans
        // would grow it without bound (audit finding 05).
        require!(amount.0 >= MIN_LOAN, "loan below 1 USDC");
        require!(f.debts.len() < MAX_DEBTS, "too many open loans: the owner repays some first");
        // The owner sets the rate and the cap: a lender cannot load a firm with debt on its own terms.
        let rate_bps = match &f.loan_terms {
            Some(t) => {
                let owed: u128 = f.debts.iter().map(|d| d.principal.0).sum();
                require!(owed + amount.0 <= t.cap.0, "over the firm's borrowing cap");
                t.rate_bps
            }
            None => 0,
        };
        let s0 = self.usage();
        self.debit(&me, amount.0);
        self.credit(&f.account, amount.0);
        f.debts.push(Debt { lender: me.clone(), principal: amount, rate_bps, since: now() });
        self.save_firm(f);
        self.charge(&me, s0);
        emit("loan", json!({"firm_id": firm_id, "lender": me, "amount": amount, "rate_bps": rate_bps}));
    }

    /// Owner sets the yearly rate it pays on new loans and the most principal it accepts to owe.
    #[payable]
    pub fn set_loan_terms(&mut self, firm_id: u32, rate_bps: u16, cap: U128) {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        let mut f = self.firm(firm_id);
        require!(me == f.owner, "owner only");
        require!(rate_bps as u128 <= BPS, "rate above 100% a year");
        let s0 = self.usage();
        f.loan_terms = Some(LoanTerms { rate_bps, cap });
        self.save_firm(f);
        self.charge(&me, s0);
        emit("loan_terms", json!({"firm_id": firm_id, "rate_bps": rate_bps, "cap": cap}));
    }

    /// Owner sets its agent's limits (see `Policy`): the contract enforces them on every order bid.
    #[payable]
    pub fn set_policy(&mut self, firm_id: u32, policy: Policy) {
        near_sdk::assert_one_yocto();
        let mut f = self.firm(firm_id);
        require!(env::predecessor_account_id() == f.owner, "owner only");
        require!(policy.max_asset_bps as u128 <= BPS, "max_asset_bps above 100%");
        emit("policy", json!({"firm_id": firm_id, "policy": policy}));
        f.policy = policy;
        self.save_firm(f);
    }

    /// Principal plus interest accrued since `since`.
    fn owed(d: &Debt) -> u128 {
        let secs = (now().saturating_sub(d.since) / SEC) as u128;
        d.principal.0 + d.principal.0 * d.rate_bps as u128 * secs / (BPS * YEAR_SECS)
    }

    /// Firm (or its owner) repays creditors FIFO from the firm treasury.
    #[payable]
    pub fn repay(&mut self, firm_id: u32, amount: U128) {
        near_sdk::assert_one_yocto();
        let mut f = self.firm(firm_id);
        let me = env::predecessor_account_id();
        require!(me == f.account || me == f.owner, "firm or owner only");
        let acct = f.account.clone();
        self.debit(&acct, amount.0);
        let left = self.pay_creditors(&mut f, amount.0);
        self.credit(&acct, left);
        self.save_firm(f);
    }

    fn pay_creditors(&mut self, f: &mut Firm, mut pot: u128) -> u128 {
        let mut debts = std::mem::take(&mut f.debts);
        for d in debts.iter_mut() {
            let owed = Self::owed(d);
            let pay = pot.min(owed);
            if pay > 0 {
                self.credit(&d.lender, pay);
                pot -= pay;
                emit("creditor_paid", json!({"firm_id": f.id, "creditor": d.lender, "amount": U128(pay)}));
            }
            // What is still owed, interest included, keeps accruing from now.
            d.principal = U128(owed - pay);
            d.since = now();
        }
        f.debts = debts.into_iter().filter(|d| d.principal.0 > 0).collect();
        pot
    }

    // ---------------------------------------------------------------- auction (shared by orders and liquidations)

    fn new_auction(&mut self, kind: AuctionKind, reserve: u128, commit_secs: u64, reveal_secs: u64) -> u64 {
        require!(commit_secs > 0 && reveal_secs > 0, "phases must be > 0");
        require!(commit_secs <= MAX_PHASE_SECS && reveal_secs <= MAX_PHASE_SECS, "phase too long");
        let commit_end = now() + commit_secs * SEC;
        let id = self.auctions.len() as u64;
        self.auctions.push(Auction {
            kind: kind.clone(),
            reserve: U128(reserve),
            commit_end,
            reveal_end: commit_end + reveal_secs * SEC,
            bids: vec![],
            settled: false,
            winner: None,
            price: None,
        });
        emit("auction_opened", json!({"auction_id": id, "kind": kind, "reserve": U128(reserve)}));
        id
    }

    fn auction(&self, id: u64) -> Auction {
        self.auctions.get(id as u32).cloned().unwrap_or_else(|| env::panic_str("no auction"))
    }

    /// Caller must be the firm contract (its operator key) or the firm owner.
    fn assert_firm_actor(f: &Firm) {
        let me = env::predecessor_account_id();
        require!(me == f.account || me == f.owner, "firm or owner only");
    }

    /// Commit a sealed bid. Anti-shill: one bid per owner per auction, and the owner must hold a bond.
    pub fn commit_bid(&mut self, auction_id: u64, firm_id: u32, hash: String) {
        let f = self.firm(firm_id);
        Self::assert_firm_actor(&f);
        require!(f.status != FirmStatus::Liquidating, "firm in liquidation");
        require!(f.status != FirmStatus::Closed, "firm closed");
        require!(hash.len() == 64, "hash must be hex sha256");
        let mut a = self.auction(auction_id);
        require!(now() < a.commit_end, "commit phase over");
        require!(self.bonds.get(&f.owner).copied().unwrap_or(0) >= self.config.min_bond.0, "owner bond too low");
        require!(!a.bids.iter().any(|b| b.owner == f.owner), "one bid per owner (anti-shill)");
        require!(!a.bids.iter().any(|b| b.firm_id == firm_id), "firm already bid");
        match a.kind {
            AuctionKind::Liquidation(target) => require!(target != firm_id && self.firm(target).owner != f.owner, "cannot bid on own firm"),
            AuctionKind::Order(oid) => {
                require!(!f.policy.paused, "firm paused by its owner");
                // A firm under its floor stops quoting: no new escrow while it may be liquidated.
                require!(f.status == FirmStatus::Solvent, "firm under its treasury floor");
                require!(self.order(oid).client != f.owner, "cannot fill your own order");
            }
        }
        let s0 = self.usage();
        a.bids.push(Bid { firm_id, owner: f.owner.clone(), hash, revealed: None });
        self.auctions.replace(auction_id as u32, a);
        self.lock(&f.owner, true);
        self.charge(&f.owner, s0);
        emit("bid_committed", json!({"auction_id": auction_id, "firm_id": firm_id}));
    }

    pub fn reveal_bid(&mut self, auction_id: u64, firm_id: u32, amount: U128, salt: String) {
        let f = self.firm(firm_id);
        Self::assert_firm_actor(&f);
        let mut a = self.auction(auction_id);
        require!(now() >= a.commit_end && now() < a.reveal_end, "not in reveal phase");
        let i = a.bids.iter().position(|b| b.firm_id == firm_id).unwrap_or_else(|| env::panic_str("no commit"));
        require!(a.bids[i].revealed.is_none(), "already revealed");
        require!(bid_hash(auction_id, firm_id, amount.0, &salt) == a.bids[i].hash, "hash mismatch");
        require!(amount.0 >= a.reserve.0, "bid below reserve");
        require!(f.status != FirmStatus::Liquidating && f.status != FirmStatus::Closed, "firm in liquidation or closed");
        let s0 = self.usage();
        let mut f = f;
        match a.kind {
            AuctionKind::Liquidation(_) => {
                // A buyer escrows its bid from the firm treasury; only the owner may commit firm money to a takeover.
                require!(env::predecessor_account_id() == f.owner, "owner only for takeover bids");
                self.debit(&f.account, amount.0);
                f.escrow = U128(f.escrow.0 + amount.0);
            }
            AuctionKind::Order(oid) => {
                // The firm escrows what it promises to deliver: settlement cannot fail.
                let o = self.order(oid);
                self.check_policy(&f, &o, amount.0);
                let out = tokens(o.side).1;
                self.debit_t(out, &f.account, amount.0);
                if out == Token::Stable {
                    f.escrow = U128(f.escrow.0 + amount.0);
                } else {
                    f.escrow_asset = U128(f.escrow_asset.0 + amount.0);
                }
            }
        }
        let owner = f.owner.clone();
        self.save_firm(f);
        a.bids[i].revealed = Some(amount);
        self.auctions.replace(auction_id as u32, a);
        self.charge(&owner, s0);
        emit("bid_revealed", json!({"auction_id": auction_id, "firm_id": firm_id, "amount": amount}));
    }

    /// Winner index (highest bid) and second price (reserve if alone). Ties go to the earliest commit.
    pub fn clear_auction(a: &Auction) -> Option<(usize, u128)> {
        let mut r: Vec<(usize, u128)> =
            a.bids.iter().enumerate().filter_map(|(i, b)| b.revealed.map(|v| (i, v.0))).collect();
        // Stable sort keeps commit order among equal bids.
        r.sort_by(|x, y| y.1.cmp(&x.1));
        let (i, _) = *r.first()?;
        Some((i, r.get(1).map_or(a.reserve.0, |s| s.1)))
    }

    /// The owner's limits on an order bid: price band around the last clearing price, inventory cap.
    fn check_policy(&self, f: &Firm, o: &Order, out: u128) {
        let unit = self.config.asset_unit.0;
        // Stable per asset unit implied by this bid, against the reference price when the order was posted.
        let price = match o.side {
            Side::Buy => o.amount_in.0.saturating_mul(unit) / out,
            Side::Sell => out.saturating_mul(unit) / o.amount_in.0,
        };
        let anchor = o.price.0;
        let band = f.policy.band_bps as u128;
        if band > 0 {
            require!(price.abs_diff(anchor).saturating_mul(BPS) <= band.saturating_mul(anchor), "bid outside the firm's price band");
        }
        if o.side == Side::Sell {
            let stable = self.balances.get(&f.account).copied().unwrap_or(0);
            // Lenders are repaid from the stable treasury: a firm cannot turn the cash it owes into asset.
            require!(stable.saturating_sub(out) >= Self::owed_total(f), "the firm must keep the cash it owes its lenders");
            // The firm would hold more asset: check the share of its value after the fill, at the order's price.
            let asset = (self.asset_of(&f.account) + o.amount_in.0).saturating_mul(anchor) / unit;
            let nav = stable.saturating_sub(out) + asset;
            require!(asset.saturating_mul(BPS) <= f.policy.max_asset_bps as u128 * nav, "fill over the firm's inventory limit");
        }
    }

    /// Anyone can settle once the reveal phase is over.
    pub fn settle(&mut self, auction_id: u64) {
        let mut a = self.auction(auction_id);
        require!(now() >= a.reveal_end, "reveal phase not over");
        require!(!a.settled, "already settled");
        a.settled = true;
        let revealed = a.bids.iter().filter(|b| b.revealed.is_some()).count();
        let order = match a.kind {
            AuctionKind::Order(oid) => Some(self.order(oid)),
            AuctionKind::Liquidation(_) => None,
        };
        let enough = order.is_none() || revealed >= (self.config.min_bidders as usize).max(1);
        let result = if enough { Self::clear_auction(&a) } else { None };
        if let Some((i, price)) = result {
            a.winner = Some(a.bids[i].firm_id);
            a.price = Some(U128(price));
        }
        let winner_idx = result.map(|(i, _)| i);
        // What revealed bids escrowed: the order's output token, or stable for a takeover.
        let escrow = order.as_ref().map_or(Token::Stable, |o| tokens(o.side).1);
        // Release every lock; release escrows (refund losers and the winner's surplus); slash unrevealed order bids.
        for (i, b) in a.bids.clone().iter().enumerate() {
            self.lock(&b.owner, false);
            let mut f = self.firm(b.firm_id);
            match (b.revealed, &order) {
                (Some(v), _) => {
                    if escrow == Token::Stable {
                        f.escrow = U128(f.escrow.0 - v.0);
                    } else {
                        f.escrow_asset = U128(f.escrow_asset.0 - v.0);
                    }
                    let refund = if Some(i) == winner_idx { v.0 - a.price.unwrap().0 } else { v.0 };
                    self.credit_t(escrow, &f.account, refund);
                    self.save_firm(f);
                }
                // A firm put in liquidation or closed after its commit could not reveal: no slash.
                (None, Some(o)) if f.status != FirmStatus::Liquidating && f.status != FirmStatus::Closed => self.slash_no_reveal(o, b),
                _ => {}
            }
        }
        let kind = a.kind.clone();
        self.auctions.replace(auction_id as u32, a.clone());
        emit("auction_settled", json!({"auction_id": auction_id, "winner": a.winner, "price": a.price}));
        // A keeper is paid for a liquidation, or for a fill whose fee covers the reward: an order nobody
        // filled, or a self-filled dust order, would let anyone farm rewards (audit findings 07, 10).
        let pay_keeper = match kind {
            AuctionKind::Order(oid) => self.on_order_auction(oid, a.winner, a.price).map_or(false, |fee| fee >= self.config.keeper_reward.0),
            AuctionKind::Liquidation(firm_id) => {
                self.on_liquidation_auction(firm_id, a.winner, a.price);
                true
            }
        };
        if pay_keeper {
            self.reward_keeper();
        }
    }

    /// A committed order bid that is never revealed was a free option on the price: its owner's bond pays
    /// the client `no_reveal_slash_bps` of the order's stable notional (at least `slash`).
    fn slash_no_reveal(&mut self, o: &Order, b: &Bid) {
        let notional = if o.side == Side::Buy { o.amount_in.0 } else { o.min_out.0 };
        let bond = self.bonds.get(&b.owner).copied().unwrap_or(0);
        let cut = (notional * self.config.no_reveal_slash_bps as u128 / BPS).max(self.config.slash.0).min(bond);
        if cut == 0 {
            return;
        }
        self.bonds.insert(b.owner.clone(), bond - cut);
        self.credit(&o.client, cut);
        let mut f = self.firm(b.firm_id);
        f.slashed = U128(f.slashed.0 + cut);
        self.save_firm(f);
        emit("slashed", json!({"order_id": o.id, "firm_id": b.firm_id, "owner": b.owner, "amount": U128(cut), "reason": "bid not revealed"}));
    }

    /// Pay the caller a small reward out of Tontine's fee balance, if there is enough in it. Only an
    /// account that already has a ledger entry is paid, so a reward never grows unpaid state.
    fn reward_keeper(&mut self) {
        let r = self.config.keeper_reward.0;
        let admin = self.config.admin.clone();
        let keeper = env::predecessor_account_id();
        if r == 0 || keeper == admin || self.balances.get(&keeper).is_none() || self.balances.get(&admin).copied().unwrap_or(0) < r {
            return;
        }
        self.debit(&admin, r);
        self.credit(&keeper, r);
        emit("keeper_paid", json!({"keeper": keeper, "amount": U128(r)}));
    }

    // ---------------------------------------------------------------- orders

    #[payable]
    pub fn post_order(&mut self, order: PostOrder) -> u64 {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        let s0 = self.usage();
        let id = self.post_order_from(me.clone(), order);
        self.charge(&me, s0);
        id
    }

    /// Escrow what the client sells and open the auction; `min_out` is its reserve.
    fn post_order_from(&mut self, client: AccountId, p: PostOrder) -> u64 {
        require!(p.amount_in.0 > 0 && p.min_out.0 > 0, "amount_in and min_out must be > 0");
        let notional = if p.side == Side::Buy { p.amount_in.0 } else { p.min_out.0 };
        require!(notional >= self.config.min_order.0, "order below the minimum size");
        require!(p.commit_secs <= MAX_ORDER_PHASE_SECS && p.reveal_secs <= MAX_ORDER_PHASE_SECS, "order phases at most 10 minutes");
        let (tin, tout) = tokens(p.side);
        self.debit_t(tin, &client, p.amount_in.0);
        // The ledger entry the fill credits, created now so the client pays its storage.
        if tout == Token::Asset && self.assets.get(&client).is_none() {
            self.assets.insert(client.clone(), 0);
        } else if tout == Token::Stable && self.balances.get(&client).is_none() {
            self.balances.insert(client.clone(), 0);
        }
        let id = self.orders.len() as u64;
        let auction = self.new_auction(AuctionKind::Order(id), p.min_out.0, p.commit_secs, p.reveal_secs);
        self.orders.push(Order {
            id,
            client: client.clone(),
            side: p.side,
            amount_in: p.amount_in,
            min_out: p.min_out,
            reference_out: p.reference_out,
            price: U128(self.last_price),
            auction,
            status: OrderStatus::Open,
            firm: None,
            out: None,
        });
        emit(
            "order_posted",
            json!({"order_id": id, "client": client, "side": p.side, "amount_in": p.amount_in, "min_out": p.min_out, "reference_out": p.reference_out, "auction_id": auction}),
        );
        id
    }

    fn order(&self, id: u64) -> Order {
        self.orders.get(id as u32).cloned().unwrap_or_else(|| env::panic_str("no order"))
    }

    /// Fill or refund. The winner's escrow already holds what it bid; it delivers the second-best amount
    /// (`price`), keeps the rest, and receives what the client sold, minus Tontine's fee. The fill's edge
    /// against the previous clearing price is the firm's realized result: 30% of a positive edge goes to
    /// its shareholders at once.
    /// Returns Tontine's fee on the fill, None when the order is refunded.
    fn on_order_auction(&mut self, id: u64, winner: Option<u32>, price: Option<U128>) -> Option<u128> {
        let mut o = self.order(id);
        let (tin, tout) = tokens(o.side);
        let (Some(fid), Some(out)) = (winner, price) else {
            self.credit_t(tin, &o.client, o.amount_in.0);
            o.status = OrderStatus::Refunded;
            emit("order_refunded", json!({"order_id": id, "client": o.client}));
            self.orders.replace(id as u32, o);
            return None;
        };
        let mut f = self.firm(fid);
        let (amount_in, out) = (o.amount_in.0, out.0);
        let fee = amount_in * self.config.order_fee_bps as u128 / BPS;
        self.credit_t(tout, &o.client, out);
        self.credit_t(tin, &f.account, amount_in - fee);
        self.credit_t(tin, &self.config.admin.clone(), fee);

        let unit = self.config.asset_unit.0;
        let (edge, notional, price) = match o.side {
            // Received stable, delivered asset.
            Side::Buy => ((amount_in - fee) as i128 - self.value(out) as i128, amount_in, amount_in.saturating_mul(unit) / out),
            // Received asset, delivered stable.
            Side::Sell => (self.value(amount_in - fee) as i128 - out as i128, out, out.saturating_mul(unit) / amount_in),
        };
        // The reference price follows fills, at most max_move_bps per window in total: a run of
        // self-fills cannot walk it far, nor overflow it.
        let m = self.config.max_move_bps as u128;
        if now() >= self.price_anchor_at + PRICE_WINDOW_SECS * SEC {
            self.price_anchor = self.last_price;
            self.price_anchor_at = now();
        }
        let a = self.price_anchor;
        let (lo, hi) = ((a.saturating_mul(BPS.saturating_sub(m)) / BPS).max(1), (a.saturating_mul(BPS + m) / BPS).max(a.saturating_add(1)));
        let price = if m == 0 { price } else { price.clamp(lo, hi) };
        if edge > 0 {
            let div = (edge as u128 * self.config.dividend_bps as u128 / BPS).min(self.balances.get(&f.account).copied().unwrap_or(0));
            let dust = Self::distribute(&mut f, div);
            self.debit(&f.account.clone(), div - dust);
            f.dividends = U128(f.dividends.0 + div - dust);
        }
        f.edge = I128(f.edge.0 + edge);
        f.fills += 1;
        f.volume = U128(f.volume.0 + notional);
        self.last_price = price;
        o.status = OrderStatus::Filled;
        o.firm = Some(fid);
        o.out = Some(U128(out));
        emit(
            "order_filled",
            json!({"order_id": id, "firm_id": fid, "side": o.side, "amount_in": o.amount_in, "out": U128(out), "min_out": o.min_out, "reference_out": o.reference_out, "fee": U128(fee), "edge": I128(edge), "price": U128(price)}),
        );
        self.save_firm(f);
        self.orders.replace(id as u32, o);
        Some(fee)
    }

    // ---------------------------------------------------------------- epochs & liquidation

    /// Anyone can tick once per epoch. A firm below the treasury floor for N epochs is put up for sale.
    /// ponytail: iterates every firm, fine for tens of firms; paginate if the registry grows.
    pub fn epoch_tick(&mut self) {
        require!(now() >= self.last_epoch + self.config.epoch_secs * SEC, "epoch not over");
        self.last_epoch = now();
        for id in 0..self.firms.len() {
            let mut f = self.firm(id);
            if f.status == FirmStatus::Closed {
                continue;
            }
            if f.status == FirmStatus::Liquidating {
                if f.liquidation_auction.is_none() {
                    self.start_liquidation(&mut f);
                }
                self.save_firm(f);
                continue;
            }
            // The floor is a cash requirement: the stable treasury, escrows of open bids included. It never
            // depends on a price, so no fill elsewhere can push a firm into liquidation.
            if self.balances.get(&f.account).copied().unwrap_or(0) + f.escrow.0 < self.config.treasury_floor.0 {
                f.epochs_below_floor += 1;
                f.status = FirmStatus::Illiquid;
                if f.epochs_below_floor >= self.config.epochs_before_liquidation {
                    f.status = FirmStatus::Liquidating;
                    self.start_liquidation(&mut f);
                }
            } else {
                f.epochs_below_floor = 0;
                f.status = FirmStatus::Solvent;
            }
            self.save_firm(f);
        }
        self.reward_keeper();
    }

    fn start_liquidation(&mut self, f: &mut Firm) {
        let (c, r) = (self.config.liquidation_commit_secs, self.config.liquidation_reveal_secs);
        // The asset inventory goes to the shareholders in kind, not to the buyer: any bid buys the firm.
        let id = self.new_auction(AuctionKind::Liquidation(f.id), 1, c, r);
        f.liquidation_auction = Some(id);
        emit("liquidation_started", json!({"firm_id": f.id, "auction_id": id}));
    }

    /// Cascade: fee, then creditors, then shareholders. The buyer firm gets 100% of the shares and the owner field.
    fn on_liquidation_auction(&mut self, firm_id: u32, winner: Option<u32>, price: Option<U128>) {
        let mut f = self.firm(firm_id);
        // Escrows of its own open bids would come back to the firm after the sale: settle them first.
        require!(f.escrow.0 == 0 && f.escrow_asset.0 == 0, "the firm has open bids: settle them first");
        f.liquidation_auction = None;
        let (Some(buyer_id), Some(price)) = (winner, price) else {
            // Nobody wants it: wind it up.
            self.wind_up(&mut f, "no buyer");
            self.save_firm(f);
            return;
        };
        let buyer = self.firm(buyer_id);
        let fee = price.0 * self.config.liquidation_fee_bps as u128 / BPS;
        self.credit(&self.config.admin.clone(), fee);
        // The firm's remaining treasury is sold with it: it joins the pot instead of going to the buyer.
        let treasury = self.balances.get(&f.account).copied().unwrap_or(0);
        self.debit(&f.account.clone(), treasury);
        let rest = self.pay_creditors(&mut f, price.0 - fee + treasury);
        for i in 0..f.holdings.len() {
            self.settle_holding(&mut f, i);
        }
        let dust = Self::distribute(&mut f, rest);
        for i in 0..f.holdings.len() {
            self.settle_holding(&mut f, i);
        }
        self.credit(&f.account.clone(), dust);
        // The asset inventory goes to the old shareholders in kind: the buyer cannot take it for any price.
        let asset_out = self.asset_to_holders(&f);
        for h in &f.holdings {
            emit_mt(
                "mt_transfer",
                json!({"old_owner_id": h.account, "new_owner_id": buyer.account, "token_ids": [f.id.to_string()], "amounts": [h.shares.to_string()]}),
            );
        }
        let acc = f.acc_per_share.0;
        f.holdings = vec![Holding { account: buyer.account.clone(), shares: SHARES, debt: U128(SHARES as u128 * acc) }];
        f.debts.clear();
        let old_owner = std::mem::replace(&mut f.owner, buyer.owner.clone());
        f.status = FirmStatus::Solvent;
        f.epochs_below_floor = 0;
        f.takeovers += 1;
        f.owner_synced = false;
        emit(
            "liquidated",
            json!({"firm_id": f.id, "buyer_firm_id": buyer_id, "old_owner": old_owner, "new_owner": buyer.owner, "price": price, "fee": U128(fee), "to_shareholders": U128(rest - dust), "asset_to_shareholders": U128(asset_out)}),
        );
        let id = f.id;
        self.save_firm(f);
        self.push_owner(id).detach();
    }

    /// Owner publishes the firm's spec (JSON, at most 2000 bytes), so clients and other agents know what
    /// it does, with which model and for which budgets. See SDK.md for the fields.
    #[payable]
    pub fn set_firm_profile(&mut self, firm_id: u32, profile: String) {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        let mut f = self.firm(firm_id);
        require!(me == f.owner, "owner only");
        require!(profile.len() <= 2000, "profile too long");
        require!(serde_json::from_str::<serde_json::Value>(&profile).map(|v| v.is_object()).unwrap_or(false), "profile must be a JSON object");
        let s0 = self.usage();
        f.profile = Some(profile.clone());
        self.save_firm(f);
        self.charge(&me, s0);
        emit("firm_profile", json!({"firm_id": firm_id, "profile": profile}));
    }

    /// Owner closes its firm: the treasury pays the creditors (with interest), then the shareholders.
    #[payable]
    pub fn close_firm(&mut self, firm_id: u32) {
        near_sdk::assert_one_yocto();
        let mut f = self.firm(firm_id);
        require!(env::predecessor_account_id() == f.owner, "owner only");
        require!(f.status != FirmStatus::Liquidating && f.status != FirmStatus::Closed, "firm in liquidation or closed");
        require!(self.locks.get(&f.owner).copied().unwrap_or(0) == 0, "settle the open bids first");
        self.wind_up(&mut f, "closed by its owner");
        self.save_firm(f);
    }

    fn wind_up(&mut self, f: &mut Firm, reason: &str) {
        require!(f.escrow.0 == 0 && f.escrow_asset.0 == 0, "the firm has open bids: settle them first");
        let treasury = self.balances.get(&f.account).copied().unwrap_or(0);
        self.debit(&f.account.clone(), treasury);
        let rest = self.pay_creditors(f, treasury);
        for i in 0..f.holdings.len() {
            self.settle_holding(f, i);
        }
        let dust = Self::distribute(f, rest);
        for i in 0..f.holdings.len() {
            self.settle_holding(f, i);
        }
        self.credit(&self.config.admin.clone(), dust);
        let given = self.asset_to_holders(f);
        f.status = FirmStatus::Closed;
        f.liquidation_auction = None;
        emit("firm_closed", json!({"firm_id": f.id, "reason": reason, "to_shareholders": U128(rest - dust), "asset_to_shareholders": U128(given)}));
    }

    /// The asset inventory goes to the shareholders in kind, pro rata; the rounding remainder to Tontine.
    /// Lenders are owed stable only, and a firm cannot turn the cash it owes them into asset (check_policy).
    fn asset_to_holders(&mut self, f: &Firm) -> u128 {
        let asset = self.asset_of(&f.account);
        if asset == 0 {
            return 0;
        }
        self.debit_t(Token::Asset, &f.account.clone(), asset);
        let mut given = 0;
        for h in f.holdings.clone() {
            let part = asset * h.shares as u128 / SHARES as u128;
            self.credit_t(Token::Asset, &h.account, part);
            given += part;
        }
        self.credit_t(Token::Asset, &self.config.admin.clone(), asset - given);
        given
    }

    /// The firm contract has no full access key: ownership changes only through this call.
    fn push_owner(&self, firm_id: u32) -> Promise {
        let f = self.firm(firm_id);
        ext_firm::ext(f.account)
            .with_static_gas(GAS_TRANSFER)
            .set_owner(f.owner.clone())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_set_owner(firm_id, f.owner))
    }

    #[private]
    pub fn on_set_owner(&mut self, firm_id: u32, owner: AccountId) -> bool {
        let ok = env::promise_result_checked(0, 1024).is_ok();
        let mut f = self.firm(firm_id);
        // A later takeover may have changed the owner again: only confirm the current one.
        if ok && f.owner == owner {
            f.owner_synced = true;
            self.save_firm(f);
        } else if !ok {
            emit("owner_sync_failed", json!({"firm_id": firm_id, "owner": owner}));
        }
        ok
    }

    /// Anyone can retry pushing the owner to the firm contract after a failed sync.
    pub fn sync_owner(&mut self, firm_id: u32) -> Promise {
        require!(!self.firm(firm_id).owner_synced, "owner already synced");
        self.push_owner(firm_id)
    }

    // ---------------------------------------------------------------- views

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }
    pub fn balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }
    pub fn bond_of(&self, account_id: AccountId) -> U128 {
        U128(self.bonds.get(&account_id).copied().unwrap_or(0))
    }
    pub fn get_firm(&self, firm_id: u32) -> Firm {
        self.firm(firm_id)
    }
    pub fn get_firms(&self) -> Vec<Firm> {
        self.firms.iter().cloned().collect()
    }
    pub fn firm_id_of(&self, account_id: AccountId) -> Option<u32> {
        self.firm_by_account.get(&account_id).copied()
    }
    pub fn get_order(&self, order_id: u64) -> Order {
        self.order(order_id)
    }
    pub fn get_orders(&self, from: u64, limit: u64) -> Vec<Order> {
        self.orders.iter().skip(from as usize).take(limit as usize).cloned().collect()
    }
    pub fn asset_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.asset_of(&account_id))
    }
    pub fn get_last_price(&self) -> U128 {
        U128(self.last_price)
    }
    pub fn nav_of(&self, firm_id: u32) -> U128 {
        U128(self.nav(&self.firm(firm_id)))
    }
    pub fn get_auction(&self, auction_id: u64) -> Auction {
        self.auction(auction_id)
    }
    pub fn get_ask(&self, firm_id: u32, seller: AccountId) -> Option<Ask> {
        self.asks.get(&format!("{firm_id}:{seller}")).cloned()
    }
    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        let id: u32 = token_id.parse().unwrap_or_else(|_| env::panic_str("bad token id"));
        U128(self.firm(id).holdings.iter().find(|h| h.account == account_id).map_or(0, |h| h.shares as u128))
    }
    pub fn pending_dividends(&self, firm_id: u32, account_id: AccountId) -> U128 {
        let f = self.firm(firm_id);
        U128(f.holdings.iter().find(|h| h.account == account_id).map_or(0, |h| (h.shares as u128 * f.acc_per_share.0 - h.debt.0) / PREC))
    }
    pub fn hash_bid(&self, auction_id: u64, firm_id: u32, amount: U128, salt: String) -> String {
        bid_hash(auction_id, firm_id, amount.0, &salt)
    }
}

#[cfg(test)]
mod tests;
