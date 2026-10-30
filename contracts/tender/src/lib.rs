//! tender: the market contract of Tontine.
//!
//! One sealed-bid second-price auction (commit-reveal) serves two purposes:
//! - jobs: reverse auction, the lowest bid wins and is paid the second-lowest price;
//! - liquidations: forward auction, the highest bid buys the bankrupt firm at the second-highest price.
//!
//! Money is an internal ledger in one stable token (USDC base units). Deposits arrive by
//! `ft_on_transfer` (plain NEP-141) or `mt_on_transfer` (NEAR Intents, NEP-245). Firm shares are
//! NEP-245 tokens (token_id = firm id, 100 per firm) with Synthetix-style dividends.

use near_sdk::json_types::{Base64VecU8, U128};
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
/// After this long without a verdict, anyone can cancel a delivered job (judge outage, no slash).
const JUDGE_TIMEOUT_SECS: u64 = 3 * 86_400;
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
const AGENT_TENDER_METHODS: &str =
    "commit_bid,reveal_bid,deliver,settle,epoch_tick,expire,settle_dividends,commit_vote,reveal_vote,finalize,resolve_dispute";

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
    /// Tontine's cut of every paid job, taken before the dividend split. Paid to `admin`.
    #[serde(default)]
    pub job_fee_bps: u16,
    /// Tontine's cut of every share sale, taken from the seller's proceeds. Paid to `admin`.
    #[serde(default)]
    pub trade_fee_bps: u16,
    /// Paid out of `admin`'s fee balance to whoever settles an auction or ticks an epoch.
    #[serde(default)]
    pub keeper_reward: U128,
    /// Optimistic jobs: what a client stakes to dispute a delivery, lost to the evaluators if the panel accepts it.
    #[serde(default)]
    pub dispute_bond: U128,
    /// Owner bond each evaluator puts at stake, lost if it votes against the majority or does not reveal.
    #[serde(default)]
    pub eval_stake: U128,
    /// Evaluator firms per dispute (0 means 3).
    #[serde(default)]
    pub panel_size: u8,
    /// Length of each vote phase of a dispute, commit then reveal (0 means 60 s).
    #[serde(default)]
    pub vote_secs: u64,
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
    // KYA registry and P&L
    pub delivered: u32,
    pub rejected: u32,
    pub slashed: U128,
    pub revenue: U128,
    pub dividends: U128,
    pub takeovers: u32,
    /// False between a takeover and the firm contract confirming its new owner.
    pub owner_synced: bool,
    /// Jobs this firm won that are not paid, rejected or cancelled yet.
    pub open_jobs: u32,
    /// The firm's spec as published by its owner: JSON (name, description, skills, model, budgets...).
    pub profile: Option<String>,
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
    Disputed,
}

/// How a delivery is checked. `Judge`: the configured oracle posts the verdict (the default).
/// `Optimistic`: the client accepts or disputes within `review_secs`; silence pays the firm, and a dispute
/// goes to a panel of evaluator firms that vote with stakes (commit, then reveal).
#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug, Default)]
pub enum Verify {
    #[default]
    Judge,
    Optimistic { review_secs: u64 },
}

/// One evaluator of a dispute. `hash` is hex(sha256("{1|0}:{salt}")), 1 meaning the delivery is accepted.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Ballot {
    pub firm_id: u32,
    pub owner: AccountId,
    pub hash: Option<String>,
    pub vote: Option<bool>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Dispute {
    pub panel: Vec<Ballot>,
    pub commit_end: u64,
    pub reveal_end: u64,
    pub resolved: bool,
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
    /// Acceptance criteria fixed when the job was posted: the delivery is judged against them only.
    pub criteria: String,
    pub verify: Verify,
    /// Optimistic jobs: end of the client's review window, set on delivery.
    pub review_end: Option<u64>,
}

