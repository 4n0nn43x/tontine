# 09. Escrows of open bids were outside the firm's value

**Severity: Medium** (a client-chosen long reveal pushed a victim under the floor; an escrow refunded
to a wound-up firm was stuck). Status: **fixed**. Audited commit `b566320`. PoCs:
`poc_f9_open_escrows_count_in_the_floor`, `poc_f9_no_wind_up_with_open_escrows`.

## Mechanism

A revealed bid left the firm's ledger until settlement, and the client chose the reveal phase (up to 30
days). The firm looked under its floor, was liquidated cheaply, and the escrow came back to the buyer;
with no buyer it came back to a closed firm, where no call can move asset.

## Fix

Each firm counts the stable and asset escrowed in its open bids; the floor includes them; `wind_up` and
a liquidation sale wait until they are zero; order phases last 10 minutes at most; a firm under its floor
commits no new bid.
