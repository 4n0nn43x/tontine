# 08. One dust fill set the reference price, which drove floors, bands and liquidation reserves

**Severity: High** (forced liquidation of a victim and theft of its inventory; settlements and epochs
bricked by overflow; honest bonds slashed). Status: **fixed**. Audited commit `b566320` (independent
review). PoCs: `contracts/tender` tests `poc_f8_one_fill_cannot_set_the_price`,
`poc_f8_a_fill_during_an_auction_cannot_push_bids_out_of_band`, `poc_f8_no_price_can_liquidate_a_firm_with_cash`.

## Mechanism

The last clearing price valued every firm's NEAR for the floor (net asset value), anchored the owners'
price bands and set the liquidation reserve. A sybil client filled its own dust order with its own firm
(no band) and set that price at will: 1e24 overflowed `value()` (settlements and `epoch_tick` panicked);
0 put a firm holding 1 USDC and 100 NEAR under the floor, and the attacker bought it, NEAR included, for
1 unit; a move during an auction pushed honest reveals out of band and their bonds went to the attacker.

## Proof

Before (reviewer's PoCs on `b566320`): `last_price after dust fill: 1e30`, `settle panics: true`;
`attacker paid 1 stable unit(s); w4 asset now 100 NEAR`; `x.near gained 410000000 (refund 400 USDC +
slashes)`. After: the three tests pass.

## Fix

- The floor is a cash requirement (USDC treasury plus escrows of open bids): it never reads a price.
- A liquidated or wound-up firm's NEAR goes to its shareholders in kind; the buyer gets the firm, not the
  inventory. The reserve is back to 1 unit.
- Bands are checked against the reference price stored when the order was posted.
- Orders have a minimum size (`min_order`); one fill moves the reference price by `max_move_bps` at most;
  price arithmetic saturates.