#[near(serializers = [json])]
pub struct PostJob {
    pub budget: U128,
    pub brief: String,
    pub commit_secs: u64,
    pub reveal_secs: u64,
    pub deliver_secs: u64,
    /// Acceptance criteria (format, checks, rubric), immutable once posted.
    #[serde(default)]
    pub criteria: String,
    #[serde(default)]
    pub verify: Verify,
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
    Storage,
    Disputes,
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
    /// NEP-145-style prepaid storage (yoctoNEAR): whoever grows the state pays for it.
    storage: LookupMap<AccountId, u128>,
    last_epoch: u64,
    disputes: LookupMap<u64, Dispute>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn bid_hash(amount: u128, salt: &str) -> String {
    hex(&env::sha256(format!("{amount}:{salt}").as_bytes()))
}

/// Sealed vote of an evaluator: 1 accepts the delivery, 0 rejects it.
pub fn vote_hash(accept: bool, salt: &str) -> String {
    hex(&env::sha256(format!("{}:{salt}", accept as u8).as_bytes()))
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
            [config.dividend_bps, config.liquidation_fee_bps, config.job_fee_bps, config.trade_fee_bps].iter().all(|b| *b as u128 <= BPS),
            "bps > 100%"
        );
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
            storage: LookupMap::new(Key::Storage),
            last_epoch: now(),
            disputes: LookupMap::new(Key::Disputes),
        }
    }

    // ---------------------------------------------------------------- storage

    /// Bytes the state takes now. `store` collections cache writes until the end of the call,
    /// so flush them first or the growth of this call is invisible.
    fn usage(&mut self) -> u64 {
        self.balances.flush();
        self.bonds.flush();
        self.locks.flush();
        self.firms.flush();
        self.firm_by_account.flush();
        self.jobs.flush();
        self.auctions.flush();
        self.asks.flush();
        self.disputes.flush();
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
        let b = self.storage.get(&who).copied().unwrap_or(0) + env::attached_deposit().as_yoctonear();
        self.storage.insert(who, b);
        U128(b)
    }

    #[payable]
    pub fn storage_withdraw(&mut self, amount: U128) -> Promise {
        near_sdk::assert_one_yocto();
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

    fn apply_deposit(&mut self, sender: AccountId, amount: u128, msg: &str) {
        let s0 = self.usage();
        self.apply_deposit_inner(sender.clone(), amount, msg);
        // A deposit from someone without storage deposit panics: the token refunds it.
        self.charge(&sender, s0);
    }

    fn apply_deposit_inner(&mut self, sender: AccountId, amount: u128, msg: &str) {
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
        let s0 = self.usage();
        self.debit(&me, amount.0);
        self.credit(&receiver_id, amount.0);
        self.charge(&me, s0);
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
        let s0 = self.usage();
        self.debit(&me, amount.0);
        let b = self.bonds.get(&me).copied().unwrap_or(0);
        self.bonds.insert(me.clone(), b + amount.0);
        self.charge(&me, s0);
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
            delivered: 0,
            rejected: 0,
            slashed: U128(0),
            revenue: U128(0),
            dividends: U128(0),
            takeovers: 0,
            owner_synced: true,
            open_jobs: 0,
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
    pub fn buy_shares(&mut self, firm_id: u32, seller: AccountId, amount: u32) {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        let key = format!("{firm_id}:{seller}");
        let mut ask = self.asks.get(&key).cloned().unwrap_or_else(|| env::panic_str("no ask"));
        require!(amount > 0 && ask.amount >= amount, "ask too small");
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
        require!(f.status != FirmStatus::Closed, "firm closed");
        require!(hash.len() == 64, "hash must be hex sha256");
        let mut a = self.auction(auction_id);
        require!(now() < a.commit_end, "commit phase over");
        require!(self.bonds.get(&f.owner).copied().unwrap_or(0) >= self.config.min_bond.0, "owner bond too low");
        require!(!a.bids.iter().any(|b| b.owner == f.owner), "one bid per owner (anti-shill)");
        require!(!a.bids.iter().any(|b| b.firm_id == firm_id), "firm already bid");
        if let AuctionKind::Liquidation(target) = a.kind {
            require!(target != firm_id && self.firm(target).owner != f.owner, "cannot bid on own firm");
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
                if let Some(id) = a.winner {
                    let mut f = self.firm(id);
                    f.open_jobs += 1;
                    self.save_firm(f);
                }
                self.on_job_auction(job_id, owner, a.price)
            }
            AuctionKind::Liquidation(firm_id) => self.on_liquidation_auction(firm_id, a.winner, a.price),
        }
        // A job auction nobody won did no work: paying it would let anyone farm rewards with 1-unit jobs
        // (audit finding 07).
        if !a.reverse || a.winner.is_some() {
            self.reward_keeper();
        }
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

    // ---------------------------------------------------------------- jobs

    #[payable]
    pub fn post_job(&mut self, job: PostJob) -> u64 {
        near_sdk::assert_one_yocto();
        let me = env::predecessor_account_id();
        let s0 = self.usage();
        let id = self.post_job_from(me.clone(), job);
        self.charge(&me, s0);
        id
    }

    fn post_job_from(&mut self, client: AccountId, p: PostJob) -> u64 {
        require!(p.budget.0 > 0, "budget must be > 0");
        require!(p.brief.len() <= 2000, "brief too long");
        require!(p.deliver_secs > 0 && p.deliver_secs <= MAX_PHASE_SECS, "deliver_secs out of range");
        require!(p.criteria.len() <= 2000, "criteria too long");
        if let Verify::Optimistic { review_secs } = p.verify {
            require!(review_secs > 0 && review_secs <= MAX_PHASE_SECS, "review_secs out of range");
        }
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
            criteria: p.criteria.clone(),
            verify: p.verify.clone(),
            review_end: None,
        });
        emit(
            "job_posted",
            json!({"job_id": id, "client": client, "budget": p.budget, "brief": p.brief, "auction_id": auction, "criteria": p.criteria, "verify": p.verify}),
        );
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
        if let Verify::Optimistic { review_secs } = j.verify {
            j.review_end = Some(now() + review_secs * SEC);
        }
        let review_end = j.review_end;
        let payer = j.winner_owner.clone().unwrap();
        let s0 = self.usage();
        self.jobs.replace(job_id as u32, j);
        self.charge(&payer, s0);
        emit("delivered", json!({"job_id": job_id, "firm_id": f.id, "result": result, "review_end": review_end}));
    }

    /// The delivery oracle posts its verdict with the NEAR AI Cloud attestation (signature payload).
    pub fn verdict(&mut self, job_id: u64, accept: bool, attestation: String) {
        require!(env::predecessor_account_id() == self.config.judge, "judge only");
        require!(attestation.len() <= 4000, "attestation too long");
        let mut j = self.job(job_id);
        // The judge also decides a dispute for which no evaluator firm was eligible.
        let fallback = j.status == JobStatus::Disputed && self.disputes.get(&job_id).map_or(true, |d| d.panel.is_empty());
        require!((j.status == JobStatus::Delivered && j.verify == Verify::Judge) || fallback, "nothing to judge");
        j.attestation = Some(attestation);
        if fallback {
            // Accepted: the client's dispute bond goes to Tontine. Rejected: it comes back.
            let to = if accept { self.config.admin.clone() } else { j.client.clone() };
            self.credit(&to, self.config.dispute_bond.0);
        }
        if accept {
            self.pay(&mut j);
        } else {
            self.reject(&mut j, true);
        }
        self.jobs.replace(job_id as u32, j);
    }

    // ---------------------------------------------------------------- optimistic review and disputes

    fn optimistic_delivery(&self, job_id: u64) -> Job {
        let j = self.job(job_id);
        require!(j.status == JobStatus::Delivered && matches!(j.verify, Verify::Optimistic { .. }), "no delivery under review");
        j
    }

    /// The client accepts the delivery: the firm is paid at once.
    #[payable]
    pub fn accept_delivery(&mut self, job_id: u64) {
        near_sdk::assert_one_yocto();
        let mut j = self.optimistic_delivery(job_id);
        require!(env::predecessor_account_id() == j.client, "client only");
        self.pay(&mut j);
        self.jobs.replace(job_id as u32, j);
    }

    /// Anyone pays the firm once the review window passed without a dispute.
    pub fn finalize(&mut self, job_id: u64) {
        let mut j = self.optimistic_delivery(job_id);
        require!(now() > j.review_end.unwrap(), "review window still open");
        self.pay(&mut j);
        self.jobs.replace(job_id as u32, j);
        self.reward_keeper();
    }

    /// The client disputes the delivery within the review window, staking `dispute_bond`. A panel of
    /// evaluator firms is drawn: solvent, bonded, one per owner, neither the client nor the winner's owner.
    #[payable]
    pub fn dispute(&mut self, job_id: u64) {
        near_sdk::assert_one_yocto();
        let mut j = self.optimistic_delivery(job_id);
        let me = env::predecessor_account_id();
        require!(me == j.client, "client only");
        require!(now() <= j.review_end.unwrap(), "review window closed");
        let s0 = self.usage();
        self.debit(&me, self.config.dispute_bond.0);
        let panel = self.draw_panel(&j);
        for b in &panel {
            self.lock(&b.owner, true);
        }
        let vote = if self.config.vote_secs == 0 { 60 } else { self.config.vote_secs.min(MAX_PHASE_SECS) };
        let commit_end = now() + vote * SEC;
        let ids: Vec<u32> = panel.iter().map(|b| b.firm_id).collect();
        self.disputes.insert(job_id, Dispute { panel, commit_end, reveal_end: commit_end + vote * SEC, resolved: false });
        j.status = JobStatus::Disputed;
        self.jobs.replace(job_id as u32, j);
        self.charge(&me, s0);
        emit("disputed", json!({"job_id": job_id, "panel": ids, "commit_end": commit_end, "reveal_end": commit_end + vote * SEC}));
    }

    /// ponytail: scans every firm and shuffles with the block's random seed, which a validator can see
    /// in advance; use a VRF or a commit-reveal draw if panels must resist block producers.
    fn draw_panel(&self, j: &Job) -> Vec<Ballot> {
        let winner_owner = j.winner_owner.clone().unwrap();
        let need = self.config.min_bond.0.max(self.config.eval_stake.0);
        let mut eligible: Vec<Ballot> = vec![];
        for id in 0..self.firms.len() {
            let f = self.firm(id);
            let bonded = self.bonds.get(&f.owner).copied().unwrap_or(0) >= need;
            if f.status != FirmStatus::Solvent || !bonded || f.owner == j.client || f.owner == winner_owner || eligible.iter().any(|b| b.owner == f.owner) {
                continue;
            }
            eligible.push(Ballot { firm_id: id, owner: f.owner, hash: None, vote: None });
        }
        let size = if self.config.panel_size == 0 { 3 } else { self.config.panel_size as usize };
        let seed = env::random_seed();
        let mut panel = vec![];
        let mut i = 0;
        while !eligible.is_empty() && panel.len() < size {
            let k = seed[i % seed.len()] as usize % eligible.len();
            panel.push(eligible.swap_remove(k));
            i += 1;
        }
        panel
    }

    fn ballot(d: &Dispute, firm_id: u32) -> usize {
        d.panel.iter().position(|b| b.firm_id == firm_id).unwrap_or_else(|| env::panic_str("not on the panel"))
    }

    pub fn commit_vote(&mut self, job_id: u64, firm_id: u32, hash: String) {
        Self::assert_firm_actor(&self.firm(firm_id));
        require!(hash.len() == 64, "hash must be hex sha256");
        let mut d = self.disputes.get(&job_id).cloned().unwrap_or_else(|| env::panic_str("no dispute"));
        require!(now() < d.commit_end, "commit phase over");
        let i = Self::ballot(&d, firm_id);
        require!(d.panel[i].hash.is_none(), "already committed");
        d.panel[i].hash = Some(hash);
        self.disputes.insert(job_id, d);
        emit("vote_committed", json!({"job_id": job_id, "firm_id": firm_id}));
    }

    pub fn reveal_vote(&mut self, job_id: u64, firm_id: u32, accept: bool, salt: String) {
        Self::assert_firm_actor(&self.firm(firm_id));
        let mut d = self.disputes.get(&job_id).cloned().unwrap_or_else(|| env::panic_str("no dispute"));
        require!(now() >= d.commit_end && now() < d.reveal_end, "not in reveal phase");
        let i = Self::ballot(&d, firm_id);
        require!(d.panel[i].vote.is_none(), "already revealed");
        require!(d.panel[i].hash.as_deref() == Some(vote_hash(accept, &salt).as_str()), "hash mismatch");
        d.panel[i].vote = Some(accept);
        self.disputes.insert(job_id, d);
        emit("vote_revealed", json!({"job_id": job_id, "firm_id": firm_id, "accept": accept}));
    }

    /// Anyone closes a dispute after the reveal phase. The majority decides; a tie or no vote leaves the
    /// delivery accepted and refunds the client's bond. Evaluators that voted against the majority or did
    /// not reveal lose `eval_stake`. The losing side pays the majority: the client's dispute bond if the
    /// delivery stands, the winner owner's slashed bond if it is rejected (the client then gets its price
    /// and its bond back).
    pub fn resolve_dispute(&mut self, job_id: u64) {
        let mut j = self.job(job_id);
        require!(j.status == JobStatus::Disputed, "not disputed");
        let mut d = self.disputes.get(&job_id).cloned().unwrap_or_else(|| env::panic_str("no dispute"));
        require!(!d.panel.is_empty(), "no panel: the judge decides");
        require!(now() >= d.reveal_end, "votes still open");
        d.resolved = true;
        let yes = d.panel.iter().filter(|b| b.vote == Some(true)).count();
        let no = d.panel.iter().filter(|b| b.vote == Some(false)).count();
        let decisive = yes != no;
        let accept = yes >= no;
        let mut pot = 0u128;
        let mut majority: Vec<AccountId> = vec![];
        for b in &d.panel {
            self.lock(&b.owner, false);
            if decisive && b.vote == Some(accept) {
                majority.push(self.firm(b.firm_id).account);
            } else if b.vote.is_none() || decisive {
                let bond = self.bonds.get(&b.owner).copied().unwrap_or(0);
                let cut = bond.min(self.config.eval_stake.0);
                self.bonds.insert(b.owner.clone(), bond - cut);
                pot += cut;
            }
        }
        let bond = self.config.dispute_bond.0;
        if accept {
            if decisive {
                pot += bond;
            } else {
                self.credit(&j.client.clone(), bond);
            }
            self.pay(&mut j);
        } else {
            self.credit(&j.client.clone(), bond);
            pot += self.reject(&mut j, false);
        }
        let share = if majority.is_empty() { 0 } else { pot / majority.len() as u128 };
        for a in &majority {
            self.credit(a, share);
        }
        self.credit(&self.config.admin.clone(), pot - share * majority.len() as u128);
        emit(
            "dispute_resolved",
            json!({"job_id": job_id, "accept": accept, "yes": yes, "no": no, "evaluators_paid": majority, "reward_each": U128(share)}),
        );
        self.disputes.insert(job_id, d);
        self.jobs.replace(job_id as u32, j);
        self.reward_keeper();
    }

    /// Anyone can expire a job: undelivered after its deadline (rejected, slashed), or delivered with
    /// no verdict for JUDGE_TIMEOUT_SECS after the deadline (cancelled, client refunded, no slash).
    pub fn expire(&mut self, job_id: u64) {
        let mut j = self.job(job_id);
        let deadline = j.deadline.unwrap_or(u64::MAX);
        let dispute = self.disputes.get(&job_id).filter(|_| j.status == JobStatus::Disputed).cloned();
        let unjudged = (j.status == JobStatus::Delivered && j.verify == Verify::Judge)
            || (j.status == JobStatus::Disputed && dispute.as_ref().map_or(true, |d| d.panel.is_empty()));
        // A dispute restarts the judge's clock: a client cannot dispute late, then cancel before the judge
        // can rule (audit finding 06).
        let judge_from = dispute.map_or(deadline, |d| d.reveal_end.max(deadline));
        if j.status == JobStatus::Assigned && now() > deadline {
            self.reject(&mut j, true);
        } else if unjudged && now() > judge_from + JUDGE_TIMEOUT_SECS * SEC {
            if j.status == JobStatus::Disputed {
                self.credit(&j.client.clone(), self.config.dispute_bond.0);
            }
            let (mut f, price) = self.winner_of(&j);
            f.open_jobs = f.open_jobs.saturating_sub(1);
            self.save_firm(f);
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
        let fee = price * self.config.job_fee_bps as u128 / BPS;
        self.credit(&self.config.admin.clone(), fee);
        let net = price - fee;
        let div = net * self.config.dividend_bps as u128 / BPS;
        let dust = Self::distribute(&mut f, div);
        let to_firm = net - div + dust;
        self.credit(&f.account.clone(), to_firm);
        f.delivered += 1;
        f.open_jobs = f.open_jobs.saturating_sub(1);
        f.revenue = U128(f.revenue.0 + price);
        f.dividends = U128(f.dividends.0 + div - dust);
        self.lock(&j.winner_owner.clone().unwrap(), false);
        emit("paid", json!({"job_id": j.id, "firm_id": f.id, "price": U128(price), "to_firm": U128(to_firm), "dividends": U128(div - dust), "fee": U128(fee)}));
        self.save_firm(f);
        j.status = JobStatus::Paid;
    }

    /// Refund the client and slash the winner owner's bond, to the client or (for a dispute) returned
    /// to the caller to pay the evaluators.
    fn reject(&mut self, j: &mut Job, slash_to_client: bool) -> u128 {
        let (mut f, price) = self.winner_of(j);
        let owner = j.winner_owner.clone().unwrap();
        self.credit(&j.client, price);
        let bond = self.bonds.get(&owner).copied().unwrap_or(0);
        let slash = bond.min(self.config.slash.0);
        self.bonds.insert(owner.clone(), bond - slash);
        if slash_to_client {
            self.credit(&j.client, slash);
        }
        f.rejected += 1;
        f.open_jobs = f.open_jobs.saturating_sub(1);
        f.slashed = U128(f.slashed.0 + slash);
        self.lock(&owner, false);
        emit("slashed", json!({"job_id": j.id, "firm_id": f.id, "owner": owner, "amount": U128(slash), "refund": U128(price)}));
        self.save_firm(f);
        j.status = JobStatus::Rejected;
        slash
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
        self.reward_keeper();
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
            // Nobody wants it: wind it up, unless it still owes a job (then a new auction opens next epoch).
            if f.open_jobs == 0 {
                self.wind_up(&mut f, "no buyer");
            }
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
            json!({"firm_id": f.id, "buyer_firm_id": buyer_id, "old_owner": old_owner, "new_owner": buyer.owner, "price": price, "fee": U128(fee), "to_shareholders": U128(rest - dust)}),
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
        require!(f.open_jobs == 0, "finish or lose the open jobs first");
        self.wind_up(&mut f, "closed by its owner");
        self.save_firm(f);
    }

    fn wind_up(&mut self, f: &mut Firm, reason: &str) {
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
        f.status = FirmStatus::Closed;
        f.liquidation_auction = None;
        emit("firm_closed", json!({"firm_id": f.id, "reason": reason, "to_shareholders": U128(rest - dust)}));
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
    pub fn get_job(&self, job_id: u64) -> Job {
        self.job(job_id)
    }
    pub fn get_jobs(&self, from: u64, limit: u64) -> Vec<Job> {
        self.jobs.iter().skip(from as usize).take(limit as usize).cloned().collect()
    }
    pub fn get_auction(&self, auction_id: u64) -> Auction {
        self.auction(auction_id)
    }
    pub fn get_dispute(&self, job_id: u64) -> Option<Dispute> {
        self.disputes.get(&job_id).cloned()
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
