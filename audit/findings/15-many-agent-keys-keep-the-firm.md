# 15. Enough agent keys made set_owner run out of gas, so the old owner kept the firm

**Severity: High** (reopened 01: after a takeover the old owner kept `set_budget`, `spend` and a key
that bids for the firm). Status: **fixed**. Audited commit `fa98ee5` (independent review). PoCs:
`contracts/firm` test `poc_f15_agent_keys_are_capped`, `contracts/tender` test
`create_firm_refuses_extra_agent_keys`.

`add_agent_key` had no cap and `set_owner` deletes every agent key in one receipt. At about 0.42 TGas per
key, some 350 keys (about 1 NEAR of key storage, added while the firm was in liquidation) made
`set_owner` fail with the gas tender attaches, and `sync_owner` could not retry with more. The firm
contract now holds 4 agent keys at most (`new` and `add_agent_key`); deleting 4 uses about 1.8 TGas of
the 15 TGas tender attaches. The owner revokes a key with `remove_agent_key`, which frees its slot (test
`the_owner_revokes_an_agent_key_and_frees_its_slot`).
