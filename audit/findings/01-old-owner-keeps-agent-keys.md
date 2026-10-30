# 01. Old owner keeps its agent keys after a takeover and drains the new owner's bond

**Severity: High** (theft of a third party's funds, repeatable). Status: **fixed**.
Audited commit `de4bdab`. PoC: `ts/src/audit-poc.ts` (F1a, F1b) and `contracts/firm` test `poc_f1_duplicate_agent_key_refused`.

## Mechanism

- `firm.add_agent_key` pushed the key into `agent_keys` and then sent a detached `AddKey`. Re-adding a
  key that already exists makes the `AddKey` receipt fail, but the push in the earlier receipt stays.
- `firm.set_owner` deleted all `agent_keys` in **one** batched promise. With a duplicate in the list,
  the second `DeleteKey` fails and the whole batch reverts: no key is deleted.
- `tender.on_set_owner` only sees `set_owner` succeed (the deletion was detached), so the firm even
  reports `owner_synced: true`.

## Attack (old owner Alice, new owner Bob)

1. Alice, before losing her firm X, calls `X.add_agent_key(<existing agent key>, true)`.
2. X is liquidated and bought by Bob's firm. Alice's two agent keys survive on X.
3. Alice posts a 10 USDC job as client, commits a 1-unit bid for X with her surviving tender key
   (`commit_bid` accepts `predecessor == f.account`, and checks Bob's bond, since Bob owns X now).
4. X wins, Alice delivers `""` with the same key, the judge rejects the empty deliverable.
5. `reject` refunds Alice and slashes **Bob's** bond to her.

## Proof (sandbox, protocol 86, real contracts)

Before the fix:
```
CONFIRMED  F1a takeover leaves the old owner's keys on the firm account
    owner is now bob.sandbox, owner_synced=true, access keys still on w1.tender.sandbox: 2
CONFIRMED  F1b old owner steals the new owner's bond with the surviving key
    alice net +5.00 USDC (ledger 90.00 -> 105.00 after paying 10 in), bob bond 10.00 -> 5.00; repeatable per job until the bond is empty
```
After the fix:
```
    duplicate add_agent_key refused: add_agent_key: Smart contract panicked: key already registered
NOT REPRODUCED  F1a ... access keys still on w1.tender.sandbox: 0
NOT REPRODUCED  F1b ... attack blocked: Access key ... does not exist on account w1.tender.sandbox
```
Once Bob sets a budget, the same surviving firm key could also `spend` X's treasury.

## Fix

`add_agent_key` refuses a key already in `agent_keys`; `set_owner` deletes each key in its own promise,
so one failure cannot keep the others.
