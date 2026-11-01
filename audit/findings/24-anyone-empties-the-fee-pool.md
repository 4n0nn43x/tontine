# 24. Anyone could push Tontine's fee balance out with withdraw_to_intents

**Severity: Low** (no loss in the shipped configs, where the admin is the tender account and intents.near
refuses a self transfer; real if the admin becomes a separate account). Status: **fixed**. Test:
`contracts/tender` `poc_f24_nobody_moves_tontines_fee_balance`.

The fee balance pays keeper rewards. `withdraw_to_intents` now refuses the admin and the tender account.
The same pass hardened finding 19: a sell's fee is valued at the price before the fill moves it
(`poc_f19_the_fee_is_valued_before_the_fill_moves_the_price`).
