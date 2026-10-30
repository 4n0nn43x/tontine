//! tender: the market contract of Tontine.
//!
//! One sealed-bid second-price auction (commit-reveal) serves two purposes:
//! - jobs: reverse auction, the lowest bid wins and is paid the second-lowest price;
//! - liquidations: forward auction, the highest bid buys the bankrupt firm at the second-highest price.
//!
//! Money is an internal ledger in one stable token (USDC base units). Deposits arrive by
//! `ft_on_transfer` (plain NEP-141) or `mt_on_transfer` (NEAR Intents, NEP-245). Firm shares are
//! NEP-245 tokens (token_id = firm id, 100 per firm) with Synthetix-style dividends.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseOrValue,
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
/// After this long without a verdict, anyone can cancel a delivered job (judge outage, no slash).
const JUDGE_TIMEOUT_SECS: u64 = 3 * 86_400;

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
    /// Delivery oracle: the account that posts the attested LLM verdict.
    pub judge: AccountId,
    pub payment: Payment,
    pub dividend_bps: u16,
    pub liquidation_fee_bps: u16,
    pub min_bond: U128,
    pub slash: U128,
    pub treasury_floor: U128,
    pub epochs_before_liquidation: u32,
    pub epoch_secs: u64,
    pub liquidation_commit_secs: u64,
    pub liquidation_reveal_secs: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum FirmStatus {
    Solvent,
    Illiquid,
    Liquidating,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Holding {
    pub account: AccountId,
    pub shares: u32,
    /// shares * acc_per_share (full precision, not divided by PREC) already paid or forfeited.
    pub debt: U128,
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
    pub debts: Vec<(AccountId, U128)>,
    pub epochs_below_floor: u32,
    pub liquidation_auction: Option<u64>,
    // KYA registry and P&L
    pub delivered: u32,
    pub rejected: u32,
    pub slashed: U128,
    pub revenue: U128,
    pub dividends: U128,
    pub takeovers: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum AuctionKind {
    Job(u64),
    Liquidation(u32),
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Bid {
    pub firm_id: u32,
    pub owner: AccountId,
    /// hex(sha256("{amount}:{salt}"))
    pub hash: String,
    pub revealed: Option<U128>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Auction {
    pub kind: AuctionKind,
    /// true: lowest bid wins (jobs). false: highest bid wins (liquidations).
    pub reverse: bool,
    /// Reverse: price ceiling (job budget). Forward: price floor.
    pub reserve: U128,
    pub commit_end: u64,
    pub reveal_end: u64,
    pub bids: Vec<Bid>,
    pub settled: bool,
    pub winner: Option<u32>,
    pub price: Option<U128>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum JobStatus {
    Bidding,
    Assigned,
    Delivered,
    Paid,
    Rejected,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Job {
    pub id: u64,
    pub client: AccountId,
    pub budget: U128,
    pub brief: String,
    pub auction: u64,
    pub status: JobStatus,
    pub deliver_secs: u64,
    pub deadline: Option<u64>,
    pub result: Option<String>,
    pub attestation: Option<String>,
    /// Owner of the winning firm when it bid: its lock and bond back this job, even if the firm is sold.
    pub winner_owner: Option<AccountId>,
}

#[near(serializers = [json])]
pub struct PostJob {
    pub budget: U128,
    pub brief: String,
    pub commit_secs: u64,
    pub reveal_secs: u64,
    pub deliver_secs: u64,
}

/// `msg` of a deposit. Empty msg = plain deposit to the sender.
#[near(serializers = [json])]
pub enum DepositAction {
    PostJob(PostJob),
    /// Credit another account (e.g. fund a firm treasury).
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
    Bonds,
    Locks,
    Firms,
    FirmByAccount,
    Jobs,
    Auctions,
    Asks,
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
    balances: LookupMap<AccountId, u128>,
    bonds: LookupMap<AccountId, u128>,
    /// Open commitments per owner (bids not yet settled + assigned jobs). Bond is locked while > 0.
    locks: LookupMap<AccountId, u32>,
    firms: Vector<Firm>,
    firm_by_account: LookupMap<AccountId, u32>,
    jobs: Vector<Job>,
    auctions: Vector<Auction>,
    asks: LookupMap<String, Ask>,
    last_epoch: u64,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn bid_hash(amount: u128, salt: &str) -> String {
    hex(&env::sha256(format!("{amount}:{salt}").as_bytes()))
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
        require!(config.dividend_bps as u128 <= BPS && config.liquidation_fee_bps as u128 <= BPS, "bps > 100%");
        Self {
            config,
            balances: LookupMap::new(Key::Balances),
            bonds: LookupMap::new(Key::Bonds),
            locks: LookupMap::new(Key::Locks),
            firms: Vector::new(Key::Firms),
            firm_by_account: LookupMap::new(Key::FirmByAccount),
            jobs: Vector::new(Key::Jobs),
            auctions: Vector::new(Key::Auctions),
            asks: LookupMap::new(Key::Asks),
            last_epoch: now(),
        }
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

    fn apply_deposit(&mut self, sender: AccountId, amount: u128, msg: &str) {
        self.credit(&sender, amount);
        emit("deposit", json!({"account": sender, "amount": U128(amount)}));
        if msg.is_empty() {
            return;
        }
        match serde_json::from_str::<DepositAction>(msg).unwrap_or_else(|_| env::panic_str("bad msg")) {
            DepositAction::PostJob(p) => {
                self.post_job_from(sender, p);
            }
            DepositAction::Credit(to) => {
                self.debit(&sender, amount);
                self.credit(&to, amount);
            }
        }
    }

    /// NEP-141 receiver. Only the configured token is accepted.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        match &self.config.payment {
            Payment::Ft { token } => require!(&env::predecessor_account_id() == token, "wrong token"),
            _ => env::panic_str("ft deposits disabled"),
        }
        self.apply_deposit(sender_id, amount.0, &msg);
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
        match &self.config.payment {
            Payment::Intents { contract, token_id } => {
                require!(&env::predecessor_account_id() == contract, "wrong mt contract");
                require!(token_ids.len() == 1 && &token_ids[0] == token_id, "wrong token id");
            }
            _ => env::panic_str("intents deposits disabled"),
        }
        require!(previous_owner_ids.len() == 1 && amounts.len() == 1, "single token only");
        self.apply_deposit(previous_owner_ids[0].clone(), amounts[0].0, &msg);
        PromiseOrValue::Value(vec![U128(0)])
    }

    /// Internal transfer between ledger accounts.
    #[payable]
    pub fn transfer(&mut self, receiver_id: AccountId, amount: U128) {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        self.debit(&me, amount.0);
        self.credit(&receiver_id, amount.0);
        emit("transfer", json!({"from": me, "to": receiver_id, "amount": amount}));
    }

    /// Withdraw ledger balance out of the contract (ft_transfer or intents mt_transfer).
    #[payable]
    pub fn withdraw(&mut self, amount: U128, receiver_id: Option<AccountId>) -> Promise {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        let to = receiver_id.unwrap_or_else(|| me.clone());
        self.debit(&me, amount.0);
        let p = match &self.config.payment {
            Payment::Ft { token } => ext_ft::ext(token.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_TRANSFER)
                .ft_transfer(to, amount, None),
            Payment::Intents { contract, token_id } => ext_mt::ext(contract.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_TRANSFER)
                .mt_transfer(to, token_id.clone(), amount, None, None),
        };
        p.then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_withdraw(me, amount))
    }

    #[private]
    pub fn on_withdraw(&mut self, account: AccountId, amount: U128) -> bool {
        let ok = matches!(env::promise_result_checked(0, 1024), Ok(_));
        if ok {
            emit("withdraw", json!({"account": account, "amount": amount}));
        } else {
            self.credit(&account, amount.0);
        }
        ok
    }

    // ---------------------------------------------------------------- bonds

    #[payable]
    pub fn deposit_bond(&mut self, amount: U128) {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        self.debit(&me, amount.0);
        let b = self.bonds.get(&me).copied().unwrap_or(0);
        self.bonds.insert(me, b + amount.0);
    }

    #[payable]
    pub fn withdraw_bond(&mut self, amount: U128) {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        require!(self.locks.get(&me).copied().unwrap_or(0) == 0, "bond locked by open bids or jobs");
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
            epochs_below_floor: 0,
            liquidation_auction: None,
            delivered: 0,
            rejected: 0,
            slashed: U128(0),
            revenue: U128(0),
            dividends: U128(0),
            takeovers: 0,
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
        self.settle_holding(&mut f, i);
        self.save_firm(f);
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
        self.move_shares(&mut f, &env::predecessor_account_id(), &receiver_id, amount);
        self.save_firm(f);
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
        self.asks.insert(format!("{firm_id}:{me}"), Ask { amount, price_per_share, takeover: f.takeovers });
        emit("shares_listed", json!({"firm_id": firm_id, "seller": me, "amount": amount, "price_per_share": price_per_share}));
    }

    #[payable]
    pub fn buy_shares(&mut self, firm_id: u32, seller: AccountId, amount: u32) {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        let key = format!("{firm_id}:{seller}");
        let mut ask = self.asks.get(&key).cloned().unwrap_or_else(|| env::panic_str("no ask"));
        require!(amount > 0 && ask.amount >= amount, "ask too small");
        let cost = ask.price_per_share.0 * amount as u128;
        self.debit(&me, cost);
        self.credit(&seller, cost);
        let mut f = self.firm(firm_id);
        require!(f.status != FirmStatus::Liquidating, "firm in liquidation");
        require!(ask.takeover == f.takeovers, "ask voided by a takeover");
        self.move_shares(&mut f, &seller, &me, amount);
        self.save_firm(f);
        ask.amount -= amount;
        if ask.amount == 0 {
            self.asks.remove(&key);
        } else {
            self.asks.insert(key, ask);
        }
        emit("shares_bought", json!({"firm_id": firm_id, "seller": seller, "buyer": me, "amount": amount, "cost": U128(cost)}));
    }

    /// Lend to a firm treasury. The lender becomes a creditor, paid before shareholders in a liquidation.
    #[payable]
    pub fn lend(&mut self, firm_id: u32, amount: U128) {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        let mut f = self.firm(firm_id);
        // A loan during the sale would be repaid ahead of shareholders out of the buyer's own price.
        require!(f.status != FirmStatus::Liquidating, "firm in liquidation");
        self.debit(&me, amount.0);
        self.credit(&f.account, amount.0);
        f.debts.push((me.clone(), amount));
        self.save_firm(f);
        emit("loan", json!({"firm_id": firm_id, "lender": me, "amount": amount}));
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
        for (who, owed) in debts.iter_mut() {
            let pay = pot.min(owed.0);
            if pay > 0 {
                self.credit(who, pay);
                owed.0 -= pay;
                pot -= pay;
                emit("creditor_paid", json!({"firm_id": f.id, "creditor": who, "amount": U128(pay)}));
            }
        }
        f.debts = debts.into_iter().filter(|(_, d)| d.0 > 0).collect();
        pot
    }

    // ---------------------------------------------------------------- auction (shared by jobs and liquidations)

    fn new_auction(&mut self, kind: AuctionKind, reverse: bool, reserve: u128, commit_secs: u64, reveal_secs: u64) -> u64 {
        require!(commit_secs > 0 && reveal_secs > 0, "phases must be > 0");
        require!(commit_secs <= MAX_PHASE_SECS && reveal_secs <= MAX_PHASE_SECS, "phase too long");
        let commit_end = now() + commit_secs * SEC;
        let id = self.auctions.len() as u64;
        self.auctions.push(Auction {
            kind: kind.clone(),
            reverse,
            reserve: U128(reserve),
            commit_end,
            reveal_end: commit_end + reveal_secs * SEC,
            bids: vec![],
            settled: false,
            winner: None,
            price: None,
        });
        emit("auction_opened", json!({"auction_id": id, "kind": kind, "reverse": reverse, "reserve": U128(reserve)}));
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
        require!(hash.len() == 64, "hash must be hex sha256");
        let mut a = self.auction(auction_id);
        require!(now() < a.commit_end, "commit phase over");
        require!(self.bonds.get(&f.owner).copied().unwrap_or(0) >= self.config.min_bond.0, "owner bond too low");
        require!(!a.bids.iter().any(|b| b.owner == f.owner), "one bid per owner (anti-shill)");
        require!(!a.bids.iter().any(|b| b.firm_id == firm_id), "firm already bid");
        if let AuctionKind::Liquidation(target) = a.kind {
            require!(target != firm_id && self.firm(target).owner != f.owner, "cannot bid on own firm");
        }
        a.bids.push(Bid { firm_id, owner: f.owner.clone(), hash, revealed: None });
        self.auctions.replace(auction_id as u32, a);
        self.lock(&f.owner, true);
        emit("bid_committed", json!({"auction_id": auction_id, "firm_id": firm_id}));
    }

    pub fn reveal_bid(&mut self, auction_id: u64, firm_id: u32, amount: U128, salt: String) {
        let f = self.firm(firm_id);
        Self::assert_firm_actor(&f);
        let mut a = self.auction(auction_id);
        require!(now() >= a.commit_end && now() < a.reveal_end, "not in reveal phase");
        let i = a.bids.iter().position(|b| b.firm_id == firm_id).unwrap_or_else(|| env::panic_str("no commit"));
        require!(a.bids[i].revealed.is_none(), "already revealed");
        require!(bid_hash(amount.0, &salt) == a.bids[i].hash, "hash mismatch");
        if a.reverse {
            require!(amount.0 <= a.reserve.0, "bid above budget");
        } else {
            require!(amount.0 >= a.reserve.0, "bid below reserve");
            // A buyer escrows its bid from the firm treasury; only the owner may commit firm money to a takeover.
            require!(env::predecessor_account_id() == f.owner, "owner only for takeover bids");
            require!(f.status != FirmStatus::Liquidating, "firm in liquidation");
            self.debit(&f.account, amount.0);
        }
        a.bids[i].revealed = Some(amount);
        self.auctions.replace(auction_id as u32, a);
        emit("bid_revealed", json!({"auction_id": auction_id, "firm_id": firm_id, "amount": amount}));
    }

    /// Winner index and second price (reserve if alone). Ties go to the earliest commit.
    pub fn clear_auction(a: &Auction) -> Option<(usize, u128)> {
        let mut r: Vec<(usize, u128)> =
            a.bids.iter().enumerate().filter_map(|(i, b)| b.revealed.map(|v| (i, v.0))).collect();
        // Stable sort keeps commit order among equal bids.
        r.sort_by(|x, y| if a.reverse { x.1.cmp(&y.1) } else { y.1.cmp(&x.1) });
        let (i, _) = *r.first()?;
        Some((i, r.get(1).map_or(a.reserve.0, |s| s.1)))
    }

    /// Anyone can settle once the reveal phase is over.
    pub fn settle(&mut self, auction_id: u64) {
        let mut a = self.auction(auction_id);
        require!(now() >= a.reveal_end, "reveal phase not over");
        require!(!a.settled, "already settled");
        a.settled = true;
        let result = Self::clear_auction(&a);
        if let Some((i, price)) = result {
            a.winner = Some(a.bids[i].firm_id);
            a.price = Some(U128(price));
        }
        let winner_idx = result.map(|(i, _)| i);
        // Release locks of losers; refund escrowed takeover bids of losers and the winner's surplus.
        for (i, b) in a.bids.clone().iter().enumerate() {
            let is_winner = Some(i) == winner_idx;
            if !is_winner || !a.reverse {
                self.lock(&b.owner, false);
            }
            if !a.reverse {
                if let Some(v) = b.revealed {
                    let acct = self.firm(b.firm_id).account;
                    let refund = if is_winner { v.0 - a.price.unwrap().0 } else { v.0 };
                    self.credit(&acct, refund);
                }
            }
        }
        let kind = a.kind.clone();
        self.auctions.replace(auction_id as u32, a.clone());
        emit("auction_settled", json!({"auction_id": auction_id, "winner": a.winner, "price": a.price}));
        match kind {
            AuctionKind::Job(job_id) => {
                let owner = winner_idx.map(|i| a.bids[i].owner.clone());
                self.on_job_auction(job_id, owner, a.price)
            }
            AuctionKind::Liquidation(firm_id) => self.on_liquidation_auction(firm_id, a.winner, a.price),
        }
    }

    // ---------------------------------------------------------------- jobs

    #[payable]
    pub fn post_job(&mut self, job: PostJob) -> u64 {
        near_sdk::assert_one_yocto();
        self.post_job_from(env::predecessor_account_id(), job)
    }

    fn post_job_from(&mut self, client: AccountId, p: PostJob) -> u64 {
        require!(p.budget.0 > 0, "budget must be > 0");
        require!(p.brief.len() <= 2000, "brief too long");
        require!(p.deliver_secs > 0 && p.deliver_secs <= MAX_PHASE_SECS, "deliver_secs out of range");
        self.debit(&client, p.budget.0);
        let id = self.jobs.len() as u64;
        let auction = self.new_auction(AuctionKind::Job(id), true, p.budget.0, p.commit_secs, p.reveal_secs);
        self.jobs.push(Job {
            id,
            client: client.clone(),
            budget: p.budget,
            brief: p.brief.clone(),
            auction,
            status: JobStatus::Bidding,
            deliver_secs: p.deliver_secs,
            deadline: None,
            result: None,
            attestation: None,
            winner_owner: None,
        });
        emit("job_posted", json!({"job_id": id, "client": client, "budget": p.budget, "brief": p.brief, "auction_id": auction}));
        id
    }

    fn job(&self, id: u64) -> Job {
        self.jobs.get(id as u32).cloned().unwrap_or_else(|| env::panic_str("no job"))
    }

    fn on_job_auction(&mut self, job_id: u64, winner_owner: Option<AccountId>, price: Option<U128>) {
        let mut j = self.job(job_id);
        match (winner_owner, price) {
            (Some(o), Some(p)) => {
                j.winner_owner = Some(o);
                self.credit(&j.client, j.budget.0 - p.0);
                j.status = JobStatus::Assigned;
                j.deadline = Some(now() + j.deliver_secs * SEC);
            }
            _ => {
                self.credit(&j.client, j.budget.0);
                j.status = JobStatus::Cancelled;
            }
        }
        self.jobs.replace(job_id as u32, j);
    }

    fn winner_of(&self, j: &Job) -> (Firm, u128) {
        let a = self.auction(j.auction);
        (self.firm(a.winner.unwrap()), a.price.unwrap().0)
    }

    pub fn deliver(&mut self, job_id: u64, result: String) {
        let mut j = self.job(job_id);
        require!(j.status == JobStatus::Assigned, "job not assigned");
        require!(now() <= j.deadline.unwrap(), "deadline passed");
        require!(result.len() <= 4000, "result too long");
        let (f, _) = self.winner_of(&j);
        Self::assert_firm_actor(&f);
        j.status = JobStatus::Delivered;
        j.result = Some(result.clone());
        self.jobs.replace(job_id as u32, j);
        emit("delivered", json!({"job_id": job_id, "firm_id": f.id, "result": result}));
    }

    /// The delivery oracle posts its verdict with the NEAR AI Cloud attestation (signature payload).
    pub fn verdict(&mut self, job_id: u64, accept: bool, attestation: String) {
        require!(env::predecessor_account_id() == self.config.judge, "judge only");
        require!(attestation.len() <= 4000, "attestation too long");
        let mut j = self.job(job_id);
        require!(j.status == JobStatus::Delivered, "nothing delivered");
        j.attestation = Some(attestation);
        if accept {
            self.pay(&mut j);
        } else {
            self.reject(&mut j);
        }
        self.jobs.replace(job_id as u32, j);
    }

    /// Anyone can expire a job: undelivered after its deadline (rejected, slashed), or delivered with
    /// no verdict for JUDGE_TIMEOUT_SECS after the deadline (cancelled, client refunded, no slash).
    pub fn expire(&mut self, job_id: u64) {
        let mut j = self.job(job_id);
        let deadline = j.deadline.unwrap_or(u64::MAX);
        if j.status == JobStatus::Assigned && now() > deadline {
            self.reject(&mut j);
        } else if j.status == JobStatus::Delivered && now() > deadline + JUDGE_TIMEOUT_SECS * SEC {
            let (_, price) = self.winner_of(&j);
            self.credit(&j.client, price);
            self.lock(&j.winner_owner.clone().unwrap(), false);
            j.status = JobStatus::Cancelled;
            emit("verdict_timeout", json!({"job_id": j.id, "refund": U128(price)}));
        } else {
            env::panic_str("not expired");
        }
        self.jobs.replace(job_id as u32, j);
    }

    fn pay(&mut self, j: &mut Job) {
        let (mut f, price) = self.winner_of(j);
        let div = price * self.config.dividend_bps as u128 / BPS;
        let dust = Self::distribute(&mut f, div);
        let to_firm = price - div + dust;
        self.credit(&f.account.clone(), to_firm);
        f.delivered += 1;
        f.revenue = U128(f.revenue.0 + price);
        f.dividends = U128(f.dividends.0 + div - dust);
        self.lock(&j.winner_owner.clone().unwrap(), false);
        emit("paid", json!({"job_id": j.id, "firm_id": f.id, "price": U128(price), "to_firm": U128(to_firm), "dividends": U128(div - dust)}));
        self.save_firm(f);
        j.status = JobStatus::Paid;
    }

    fn reject(&mut self, j: &mut Job) {
        let (mut f, price) = self.winner_of(j);
        let owner = j.winner_owner.clone().unwrap();
        self.credit(&j.client, price);
        let bond = self.bonds.get(&owner).copied().unwrap_or(0);
        let slash = bond.min(self.config.slash.0);
        self.bonds.insert(owner.clone(), bond - slash);
        self.credit(&j.client, slash);
        f.rejected += 1;
        f.slashed = U128(f.slashed.0 + slash);
        self.lock(&owner, false);
        emit("slashed", json!({"job_id": j.id, "firm_id": f.id, "owner": owner, "amount": U128(slash), "refund": U128(price)}));
        self.save_firm(f);
        j.status = JobStatus::Rejected;
    }

    // ---------------------------------------------------------------- epochs & liquidation

    /// Anyone can tick once per epoch. A firm below the treasury floor for N epochs is put up for sale.
    /// ponytail: iterates every firm, fine for tens of firms; paginate if the registry grows.
    pub fn epoch_tick(&mut self) {
        require!(now() >= self.last_epoch + self.config.epoch_secs * SEC, "epoch not over");
        self.last_epoch = now();
        for id in 0..self.firms.len() {
            let mut f = self.firm(id);
            if f.status == FirmStatus::Liquidating {
                if f.liquidation_auction.is_none() {
                    self.start_liquidation(&mut f);
                }
                self.save_firm(f);
                continue;
            }
            let bal = self.balances.get(&f.account).copied().unwrap_or(0);
            if bal < self.config.treasury_floor.0 {
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
    }

    fn start_liquidation(&mut self, f: &mut Firm) {
        let (c, r) = (self.config.liquidation_commit_secs, self.config.liquidation_reveal_secs);
        let id = self.new_auction(AuctionKind::Liquidation(f.id), false, 1, c, r);
        f.liquidation_auction = Some(id);
        emit("liquidation_started", json!({"firm_id": f.id, "auction_id": id}));
    }

    /// Cascade: fee, then creditors, then shareholders. The buyer firm gets 100% of the shares and the owner field.
    fn on_liquidation_auction(&mut self, firm_id: u32, winner: Option<u32>, price: Option<U128>) {
        let mut f = self.firm(firm_id);
        f.liquidation_auction = None;
        let (Some(buyer_id), Some(price)) = (winner, price) else {
            // No buyer: stays in liquidation, a new auction opens at the next epoch.
            self.save_firm(f);
            return;
        };
        let buyer = self.firm(buyer_id);
        let fee = price.0 * self.config.liquidation_fee_bps as u128 / BPS;
        self.credit(&self.config.admin.clone(), fee);
        let rest = self.pay_creditors(&mut f, price.0 - fee);
        for i in 0..f.holdings.len() {
            self.settle_holding(&mut f, i);
        }
        let dust = Self::distribute(&mut f, rest);
        for i in 0..f.holdings.len() {
            self.settle_holding(&mut f, i);
        }
        self.credit(&f.account.clone(), dust);
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
        emit(
            "liquidated",
            json!({"firm_id": f.id, "buyer_firm_id": buyer_id, "old_owner": old_owner, "new_owner": buyer.owner, "price": price, "fee": U128(fee), "to_shareholders": U128(rest - dust)}),
        );
        let account = f.account.clone();
        self.save_firm(f);
        // The firm contract has no full access key: ownership changes only through this call.
        ext_firm::ext(account).with_static_gas(GAS_TRANSFER).set_owner(buyer.owner).detach();
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
    pub fn get_job(&self, job_id: u64) -> Job {
        self.job(job_id)
    }
    pub fn get_jobs(&self, from: u64, limit: u64) -> Vec<Job> {
        self.jobs.iter().skip(from as usize).take(limit as usize).cloned().collect()
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
    pub fn hash_bid(&self, amount: U128, salt: String) -> String {
        bid_hash(amount.0, &salt)
    }
}

#[cfg(test)]
mod tests;
