//! firm: the treasury guard of one Tontine firm, deployed on a sub-account with no full access key.
//!
//! The firm agent holds only function call keys, which cannot attach deposits, so they reach only
//! non-payable methods. `spend` checks the per-call cap and `spent + amount <= budget`, books the
//! spend before the promise, and rolls it back in the callback if the transfer fails.
//!
//! The firm also controls an EVM address through NEAR Chain Signatures (MPC key derived from this
//! account and `evm_path()`, which changes at each takeover). `sign_evm` asks the MPC signer to sign an
//! EIP-1559 transaction only if it fits the owner's `EvmPolicy`: chain ids, contract targets and their
//! selectors, the recipients of token transfers and approvals, gas and fee caps.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, ext_contract, near, require, AccountId, Allowance, Gas, NearToken, PanicOnDefault, Promise, PublicKey};

const SEC: u64 = 1_000_000_000;
/// Methods an agent key may call on tender (none takes a deposit). Mirrors ts/src/deploy.ts.
const AGENT_TENDER_METHODS: &str = "commit_bid,reveal_bid,settle,epoch_tick,settle_dividends";
/// The two keys of create_firm plus room for rotation. Bounds the deletions set_owner makes in one
/// receipt, so a takeover always fits the gas tender attaches (audit finding F15).
const MAX_AGENT_KEYS: usize = 4;
/// Methods the firm-side agent key may call on this contract. Mirrors tender's create_firm.
const AGENT_FIRM_METHODS: &str = "spend,sign_evm";
/// Mainnet MPC signer, used while the owner has not set another (testnet: v1.signer-prod.testnet).
const DEFAULT_SIGNER: &str = "v1.signer";
/// Derivation path of the firm's EVM key: address = f(MPC root key, this account, path). The path carries the
/// ownership generation ("evm-1", then "evm-2" after a takeover...): a buyer gets a fresh address, so
/// transactions the old owner signed for future nonces cannot touch it.
const EVM_PATH_PREFIX: &str = "evm-";
/// Bounds on the policy, so `set_owner` (which clears it) always fits the gas tender attaches.
const MAX_POLICY_ITEMS: usize = 16;
/// ERC-20 selectors whose recipient must be on the owner's list: transfer, approve (first argument) and
/// transferFrom (second argument).
const ERC20_TRANSFER: &str = "0xa9059cbb";
const ERC20_APPROVE: &str = "0x095ea7b3";
const ERC20_TRANSFER_FROM: &str = "0x23b872dd";
/// v1.signer asks at least 15 TGas on `sign` (config `sign_call_gas_attachment_requirement_tera_gas`).
const GAS_SIGN: Gas = Gas::from_tgas(30);

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
    /// MPC signer contract; None means DEFAULT_SIGNER.
    signer: Option<AccountId>,
    /// What the agent may sign on EVM chains; None disables `sign_evm`.
    evm_policy: Option<EvmPolicy>,
    /// Ownership generation, bumped by `set_owner`: part of the EVM derivation path.
    evm_generation: u32,
}

/// A contract the agent may call, and the 4-byte selectors it may call on it.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct EvmTarget {
    /// 0x + 40 lower case hex.
    pub to: String,
    /// 0x + 8 lower case hex each.
    pub selectors: Vec<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct EvmPolicy {
    pub chain_ids: Vec<u64>,
    pub targets: Vec<EvmTarget>,
    pub max_gas: u64,
    /// Wei per gas.
    pub max_fee_per_gas: U128,
    /// Addresses an ERC-20 transfer, approve or transferFrom may send to or approve (0x + 40 lower case hex).
    /// Empty: those calls are refused even when their selector is allowed.
    #[serde(default)]
    pub recipients: Vec<String>,
}

