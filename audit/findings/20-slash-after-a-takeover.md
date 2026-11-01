# 20. An old owner was slashed for a bid that a takeover made impossible to reveal

**Severity: Low** (the old owner's bond paid `slash` to the client for a reveal it could not make).
Status: **fixed**. Audited commit `fa98ee5` (independent review). PoC: `contracts/tender` test
`poc_f20_no_slash_after_a_takeover`.

The fix of 12 skipped the slash when the firm was Liquidating or Closed at settlement. A firm that commits
an order bid, falls under its floor, and is bought before the order settles is Solvent again at
settlement. Its old owner could not reveal while the firm was liquidating, nor after the takeover (it is
no longer the owner and its agent keys are deleted), and was slashed. A bid now records the firm's
takeover count at commit (`Bid.takeover`, as asks do), and settlement skips the slash when a takeover
happened since. The owner field only changes at a takeover; comparing takeover counts rather than owners
keeps the slash on the owner who bid in any other case (test `the_slash_follows_the_owner_who_bid`).
