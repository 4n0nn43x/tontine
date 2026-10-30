# 05. Zero or dust loans grew a firm's debt list without bound

**Severity: Medium** (cost-bounded denial of service on one firm, and on `epoch_tick` for every firm).
Status: **fixed**. Audited commit `2b3c89c`. PoC: `contracts/tender` test `poc_f5_dust_loans_bloat_the_firm`.

## Mechanism

`lend` accepted any amount, 0 included, from any account with a storage deposit: `debit(me, 0)` needs no
balance. Each call pushed a 36-byte `Debt` into `f.debts`, even under the owner's loan cap (a loan of 0
never exceeds it). The whole `Firm` is read and written on every call that touches it, `epoch_tick` loads
every firm, and `get_firms` returns them all: their gas grows with the list, for about 0.0004 NEAR of
storage per entry.

## Proof

Before: 1,000 loans of 0 from `x.near` (no USDC) are accepted and the firm serializes to 36,179 bytes.
After: loans of 0 and 0.5 USDC are refused, the 21st open loan is refused, and a repaid loan frees its slot.

## Fix

A loan is at least 1 USDC (`MIN_LOAN`) and a firm carries at most 20 open loans (`MAX_DEBTS`). Filling the
20 slots now costs 20 USDC, paid into the target's treasury and repaid only at the owner's discretion.