/// An EIP-1559 contract call with value 0 and an empty access list.
#[near(serializers = [json])]
pub struct EvmTx {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: U128,
    pub max_fee_per_gas: U128,
    pub gas_limit: u64,
    /// 0x + 40 hex.
    pub to: String,
    /// 0x hex calldata, starting with the 4-byte selector.
    pub data: String,
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
    pub signer: AccountId,
    pub evm_policy: Option<EvmPolicy>,
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "tontine-firm", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Bytes of a 0x-prefixed hex string, None if malformed.
fn from_hex(s: &str) -> Option<Vec<u8>> {
    let h = s.strip_prefix("0x")?;
    if h.len() % 2 != 0 || !h.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).ok()).collect()
}

/// 0x + `n` lower case hex digits.
fn is_lower_hex(s: &str, n: usize) -> bool {
    s.len() == n + 2 && from_hex(s).is_some() && s == s.to_lowercase()
}

// RLP (Ethereum yellow paper, appendix B): byte strings, minimal big-endian integers, lists.
fn rlp_header(len: usize, offset: u8) -> Vec<u8> {
    if len < 56 {
        return vec![offset + len as u8];
    }
    let be = be_bytes(len as u128);
    [vec![offset + 55 + be.len() as u8], be].concat()
}

fn be_bytes(n: u128) -> Vec<u8> {
    n.to_be_bytes().into_iter().skip_while(|b| *b == 0).collect()
}

fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 0x80 {
        return b.to_vec();
    }
    [rlp_header(b.len(), 0x80), b.to_vec()].concat()
}

fn rlp_uint(n: u128) -> Vec<u8> {
    rlp_bytes(&be_bytes(n))
}

fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let body = items.concat();
    [rlp_header(body.len(), 0xc0), body].concat()
}

/// RLP items of an EIP-1559 transaction before its signature, with value 0 and no access list.
fn eip1559_fields(tx: &EvmTx, to: &[u8], data: &[u8]) -> Vec<Vec<u8>> {
    vec![
        rlp_uint(tx.chain_id.into()),
        rlp_uint(tx.nonce.into()),
        rlp_uint(tx.max_priority_fee_per_gas.0),
        rlp_uint(tx.max_fee_per_gas.0),
        rlp_uint(tx.gas_limit.into()),
        rlp_bytes(to),
        rlp_uint(0),
        rlp_bytes(data),
        rlp_list(&[]),
    ]
}

/// What an EIP-1559 sender signs the keccak256 of: 0x02 || rlp(fields).
fn eip1559_payload(tx: &EvmTx, to: &[u8], data: &[u8]) -> Vec<u8> {
    [vec![0x02], rlp_list(&eip1559_fields(tx, to, data))].concat()
}

#[near]
impl Firm {
    #[init]
    pub fn new(tender: AccountId, owner: AccountId, budget: U128, max_per_call: U128, epoch_secs: u64, agent_keys: Vec<PublicKey>) -> Self {
        require!(epoch_secs > 0, "epoch_secs must be > 0");
        require!(agent_keys.len() <= MAX_AGENT_KEYS, "too many agent keys (max 4)");
        Self { tender, owner, budget, max_per_call, spent: U128(0), epoch_secs, epoch_start: env::block_timestamp(), agent_keys, signer: None, evm_policy: None, evm_generation: 1 }
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
    /// deleted, and spending and EVM signing stop until the new owner sets a budget, an EVM policy and
    /// its own keys. The signer goes back to the default: the old owner's choice does not carry over.
    pub fn set_owner(&mut self, owner: AccountId) {
        require!(env::predecessor_account_id() == self.tender, "tender only");
        emit("owner_set", json!({"old": self.owner, "new": owner}));
        self.owner = owner;
        self.budget = U128(0);
        self.evm_policy = None;
        self.signer = None;
        // A new EVM address for the new owner: what the old owner signed for the old one stays there.
        self.evm_generation += 1;
        // One promise per key: in a single batch, one failing delete_key would revert every deletion.
        for k in std::mem::take(&mut self.agent_keys) {
            Promise::new(env::current_account_id()).delete_key(k).detach();
        }
    }

    /// Owner adds a function call key for its agent: on tender (bidding) or on this contract (`spend`,
    /// `sign_evm`).
    pub fn add_agent_key(&mut self, public_key: PublicKey, on_tender: bool) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        // A duplicate entry would make the key outlive a takeover (audit finding F1).
        require!(!self.agent_keys.contains(&public_key), "key already registered");
        require!(self.agent_keys.len() < MAX_AGENT_KEYS, "too many agent keys (max 4)");
        let (receiver, methods) =
            if on_tender { (self.tender.clone(), AGENT_TENDER_METHODS) } else { (env::current_account_id(), AGENT_FIRM_METHODS) };
        self.agent_keys.push(public_key.clone());
        Promise::new(env::current_account_id())
            .add_access_key_allowance(public_key, Allowance::unlimited(), receiver, methods)
            .detach();
    }

