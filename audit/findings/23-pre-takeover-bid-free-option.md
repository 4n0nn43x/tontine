# 23. A quote committed before a takeover was a free option

**Severity: Low** (needs a sybil buyer and short epochs; feasible on the devnet's 30 s epochs, not with 1 h
epochs). Status: **fixed**. Test: `contracts/tender` `poc_f23_a_bid_committed_before_a_takeover_cannot_be_revealed`.

The fix of 20 waives the slash of a bid committed before a takeover, but the buyer (or the old agent key,
until `set_owner` landed) could still reveal it when the market moved its way. `reveal_bid` now refuses a
bid whose firm changed hands since the commit.
