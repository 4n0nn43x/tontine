//! firm: the treasury guard of one Tontine firm, deployed on a sub-account with no full access key.
//!
//! The firm agent holds only function call keys, which cannot attach deposits, so they reach only
//! non-payable methods. `spend` checks the per-call cap and `spent + amount <= budget`, books the
//! spend before the promise, and rolls it back in the callback if the transfer fails.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};

const SEC: u64 = 1_000_000_000;

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
    pub fn new(tender: AccountId, owner: AccountId, budget: U128, max_per_call: U128, epoch_secs: u64) -> Self {
        require!(epoch_secs > 0, "epoch_secs must be > 0");
        Self { tender, owner, budget, max_per_call, spent: U128(0), epoch_secs, epoch_start: env::block_timestamp() }
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

    /// Only the tender contract changes the owner (liquidation buyer).
    pub fn set_owner(&mut self, owner: AccountId) {
        require!(env::predecessor_account_id() == self.tender, "tender only");
        emit("owner_set", json!({"old": self.owner, "new": owner}));
        self.owner = owner;
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
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
    use near_sdk::test_vm_config;

    fn ctx(pred: &str) -> VMContextBuilder {
        let mut c = VMContextBuilder::new();
        c.current_account_id("w1.tender.near".parse().unwrap()).predecessor_account_id(pred.parse().unwrap());
        c
    }

    fn firm() -> Firm {
        testing_env!(ctx("tender.near").build());
        Firm::new("tender.near".parse().unwrap(), "alice.near".parse().unwrap(), U128(20_000_000), U128(20_000_000), 3600)
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
    fn only_tender_sets_owner() {
        let mut f = firm();
        testing_env!(ctx("tender.near").build());
        f.set_owner("bob.near".parse().unwrap());
        assert_eq!(f.get_state().owner.as_str(), "bob.near");
        testing_env!(ctx("alice.near").build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.set_owner("alice.near".parse().unwrap())));
        assert!(r.is_err());
    }
}
