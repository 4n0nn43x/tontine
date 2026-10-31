# 17. buy_shares paid whatever the ask said when the transaction landed

**Severity: Medium** (a seller front-running a buyer could take its whole ledger balance). Status:
**fixed**. Audited commit `fa98ee5` (independent review). PoC: `contracts/tender` test
`poc_f17_buy_shares_never_pays_more_than_seen`.

The seller re-listed at a higher price after the buyer looked; on NEAR a local receipt runs before an
incoming one, so the re-list could land first and the buy paid 9x. `buy_shares` now takes
`max_price_per_share` and refuses an ask above it; the site passes the price it showed.
