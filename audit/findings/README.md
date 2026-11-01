# Audit findings (a self-audit and independent reviews, 2026-10-30 to 2026-11-01)

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| 01 | Old owner keeps its agent keys after a takeover and drains the new owner's bond | High | fixed |
| 02 | Dividends on shares held by a firm account could never be claimed | Medium | fixed |
| 03 | Any caller grew tender's storage at tender's expense | Medium | fixed |
| 04 | A liquidated firm's remaining treasury went to the buyer, not to its creditors | Medium | fixed |
| 05 | Zero or dust loans grew a firm's debt list without bound | Medium | fixed |
| 06 | A late dispute let the client cancel a job before the judge could rule | Medium | fixed |
| 07 | Settling an auction nobody bid on paid the keeper reward | Low | fixed |
| 08 | One dust fill set the reference price, which drove floors, bands and liquidation reserves | High | fixed |
| 09 | Escrows of open bids were outside the firm's value | Medium | fixed |
| 10 | A fill turned lent cash into inventory that went to shareholders ahead of the lender | Medium | fixed |
| 11 | Self-filled dust orders farmed the keeper reward | Low | fixed |
| 12 | A bid the contract made impossible to reveal was slashed | Low | fixed |
| 13 | Ledger entries created at settlement were paid by nobody | Low | fixed, one case left |
| 14 | Self-fills walked the reference price 3% at a time until it overflowed | High | fixed |
| 15 | Enough agent keys made set_owner run out of gas, so the old owner kept the firm | High | fixed |
| 16 | A copied commit turned the second price into the first | Medium | fixed |
| 17 | buy_shares paid whatever the ask said when the transaction landed | Medium | fixed |
| 18 | storage_deposit with nothing attached created an entry nobody paid for | Low | fixed |
| 19 | A sell's fee in NEAR was compared with a keeper reward in USDC | Low | fixed |
| 20 | An old owner was slashed for a bid that a takeover made impossible to reveal | Low | fixed |
| 21 | What reached a closed firm's account could not move | Low | fixed |
| 22 | The old owner kept control of the firm's EVM address after a takeover | Medium | fixed |
| 23 | A quote committed before a takeover was a free option | Low | fixed |
| 24 | Anyone could push Tontine's fee balance out with withdraw_to_intents | Low | fixed |
| 25 | The EVM policy limited the call, not where the tokens went | Low | fixed, amount not capped |

Re-run every PoC: `cd ts && npx tsx src/audit-poc.ts` (prints NOT REPRODUCED on the fixed contracts) and
`cd contracts && cargo test poc_`.

## Design limits, not fixed (stated in the README)

- A firm owner can raise its own budget and `spend` the firm treasury, including money lent to it:
  lending to a firm is unsecured credit to its owner.
- One bond backs all the bids of an owner and a slash is capped at it; sybil owners get around the
  one-bid-per-owner rule.
- Someone filling their own orders can still walk the reference price 3% an hour (14).

## Coverage

Read in full: `contracts/tender/src/lib.rs`, `contracts/firm/src/lib.rs`. Out of scope: `mock-ft`
(sandbox only), the off-chain swarm. Classes walked: access control and key management, async receipts
and callbacks, storage staking, shares and dividend accounting, liquidation cascade, auction clearing,
deposits from intents.near. The earlier review (commit 3a2dd96, ba97778) covered overflow, lock
counters and rounding.

Second pass (commit `2b3c89c`, 2026-10-30) on what was added after the first one: `create_firm`, fees,
loans with interest, keeper rewards, optimistic review and evaluator disputes, closing, profiles. It found
05 to 07; each PoC fails on `2b3c89c` and passes on the fix.

Third pass (2026-10-31): the job model was replaced by orders (commit `b566320`); an independent reviewer,
who did not write the code, found 08 to 13 with PoCs. 06 concerned the dispute path, which no longer exists.
Every finding up to 05, and 07, still has its test or sandbox PoC on the order contract.

Fourth pass (commit `fa98ee5`, 2026-10-31): a second independent reviewer re-read both contracts and
checked the fixes of 01 to 13. It found 14 to 18, each with a PoC that fails on `fa98ee5` and a test that
passes on the fix. It also found three Lows, fixed afterwards: the fix of 11 compared a fee in NEAR with a
reward in USDC on sell orders (19); the fix of 12 missed a firm taken over between its commit and the
settlement (20); NEAR credited to a closed firm account could not be moved (21). Each has a PoC test,
`poc_f19_...` to `poc_f21_...`, that fails with its fix reverted and passes with it.

Fifth pass (2026-11-01, uncommitted work on `fa3c438`: surplus share, launch shares, `withdraw_to_intents`,
`sweep_closed_firm`, the EVM signing path): a third independent reviewer found 22 to 25 (nothing High) and
confirmed each with a test; all fixed, 25 without an amount cap.
