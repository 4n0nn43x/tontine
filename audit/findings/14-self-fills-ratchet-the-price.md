# 14. Self-fills walked the reference price 3% at a time until it overflowed

**Severity: High** (every settle with a winner panicked for good; escrows and bonds stuck; before that,
banded firms frozen out). Status: **fixed**. Audited commit `fa98ee5` (independent review). PoCs:
`contracts/tender` tests `poc_f14_self_fills_cannot_ratchet_the_price`, `poc_f14_the_price_bounds_saturate`.

## Mechanism

The fix of 08 capped the move of one fill, not of a series. A sybil client sold 1 yocto of NEAR to its
own band-free firm for the minimum order (fee 0 on 1 yocto, USDC recycled between its own accounts), and
each fill moved the reference up 3%. With mainnet parameters, about 2,175 fills (roughly 17 NEAR of gas
and storage) brought `last_price` above `u128::MAX / 10300`, and `last_price * (BPS + m)` overflowed in
every later settle. Long before that, the pumped reference put honest firms out of their owners' bands.

## Proof

Before (reviewer's PoC on `fa98ee5`): settle panics with "attempt to multiply with overflow" after the
ratchet. After: 20 self-fills in an hour move the reference 3% in total, 3% more the next hour, and a
fill at a reference near `u128::MAX / 10000` settles.

## Fix

- The reference moves by `max_move_bps` at most per hour in total, from the price the hour opened at,
  however many fills there are: walking it 100x takes about a week of continuous self-trading.
- The bounds saturate and never reach 0, so no price can brick a settle.
- Left (stated in the README): someone filling their own orders can still walk it 3% an hour; a fast
  market makes it lag NEAR by the same limit. Only fills move it, so once it is more than a firm's band
  away from NEAR, that firm stays out until its owner widens the band (a reviewer pushed it 12.5% in about
  three hours of self-fills). An independent anchor (an oracle) would remove this.
