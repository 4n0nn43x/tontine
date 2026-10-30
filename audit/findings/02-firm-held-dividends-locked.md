# 02. Dividends on shares held by a firm account could never be claimed

**Severity: Medium** (permanent lock of yield). Status: **fixed**.
Audited commit `de4bdab`. PoC: `ts/src/audit-poc.ts` (F2).

## Mechanism

After a takeover, the buyer **firm account** holds 100% of the target's shares, so 30% of every job the
target is paid for accrues to that firm account. `claim_dividends` needs 1 yocto; the firm account has
only function call keys, which cannot attach deposits, and the firm contract has no method that calls
`claim_dividends`. The owner is not the holder (`not a holder`). The yield was locked until the target
was liquidated again.

## Proof

Before: `CONFIRMED F2 ... pending 3.00 USDC for w2.tender.sandbox; agent key: Deposit is not allowed with
function call; owner: ... not a holder`. After: `settle_dividends: ok, pending now 0.00`.

## Fix

`tender.settle_dividends(firm_id, account_id)`: anyone can pay a holder its dividends **into the holder's
own ledger balance** (no one can redirect them). Added to the agent key's allowed methods.
