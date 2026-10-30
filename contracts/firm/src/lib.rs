//! firm: the treasury guard of one Tontine firm, deployed on a sub-account with no full access key.
//!
//! The firm agent holds only function call keys, which cannot attach deposits, so they reach only
//! non-payable methods. `spend` checks the per-call cap and `spent + amount <= budget`, books the
//! spend before the promise, and rolls it back in the callback if the transfer fails.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, ext_contract, near, require, AccountId, Allowance, Gas, NearToken, PanicOnDefault, Promise, PublicKey};

const SEC: u64 = 1_000_000_000;
/// Methods an agent key may call on tender (none takes a deposit). Mirrors ts/src/deploy.ts.
const AGENT_TENDER_METHODS: &str =
    "commit_bid,reveal_bid,deliver,settle,epoch_tick,expire,settle_dividends,commit_vote,reveal_vote,finalize,resolve_dispute";

#[ext_contract(ext_tender)]
#[allow(dead_code)]
trait Tender {
    fn transfer(&mut self, receiver_id: AccountId, amount: U128);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Firm {
    tender: AccountId,
    owner: AccountId,
    /// Spending allowed per budget epoch (USDC base units).
    budget: U128,
    max_per_call: U128,
    spent: U128,
    epoch_secs: u64,
    epoch_start: u64,
    /// Function call keys of the current owner's agent, deleted when the firm changes hands.
    agent_keys: Vec<PublicKey>,
}

#[near(serializers = [json])]
pub struct FirmView {
    pub tender: AccountId,
    pub owner: AccountId,
    pub budget: U128,
    pub max_per_call: U128,
    pub spent: U128,
    pub epoch_secs: u64,
    pub epoch_start: u64,
    pub agent_keys: Vec<PublicKey>,
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "tontine-firm", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

#[near]
impl Firm {
    #[init]
    pub fn new(tender: AccountId, owner: AccountId, budget: U128, max_per_call: U128, epoch_secs: u64, agent_keys: Vec<PublicKey>) -> Self {
        require!(epoch_secs > 0, "epoch_secs must be > 0");
        Self { tender, owner, budget, max_per_call, spent: U128(0), epoch_secs, epoch_start: env::block_timestamp(), agent_keys }
    }

    /// Pay `amount` from the firm's tender ledger balance to `receiver_id` (e.g. an inference provider).
    /// Callable by the firm agent (function call key on this account) or the owner.
    pub fn spend(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) -> Promise {
        let me = env::predecessor_account_id();
        require!(me == env::current_account_id() || me == self.owner, "firm agent or owner only");
        let now = env::block_timestamp();
        if now >= self.epoch_start + self.epoch_secs * SEC {
            self.epoch_start = now;
            self.spent = U128(0);
        }
        require!(amount.0 > 0, "zero amount");
        require!(amount.0 <= self.max_per_call.0, "over per-call cap");
        require!(self.spent.0 + amount.0 <= self.budget.0, "over budget");
        self.spent = U128(self.spent.0 + amount.0);
        emit("spend", json!({"receiver_id": receiver_id, "amount": amount, "memo": memo, "spent": self.spent}));
        ext_tender::ext(self.tender.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(10))
            .transfer(receiver_id, amount)
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(5)).on_spend(amount))
    }

    #[private]
    pub fn on_spend(&mut self, amount: U128, #[callback_result] r: Result<(), near_sdk::PromiseError>) -> bool {
        if r.is_err() {
            self.spent = U128(self.spent.0.saturating_sub(amount.0));
            emit("spend_reverted", json!({"amount": amount, "spent": self.spent}));
        }
        r.is_ok()
    }