    /// Owner revokes one of its agent keys (a leaked key, or to make room for a new one).
    pub fn remove_agent_key(&mut self, public_key: PublicKey) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        let i = self.agent_keys.iter().position(|k| *k == public_key).unwrap_or_else(|| env::panic_str("no such agent key"));
        self.agent_keys.remove(i);
        Promise::new(env::current_account_id()).delete_key(public_key).detach();
    }

    /// Owner points the firm at another MPC signer (v1.signer-prod.testnet on testnet).
    pub fn set_signer(&mut self, signer: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        emit("signer_set", json!({"signer": signer}));
        self.signer = Some(signer);
    }

    /// Owner sets what the agent may sign on EVM chains; None stops `sign_evm`.
    pub fn set_evm_policy(&mut self, policy: Option<EvmPolicy>) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        if let Some(p) = &policy {
            require!(p.chain_ids.len() <= MAX_POLICY_ITEMS && p.targets.len() <= MAX_POLICY_ITEMS && p.recipients.len() <= MAX_POLICY_ITEMS, "policy too large (16 items per list)");
            require!(p.recipients.iter().all(|r| is_lower_hex(r, 40)), "recipient must be 0x + 40 lower case hex");
        }
        for t in policy.iter().flat_map(|p| &p.targets) {
            require!(is_lower_hex(&t.to, 40), "target must be 0x + 40 lower case hex");
            require!(t.selectors.len() <= MAX_POLICY_ITEMS, "policy too large (16 selectors per target)");
            require!(t.selectors.iter().all(|s| is_lower_hex(s, 8)), "selector must be 0x + 8 lower case hex");
        }
        emit("evm_policy_set", json!({"policy": policy}));
        self.evm_policy = policy;
    }

    /// Ask the MPC signer to sign `tx` with the firm's EVM key, if the owner's policy allows it.
    /// Callable by the firm agent or the owner; the 1 yoctoNEAR the signer asks comes from this account.
    /// Returns the signer's response: {scheme, big_r: {affine_point}, s: {scalar}, recovery_id}.
    pub fn sign_evm(&mut self, tx: EvmTx) -> Promise {
        let me = env::predecessor_account_id();
        require!(me == env::current_account_id() || me == self.owner, "firm agent or owner only");
        let p = self.evm_policy.as_ref().unwrap_or_else(|| env::panic_str("no evm policy"));
        require!(p.chain_ids.contains(&tx.chain_id), "chain id not allowed");
        let to = from_hex(&tx.to).filter(|b| b.len() == 20).unwrap_or_else(|| env::panic_str("to must be 0x + 40 hex"));
        let data = from_hex(&tx.data).unwrap_or_else(|| env::panic_str("data must be 0x hex"));
        require!(data.len() >= 4, "data has no selector");
        let (target, selector) = (tx.to.to_lowercase(), format!("0x{}", to_hex(&data[..4])));
        require!(p.targets.iter().any(|t| t.to == target), "target not allowed");
        require!(p.targets.iter().any(|t| t.to == target && t.selectors.contains(&selector)), "selector not allowed");
        // A token transfer or approval may only go to an address the owner listed.
        let recipient_arg = match selector.as_str() {
            ERC20_TRANSFER | ERC20_APPROVE => Some(4),
            ERC20_TRANSFER_FROM => Some(36),
            _ => None,
        };
        if let Some(at) = recipient_arg {
            require!(data.len() >= at + 32, "token call too short");
            let recipient = format!("0x{}", to_hex(&data[at + 12..at + 32]));
            require!(p.recipients.contains(&recipient), "recipient not allowed");
        }
        require!(tx.gas_limit <= p.max_gas, "over max gas");
        require!(tx.max_fee_per_gas.0 <= p.max_fee_per_gas.0, "over max fee per gas");
        require!(tx.max_priority_fee_per_gas.0 <= tx.max_fee_per_gas.0, "priority fee over max fee");
        let hash = to_hex(&env::keccak256(&eip1559_payload(&tx, &to, &data)));
        let args = json!({"request": {"payload_v2": {"Ecdsa": hash}, "path": self.evm_path(), "domain_id": 0}});
        Promise::new(self.signer())
            .function_call("sign".to_string(), args.to_string().into_bytes(), NearToken::from_yoctonear(1), GAS_SIGN)
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(5)).on_evm_signed(tx.chain_id, tx.nonce, hash))
    }

    #[private]
    pub fn on_evm_signed(
        &self,
        chain_id: u64,
        nonce: u64,
        hash: String,
        #[callback_result] r: Result<near_sdk::serde_json::Value, near_sdk::PromiseError>,
    ) -> Option<near_sdk::serde_json::Value> {
        emit(if r.is_ok() { "evm_signed" } else { "evm_sign_failed" }, json!({"chain_id": chain_id, "nonce": nonce, "hash": hash}));
        r.ok()
    }

    pub fn get_evm_policy(&self) -> Option<EvmPolicy> {
        self.evm_policy.clone()
    }

    pub fn evm_path(&self) -> String {
        format!("{EVM_PATH_PREFIX}{}", self.evm_generation)
    }

    fn signer(&self) -> AccountId {
        self.signer.clone().unwrap_or_else(|| DEFAULT_SIGNER.parse().unwrap())
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
            signer: self.signer(),
            evm_policy: self.evm_policy.clone(),
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

    fn nth_key(i: u8) -> PublicKey {
        let mut b = vec![0u8; 33];
        b[1] = i + 1;
        PublicKey::try_from(b).unwrap()
    }

    /// F15: without a cap, enough agent keys made set_owner run out of gas, so no key was deleted.
    #[test]
    fn poc_f15_agent_keys_are_capped() {
        let tender = "tender.near".parse::<AccountId>().unwrap();
        let alice = "alice.near".parse::<AccountId>().unwrap();
        let five: Vec<PublicKey> = (0..5).map(nth_key).collect();
        testing_env!(ctx("tender.near").build());
        let r = std::panic::catch_unwind(|| Firm::new(tender.clone(), alice.clone(), U128(1), U128(1), 3600, five.clone()));
        assert!(r.is_err(), "new refuses more than MAX_AGENT_KEYS keys");
        let mut f = Firm::new(tender, alice, U128(1), U128(1), 3600, five[..2].to_vec());
        testing_env!(ctx("alice.near").build());
        f.add_agent_key(five[2].clone(), true);
        f.add_agent_key(five[3].clone(), false);
        assert_eq!(f.get_state().agent_keys.len(), MAX_AGENT_KEYS);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.add_agent_key(five[4].clone(), true)));
        assert!(r.unwrap_err().downcast_ref::<String>().unwrap().contains("too many agent keys"));
        // tender's push_owner (takeover and sync_owner) attaches GAS_TRANSFER = 15 TGas to set_owner.
        let attached = Gas::from_tgas(15);
        testing_env!(ctx("tender.near").prepaid_gas(attached).build());
        f.set_owner("bob.near".parse().unwrap());
        let used = env::used_gas();
        println!("set_owner deleting {MAX_AGENT_KEYS} keys: {used} of {attached} attached");
        assert!(f.get_state().agent_keys.is_empty());
        assert!(used.as_gas() * 4 < attached.as_gas(), "deleting MAX_AGENT_KEYS keys stays well under the gas tender attaches");
    }

    #[test]
    fn the_owner_revokes_an_agent_key_and_frees_its_slot() {
        let keys: Vec<PublicKey> = (0..5).map(nth_key).collect();
        testing_env!(ctx("tender.near").build());
        let mut f = Firm::new("tender.near".parse().unwrap(), "alice.near".parse().unwrap(), U128(1), U128(1), 3600, keys[..2].to_vec());
        testing_env!(ctx("alice.near").build());
        f.add_agent_key(keys[2].clone(), true);
        f.add_agent_key(keys[3].clone(), false);
        f.remove_agent_key(keys[0].clone());
        assert_eq!(f.get_state().agent_keys.len(), MAX_AGENT_KEYS - 1);
        f.add_agent_key(keys[4].clone(), true);
        testing_env!(ctx("mallory.near").build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.remove_agent_key(keys[1].clone())));
        assert!(r.is_err(), "only the owner revokes");
    }

    fn unhex(s: &str) -> Vec<u8> {
        from_hex(s).unwrap()
    }

    fn panic_msg(f: impl FnOnce()) -> String {
        let e = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("should panic");
        let m = e.downcast_ref::<String>().cloned().unwrap_or_default();
        // env::panic_str surfaces in unit tests as HostError(GuestPanic { panic_msg: "..." }).
        m.split("panic_msg: \"").nth(1).and_then(|s| s.split('"').next()).map_or(m.clone(), str::to_string)
    }

    /// RLP encoder against ethereumjs-monorepo packages/tx/test/testData/eip1559.ts, eip1559Data[0]
    /// (chain id 4, nonce 819, value 43203529): its signedTransactionRLP, i.e. rlp_bytes(0x02 || rlp(...)).
    #[test]
    fn rlp_matches_the_ethereumjs_eip1559_vector() {
        let r = unhex("0x0f924cb68412c8f1cfd74d9b581c71eeaf94fff6abdde3e5b02ca6b2931dcf47");
        let s = unhex("0x7dd1c50027c3e31f8b565e25ce68a5072110f61fce5eee81b195dd51273c2f83");
        let to = unhex("0x000000000000000000000000000000000000aaaa");
        let items = [4, 819, 75853, 121212, 35552].map(rlp_uint).to_vec();
        let items = [items, vec![rlp_bytes(&to), rlp_uint(43203529), rlp_bytes(&[]), rlp_list(&[]), rlp_uint(0), rlp_bytes(&r), rlp_bytes(&s)]].concat();
        let typed = [vec![0x02], rlp_list(&items)].concat();
        let expected = "b87102f86e048203338301284d8301d97c828ae094000000000000000000000000000000000000aaaa8402933bc980c080a00f924cb68412c8f1cfd74d9b581c71eeaf94fff6abdde3e5b02ca6b2931dcf47a07dd1c50027c3e31f8b565e25ce68a5072110f61fce5eee81b195dd51273c2f83";
        assert_eq!(to_hex(&rlp_bytes(&typed)), expected);
    }

    /// A real Base mainnet USDC transfer, value 0 and empty access list:
    /// https://basescan.org/tx/0xd0be552301024625eb9b3c3a3d7f2966ca4c7e865844d602090fe1a159671fa0 (block 53349793).
    fn base_tx() -> EvmTx {
        EvmTx {
            chain_id: 8453,
            nonce: 0x2b746,
            max_priority_fee_per_gas: U128(0xf4240),
            max_fee_per_gas: U128(0xa7d8c0),
            gas_limit: 0x1339f,
            to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".to_string(),
            data: "0xa9059cbb000000000000000000000000745317bc9ae61448e03c7664e418322fced0493c00000000000000000000000000000000000000000000000000000000072fa920".to_string(),
        }
    }

    /// keccak256 of base_tx's unsigned payload: its signature (r, s, y parity 1) recovers its sender
    /// 0x1b52482b3036589051dc74836a213dc3b445395f (checked once with @noble/curves).
    const BASE_TX_SIGNING_HASH: &str = "87bf0a16fa950770caa1dc105682660f09262f635e595a71e0cfb3c267832ce8";

    #[test]
    fn eip1559_encoding_of_a_real_base_tx() {
        testing_env!(ctx("alice.near").build());
        let tx = base_tx();
        let (to, data) = (unhex(&tx.to), unhex(&tx.data));
        assert_eq!(to_hex(&env::keccak256(&eip1559_payload(&tx, &to, &data))), BASE_TX_SIGNING_HASH);
        let r = unhex("0x73f8e74ee4b33ff79e7b00a92f95e26295c92247734c57db22020300310ba270");
        let s = unhex("0x50634b540d6be494821720b11d21a7e3b8be7e6ec55669eff949bafe3c668a1f");
        let signed = [eip1559_fields(&tx, &to, &data), vec![rlp_uint(1), rlp_bytes(&r), rlp_bytes(&s)]].concat();
        let raw = [vec![0x02], rlp_list(&signed)].concat();
        assert_eq!(to_hex(&env::keccak256(&raw)), "d0be552301024625eb9b3c3a3d7f2966ca4c7e865844d602090fe1a159671fa0", "the tx hash");
    }

    fn usdc_policy() -> EvmPolicy {
        EvmPolicy {
            chain_ids: vec![8453, 84532],
            targets: vec![EvmTarget { to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913".to_string(), selectors: vec!["0xa9059cbb".to_string()] }],
            max_gas: 100_000,
            max_fee_per_gas: U128(20_000_000),
            // The recipient of the real Base transfer in base_tx().
            recipients: vec![format!("0x{}", to_hex(&from_hex(&base_tx().data).unwrap()[16..36]))],
        }
    }

    #[test]
    fn token_transfers_go_only_to_listed_recipients() {
        let mut f = firm();
        testing_env!(ctx("alice.near").build());
        f.set_evm_policy(Some(EvmPolicy { recipients: vec![], ..usdc_policy() }));
        testing_env!(ctx("w1.tender.near").build());
        assert_eq!(panic_msg(|| drop(f.sign_evm(base_tx()))), "recipient not allowed", "a prompted agent cannot send the USDC anywhere");
        testing_env!(ctx("alice.near").build());
        f.set_evm_policy(Some(usdc_policy()));
        testing_env!(ctx("w1.tender.near").build());
        let _ = f.sign_evm(base_tx());
        assert_eq!(panic_msg(|| drop(f.sign_evm(EvmTx { data: "0xa9059cbb00".into(), ..base_tx() }))), "token call too short");
        testing_env!(ctx("alice.near").build());
        let big = EvmPolicy { chain_ids: (0..17).collect(), ..usdc_policy() };
        assert_eq!(panic_msg(|| f.set_evm_policy(Some(big))), "policy too large (16 items per list)");
    }

    #[test]
    fn a_takeover_gives_the_buyer_a_fresh_evm_address() {
        let mut f = firm();
        assert_eq!(f.evm_path(), "evm-1");
        testing_env!(ctx("tender.near").build());
        f.set_owner("bob.near".parse().unwrap());
        assert_eq!(f.evm_path(), "evm-2", "transactions the old owner signed for the old address cannot touch the new one");
        testing_env!(ctx("bob.near").build());
        f.set_evm_policy(Some(usdc_policy()));
        testing_env!(ctx("w1.tender.near").build());
        let _ = f.sign_evm(base_tx());
        let receipts = near_sdk::test_utils::get_created_receipts();
        let sign = receipts.iter().find(|r| r.receiver_id.as_str() == "v1.signer").expect("a sign call");
        let near_sdk::mock::MockAction::FunctionCallWeight { args, .. } = &sign.actions[0] else { panic!("expected a function call") };
        let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
        assert_eq!(args["request"]["path"], "evm-2");
    }

    #[test]
    fn sign_evm_sends_the_payload_hash_to_the_signer() {
        let mut f = firm();
        testing_env!(ctx("alice.near").build());
        f.set_evm_policy(Some(usdc_policy()));
        testing_env!(ctx("w1.tender.near").build());
        let _ = f.sign_evm(base_tx());
        let receipts = near_sdk::test_utils::get_created_receipts();
        assert_eq!(receipts[0].receiver_id.as_str(), "v1.signer", "default signer");
        let near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, attached_deposit, prepaid_gas, .. } = &receipts[0].actions[0] else {
            panic!("expected a function call")
        };
        assert_eq!(method_name, b"sign");
        assert_eq!(*attached_deposit, NearToken::from_yoctonear(1));
        assert!(prepaid_gas.as_tgas() >= 15, "v1.signer asks at least 15 TGas");
        let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
        assert_eq!(args, json!({"request": {"payload_v2": {"Ecdsa": BASE_TX_SIGNING_HASH}, "path": "evm-1", "domain_id": 0}}));
        let near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. } = &receipts[1].actions[0] else { panic!() };
        assert_eq!((receipts[1].receiver_id.as_str(), method_name.as_slice()), ("w1.tender.near", &b"on_evm_signed"[..]));

        testing_env!(ctx("alice.near").build());
        f.set_signer("v1.signer-prod.testnet".parse().unwrap());
        let _ = f.sign_evm(EvmTx { chain_id: 84532, ..base_tx() });
        assert_eq!(near_sdk::test_utils::get_created_receipts()[0].receiver_id.as_str(), "v1.signer-prod.testnet", "the owner signs too, on its signer");
        assert_eq!(f.get_state().signer.as_str(), "v1.signer-prod.testnet");
        assert_eq!(f.evm_path(), "evm-1");
    }

    #[test]
    fn sign_evm_refuses_what_the_policy_does_not_allow() {
        let mut f = firm();
        testing_env!(ctx("w1.tender.near").build());
        assert_eq!(panic_msg(|| drop(f.sign_evm(base_tx()))), "no evm policy");
        testing_env!(ctx("alice.near").build());
        f.set_evm_policy(Some(usdc_policy()));
        let cases: Vec<(EvmTx, &str)> = vec![
            (EvmTx { chain_id: 1, ..base_tx() }, "chain id not allowed"),
            (EvmTx { to: "0x0000000000000000000000000000000000000001".into(), ..base_tx() }, "target not allowed"),
            (EvmTx { data: "0x095ea7b3".into(), ..base_tx() }, "selector not allowed"),
            (EvmTx { gas_limit: 100_001, ..base_tx() }, "over max gas"),
            (EvmTx { max_fee_per_gas: U128(20_000_001), ..base_tx() }, "over max fee per gas"),
            (EvmTx { max_priority_fee_per_gas: U128(0xa7d8c1), ..base_tx() }, "priority fee over max fee"),
            (EvmTx { to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda029".into(), ..base_tx() }, "to must be 0x + 40 hex"),
            (EvmTx { to: "833589fcd6edb6e08f4c7c32d4f71b54bda02913".into(), ..base_tx() }, "to must be 0x + 40 hex"),
            (EvmTx { to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda0291g".into(), ..base_tx() }, "to must be 0x + 40 hex"),
            (EvmTx { data: "0xa9059cbb0".into(), ..base_tx() }, "data must be 0x hex"),
            (EvmTx { data: "0x+a9059cb".into(), ..base_tx() }, "data must be 0x hex"),
            (EvmTx { data: "0xa9059c".into(), ..base_tx() }, "data has no selector"),
        ];
        for (tx, msg) in cases {
            testing_env!(ctx("w1.tender.near").build());
            assert_eq!(panic_msg(|| drop(f.sign_evm(tx))), msg);
        }
        testing_env!(ctx("mallory.near").build());
        assert_eq!(panic_msg(|| drop(f.sign_evm(base_tx()))), "firm agent or owner only");
        testing_env!(ctx("w1.tender.near").build());
        let _ = f.sign_evm(base_tx());
        testing_env!(ctx("alice.near").build());
        f.set_evm_policy(None);
        testing_env!(ctx("w1.tender.near").build());
        assert_eq!(panic_msg(|| drop(f.sign_evm(base_tx()))), "no evm policy", "the owner turns signing off");
    }

    #[test]
    fn on_evm_signed_returns_the_signature_or_none() {
        let f = firm();
        let sig = json!({"scheme": "Secp256k1", "big_r": {"affine_point": "02aa"}, "s": {"scalar": "bb"}, "recovery_id": 1});
        testing_env!(ctx("w1.tender.near").build());
        assert_eq!(f.on_evm_signed(8453, 7, "ab".into(), Ok(sig.clone())), Some(sig));
        assert!(near_sdk::test_utils::get_logs()[0].contains(r#""event":"evm_signed""#));
        testing_env!(ctx("w1.tender.near").build());
        assert_eq!(f.on_evm_signed(8453, 7, "ab".into(), Err(near_sdk::PromiseError::Failed)), None);
        assert!(near_sdk::test_utils::get_logs()[0].contains(r#""event":"evm_sign_failed""#));
    }

    #[test]
    fn only_the_owner_sets_the_signer_and_a_well_formed_policy() {
        let mut f = firm();
        for who in ["mallory.near", "w1.tender.near"] {
            testing_env!(ctx(who).build());
            assert_eq!(panic_msg(|| f.set_evm_policy(Some(usdc_policy()))), "owner only");
            assert_eq!(panic_msg(|| f.set_signer("evil.near".parse().unwrap())), "owner only");
        }
        testing_env!(ctx("alice.near").build());
        let mut p = usdc_policy();
        p.targets[0].to = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".into();
        assert_eq!(panic_msg(|| f.set_evm_policy(Some(p))), "target must be 0x + 40 lower case hex");
        let mut p = usdc_policy();
        p.targets[0].selectors.push("0xa9059cbb00".into());
        assert_eq!(panic_msg(|| f.set_evm_policy(Some(p))), "selector must be 0x + 8 lower case hex");
        assert!(f.get_evm_policy().is_none());
        f.set_evm_policy(Some(usdc_policy()));
        assert_eq!(f.get_evm_policy().unwrap().targets[0].selectors, vec!["0xa9059cbb"]);
        assert_eq!(f.get_state().evm_policy.unwrap().max_gas, 100_000);
    }

    #[test]
    fn a_takeover_clears_the_evm_policy_and_the_signer() {
        let mut f = firm();
        testing_env!(ctx("alice.near").build());
        f.set_evm_policy(Some(usdc_policy()));
        f.set_signer("v1.signer-prod.testnet".parse().unwrap());
        testing_env!(ctx("tender.near").build());
        f.set_owner("bob.near".parse().unwrap());
        assert!(f.get_evm_policy().is_none());
        assert_eq!(f.get_state().signer.as_str(), "v1.signer");
        testing_env!(ctx("bob.near").build());
        assert_eq!(panic_msg(|| drop(f.sign_evm(base_tx()))), "no evm policy", "the new owner sets its own");
    }

    #[test]
    fn the_firm_side_agent_key_may_spend_and_sign_evm() {
        let mut f = firm();
        testing_env!(ctx("alice.near").build());
        f.add_agent_key(nth_key(1), false);
        let receipts = near_sdk::test_utils::get_created_receipts();
        let near_sdk::mock::MockAction::AddKeyWithFunctionCall { receiver_id, method_names, .. } = &receipts[0].actions[0] else { panic!() };
        assert_eq!(receiver_id.as_str(), "w1.tender.near");
        assert_eq!(method_names, &vec!["spend".to_string(), "sign_evm".to_string()]);
    }
}
