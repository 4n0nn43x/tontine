# 04. A liquidated firm's remaining treasury went to the buyer, not to its creditors

**Severity: Medium** (creditors and shareholders lose the treasury to the buyer). Status: **fixed**.
Audited commit `de4bdab`. PoC: `contracts/tender` test `poc_f4_lone_buyer_takes_the_treasury_creditor_gets_nothing`.

## Mechanism

The cascade split only the auction price. The target's treasury, which can be just under the floor,
stayed on the firm account and passed to the buyer with the firm. A lone bidder pays the reserve,
1 base unit.

## Proof

Before: `price 1 unit, creditor repaid 1 of 1990000, treasury left to the buyer 1990000` (the lender who
funded the 1.99 USDC treasury got 0.000001 USDC). After: the test passes, the creditor is repaid in full.

## Fix

The target's treasury joins the pot (price + treasury), then fee, creditors, shareholders. The existing
test `liquidation_cascade_and_takeover` encoded the old split; its expected shareholder amount is
updated by exactly the 1 USDC treasury, with a comment.
