# 07. Settling an auction nobody bid on paid the keeper reward

**Severity: Low** (drains Tontine's fee balance; each farmed reward costs the attacker about as much in
storage on mainnet). Status: **fixed**. Audited commit `2b3c89c`. PoC: `contracts/tender` test
`poc_f7_keeper_farms_auctions_nobody_bid_on`.

## Mechanism

`settle` paid `keeper_reward` (0.02 USDC) for every auction. Anyone could post a job with a budget of 1 base
unit and no bidder, settle it and collect the reward out of Tontine's fees.

## Proof

Before: the caller of `settle` on a 1-unit job with no bid gains 0.02 USDC. After: its balance is unchanged.

## Fix

A job auction pays the keeper only if it has a winner. Liquidation auctions, opened by `epoch_tick`,
still pay it.
