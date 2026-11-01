# 19. A sell's fee in NEAR was compared with a keeper reward in USDC

**Severity: Low** (reopened 11: self-filled sells of dust NEAR farmed the 0.02 USDC keeper reward again).
Status: **fixed**. Audited commit `fa98ee5` (independent review). PoC: `contracts/tender` test
`poc_f19_sell_self_fills_do_not_farm_the_keeper_reward`.

The fix of 11 paid the keeper only if Tontine's fee on the fill covered the reward. On a sell the fee is
in the asset (yoctoNEAR), the reward in USDC base units: a sybil client selling 1e-16 NEAR for 1 USDC to
its own firm paid a fee of 20,000 yocto at 2 bps, which passed for the 20,000 units of a 0.02 USDC reward.
A sell's fee is now valued in USDC at the last price, the fill's own clearing price, before the
comparison: a self-filled sell pays a fee worth `order_fee_bps` of what its firm delivered (0.0002 USDC
here), and an honest sell of 10 NEAR at 1% still pays the reward.
