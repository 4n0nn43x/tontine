# 25. The EVM policy limited the call, not where the tokens went

**Severity: Low** (a prompted or hijacked agent allowed USDC `transfer` could send the whole balance
anywhere). Status: **fixed, amount not capped**. Test: `contracts/firm`
`token_transfers_go_only_to_listed_recipients`.

ERC-20 `transfer`, `approve` and `transferFrom` now need their recipient in the owner's `recipients` list
(none listed: refused). Every policy list holds 16 items at most, so `set_owner`, which clears the policy,
always fits the gas tender attaches. Left: the amount of a transfer to a listed recipient is not capped.