    pub fn set_budget(&mut self, budget: U128, max_per_call: U128) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        self.budget = budget;
        self.max_per_call = max_per_call;
        emit("budget_set", json!({"budget": budget, "max_per_call": max_per_call}));
    }

    /// Only the tender contract changes the owner (liquidation buyer). The old owner's agent keys are
    /// deleted, and spending stops until the new owner sets a budget and adds its own keys.
    pub fn set_owner(&mut self, owner: AccountId) {
        require!(env::predecessor_account_id() == self.tender, "tender only");
        emit("owner_set", json!({"old": self.owner, "new": owner}));
        self.owner = owner;
        self.budget = U128(0);
        // One promise per key: in a single batch, one failing delete_key would revert every deletion.
        for k in std::mem::take(&mut self.agent_keys) {
            Promise::new(env::current_account_id()).delete_key(k).detach();
        }
    }

    /// Owner adds a function call key for its agent: on tender (bidding) or on this contract (`spend`).
    pub fn add_agent_key(&mut self, public_key: PublicKey, on_tender: bool) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        // A duplicate entry would make the key outlive a takeover (audit finding F1).
        require!(!self.agent_keys.contains(&public_key), "key already registered");
        let (receiver, methods) =
            if on_tender { (self.tender.clone(), AGENT_TENDER_METHODS) } else { (env::current_account_id(), "spend") };
        self.agent_keys.push(public_key.clone());
        Promise::new(env::current_account_id())
            .add_access_key_allowance(public_key, Allowance::unlimited(), receiver, methods)
            .detach();
    }

    pub fn get_state(&self) -> FirmView {
        FirmView {
            tender: self.tender.clone(),
            owner: self.owner.clone(),
            budget: self.budget,
            max_per_call: self.max_per_call,
            spent: self.spent,
            epoch_secs: self.epoch_secs,
            epoch_start: self.epoch_start,
            agent_keys: self.agent_keys.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
    use near_sdk::test_vm_config;

    const KEY: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

    fn ctx(pred: &str) -> VMContextBuilder {
        let mut c = VMContextBuilder::new();
        c.current_account_id("w1.tender.near".parse().unwrap()).predecessor_account_id(pred.parse().unwrap());
        c
    }

    fn firm() -> Firm {
        testing_env!(ctx("tender.near").build());
        Firm::new("tender.near".parse().unwrap(), "alice.near".parse().unwrap(), U128(20_000_000), U128(20_000_000), 3600, vec![KEY.parse().unwrap()])
    }

    #[test]
    fn spend_within_budget() {
        let mut f = firm();
        testing_env!(ctx("w1.tender.near").build());
        let _ = f.spend("inference.near".parse().unwrap(), U128(20_000_000), None);
        assert_eq!(f.get_state().spent.0, 20_000_000);
    }

    #[test]
    #[should_panic(expected = "over budget")]
    fn spend_21_on_budget_20_rejected() {
        let mut f = firm();
        testing_env!(ctx("w1.tender.near").build());
        let _ = f.spend("inference.near".parse().unwrap(), U128(1_000_000), None);
        let _ = f.spend("inference.near".parse().unwrap(), U128(20_000_000), None);
    }

    #[test]
    #[should_panic(expected = "firm agent or owner only")]
    fn stranger_cannot_spend() {
        let mut f = firm();
        testing_env!(ctx("mallory.near").build());
        let _ = f.spend("mallory.near".parse().unwrap(), U128(1), None);
    }

    #[test]
    fn failed_transfer_rolls_back() {
        let mut f = firm();
        testing_env!(ctx("w1.tender.near").build());
        let _ = f.spend("inference.near".parse().unwrap(), U128(5_000_000), None);
        testing_env!(
            ctx("w1.tender.near").build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed]
        );
        assert!(!f.on_spend(U128(5_000_000), Err(near_sdk::PromiseError::Failed)));
        assert_eq!(f.get_state().spent.0, 0);
    }

    #[test]
    #[should_panic(expected = "key already registered")]
    fn poc_f1_duplicate_agent_key_refused() {
        let mut f = firm();
        testing_env!(ctx("alice.near").build());
        f.add_agent_key(KEY.parse().unwrap(), true);
    }

    #[test]
    fn only_tender_sets_owner() {
        let mut f = firm();
        testing_env!(ctx("tender.near").build());
        f.set_owner("bob.near".parse().unwrap());
        let st = f.get_state();
        assert_eq!(st.owner.as_str(), "bob.near");
        assert!(st.agent_keys.is_empty(), "old agent keys deleted");
        assert_eq!(st.budget.0, 0, "spending frozen until the new owner sets a budget");
        testing_env!(ctx("alice.near").build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.set_owner("alice.near".parse().unwrap())));
        assert!(r.is_err());
    }
}
