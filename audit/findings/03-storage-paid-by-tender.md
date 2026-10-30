# 03. Any caller grew tender's storage at tender's expense

**Severity: Medium** (protocol-wide denial of service, about 16x cost asymmetry). Status: **fixed**.
Audited commit `de4bdab`. PoC: `ts/src/audit-poc.ts` (F3).

## Mechanism

NEAR charges storage to the contract account. Deposits (`Credit` to fresh accounts), `post_job`
(2,000-byte brief, budget of 1 base unit), `list_shares`, `lend`, `deliver` (4,000-byte result) all
grew tender's state with nothing charged to the caller. Once tender's free NEAR is consumed, every
state-growing call fails: no new jobs, no bids, no verdicts.

## Proof

Before: `10 jobs of 1e-6 USDC: tender storage +22050 bytes = 0.2205 NEAR locked on tender; attacker paid
0.0134 NEAR of gas (ratio 16.46x)`. After: `attacker paid 0.2205 NEAR of it from its storage deposit`.

## Fix

NEP-145-style prepaid storage: `storage_deposit`, `storage_withdraw`, `storage_balance_of`. Each
state-growing call measures the growth (after flushing the `store` collections, which cache writes until
the end of the call) and bills its payer: depositor, client, bidding owner, delivering owner, lister,
lender, buyer, claimer. A deposit from an account without a storage deposit panics and the token
refunds it. Shrinking state is not refunded (noted with a `ponytail:` comment).
