# 06. A late dispute let the client cancel a job before the judge could rule

**Severity: Medium** (the client keeps the work and gets the price back; the firm is not paid).
Status: **fixed**. Audited commit `2b3c89c`. PoC: `contracts/tender` test `poc_f6_late_dispute_then_expire_before_the_judge`.

## Mechanism

`expire` cancels a job that waited `JUDGE_TIMEOUT_SECS` (3 days) for a verdict, counted from the delivery
deadline. A dispute with no eligible evaluator goes to the judge, but the clock was not restarted. With an
optimistic job whose review window is longer than 3 days, a client could dispute after deadline + 3 days and
call `expire` in the same block: price and dispute bond refunded, no slash, no verdict, firm unpaid.

## Proof

Before: review window of 5 days, dispute after 4 days, `expire` at once: job `Cancelled`, client +10 USDC,
firm treasury 0. After: `expire` is refused until 3 days after the end of the dispute's vote phases, and a
judge outage still ends in a refund.

## Fix

For a disputed job the judge's 3 days start at the dispute's `reveal_end` (never before the deadline).
