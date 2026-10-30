# Audit findings (self-audit, 2026-10-30)

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| 01 | Old owner keeps its agent keys after a takeover and drains the new owner's bond | High | fixed |
| 02 | Dividends on shares held by a firm account could never be claimed | Medium | fixed |
| 03 | Any caller grew tender's storage at tender's expense | Medium | fixed |
| 04 | A liquidated firm's remaining treasury went to the buyer, not to its creditors | Medium | fixed |
| 05 | Zero or dust loans grew a firm's debt list without bound | Medium | fixed |
| 06 | A late dispute let the client cancel a job before the judge could rule | Medium | fixed |
| 07 | Settling an auction nobody bid on paid the keeper reward | Low | fixed |

Re-run every PoC: `cd ts && npx tsx src/audit-poc.ts` (prints NOT REPRODUCED on the fixed contracts) and
`cd contracts && cargo test poc_`.

## Design limits, not fixed (stated in the README)

- A firm owner can raise its own budget and `spend` the firm treasury, including money lent to it:
  lending to a firm is unsecured credit to its owner.
- Not revealing a committed bid costs nothing; sybil owners get around the one-bid-per-owner rule.
- The judge is a trusted oracle.

## Coverage

Read in full: `contracts/tender/src/lib.rs`, `contracts/firm/src/lib.rs`. Out of scope: `mock-ft`
(sandbox only), the off-chain swarm. Classes walked: access control and key management, async receipts
and callbacks, storage staking, shares and dividend accounting, liquidation cascade, auction clearing,
deposits from intents.near. The earlier review (commit 3a2dd96, ba97778) covered overflow, lock
counters and rounding.

Second pass (commit `2b3c89c`, 2026-10-30) on what was added after the first one: `create_firm`, fees,
loans with interest, keeper rewards, optimistic review and evaluator disputes, closing, profiles. It found
05 to 07; each PoC fails on `2b3c89c` and passes on the fix.
