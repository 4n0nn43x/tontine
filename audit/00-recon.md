# Recon: Tontine contracts (self-audit)

- Commit: `de4bdab8885a8ee44dcd62d3acfa6da5959f0fc8`
- Platform: none (own code, hackathon). Severity uses Immunefi-style impact wording.
- Language: Rust, near-sdk 5.29.1, NEAR protocol 86. The EVM classes mostly do not apply; the
  threat model is NEAR's: asynchronous receipts (state changes are not rolled back across
  receipts), `#[private]` callbacks, 1 yocto as proof of a full access key, function call keys,
  storage staking paid by the contract account.

## Scope

| File | Lines | Role |
| --- | ---: | --- |
| `contracts/tender/src/lib.rs` | 1033 | ledger, auction, jobs, shares, dividends, liquidation |
| `contracts/firm/src/lib.rs` | 214 | budget guard of one firm, agent keys, owner |
| `contracts/mock-ft/src/lib.rs` | 94 | sandbox-only token, out of scope |

## Actors and trust

| Actor | Can call | Trusted not to |
| --- | --- | --- |
| admin (tender account) | `register_firm`; receives liquidation fees | (registration only) |
| judge | `verdict` | judge falsely (trusted oracle) |
| client | deposits, `post_job`, `withdraw`, `transfer`, `lend`, `buy_shares` | nothing |
| firm owner | `commit_bid`/`reveal_bid`/`deliver` for its firm, bonds, firm `set_budget`, `add_agent_key`, `spend` | nothing (untrusted third party) |
| firm agent (function call keys on `wN.tender`) | tender: `commit_bid, reveal_bid, deliver, settle, epoch_tick, expire`; firm: `spend` | exceed the budget |
| shareholder | `mt_transfer`, `list_shares`, `claim_dividends` | nothing |
| anyone | `settle`, `epoch_tick`, `expire`, `sync_owner` | nothing |
| intents.near | `mt_on_transfer` | trusted (Payment::Intents) |

## Value flow

- In: `ft_on_transfer` (Ft mode), `mt_on_transfer` (Intents mode). Credited to `balances`.
- Rest: `balances` (ledger), `bonds`, job escrow (budget then price), takeover escrow (revealed
  forward bids), unclaimed dividends (`acc_per_share` vs holding `debt`).
- Out of the contract: `withdraw` (ft_transfer or intents mt_transfer, refund callback).
- Internal exits: `transfer`, `pay`, `reject`, liquidation cascade, `buy_shares`, `lend`/`repay`.

## Invariants

- [D] firm accounts have no full access key; ownership changes only through tender (README).
- [D] the firm agent cannot spend over budget (README).
- [D] after a takeover the old owner's agent keys are deleted (README, demo step 4).
- [U] conservation: sum(balances) + bonds + escrows + unclaimed dividends == tokens held.
- [U] every accrued dividend is claimable by its holder.
- [U] every state has an exit: jobs, auctions, liquidations, bonds, escrows.
- [U] storage growth caused by a caller is paid by that caller, or bounded.

## Entry points that change state

tender: `ft_on_transfer`, `mt_on_transfer`, `transfer`*, `withdraw`*, `on_withdraw`(private),
`deposit_bond`*, `withdraw_bond`*, `register_firm`(admin), `claim_dividends`*, `mt_transfer`*,
`list_shares`*, `buy_shares`*, `lend`*, `repay`*, `commit_bid`, `reveal_bid`, `settle`,
`post_job`*, `deliver`, `verdict`(judge), `expire`, `epoch_tick`, `on_set_owner`(private),
`sync_owner`. (* = 1 yocto)

firm: `spend`, `on_spend`(private), `set_budget`(owner), `set_owner`(tender), `add_agent_key`(owner).
