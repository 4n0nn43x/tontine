# 18. storage_deposit with nothing attached created an entry nobody paid for

**Severity: Low** (each call grew tender's state by about 134 bytes for about a quarter of their cost in
gas; same class as 03). Status: **fixed**. Audited commit `fa98ee5` (independent review). PoCs:
`contracts/tender` tests `poc_f18_an_empty_storage_deposit_cannot_grow_the_state`,
`poc_f18_a_new_entry_is_paid_from_its_deposit`.

A new storage entry is now paid out of the deposit that creates it: an empty or too small first deposit
is refused, and a top-up of an existing entry costs nothing. The same review found siblings: a withdrawal
of 0 (`storage_withdraw`, `withdraw_bond`, `withdraw`, `withdraw_asset`) created entries for an account that
had none; they now refuse 0 (test `poc_f18_zero_withdrawals_are_refused`).
