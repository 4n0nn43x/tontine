# 21. What reached a closed firm's account could not move

**Severity: Low** (funds stuck, not stolen). Status: **fixed**. Audited commit `fa98ee5` (independent
review). PoC: `contracts/tender` test `poc_f21_a_closed_firm_balance_reaches_its_shareholders`.

A closed firm keeps its account in tender and can still be credited: NEAR in kind from the wind-up of a
firm whose shares it holds (a buyer firm holds all the shares of each firm it took over), dividends settled
to it with `settle_dividends`, a `Credit` deposit. Its NEAR had no way out (the firm contract's `spend`
moves USDC only), and its USDC only through the owner's budget, past the shareholders.
`sweep_closed_firm(firm_id)`, callable by anyone, pays a closed firm's USDC and NEAR the way its wind-up
did: lenders still owed first, then the shareholders pro rata, NEAR in kind, rounding dust to Tontine. It
refuses a firm that is not closed or has nothing to pay; the caller pays the storage of any new ledger
entry.
