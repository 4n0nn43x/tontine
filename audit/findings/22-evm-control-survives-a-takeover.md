# 22. The old owner kept control of the firm's EVM address after a takeover

**Severity: Medium** (transactions signed for future nonces, or approvals, kept working on the address the
buyer inherited; signing also worked while the firm was in liquidation). Status: **fixed**. Audited state:
the uncommitted work on `fa3c438` (independent review, 2026-11-01). Test: `contracts/firm`
`a_takeover_gives_the_buyer_a_fresh_evm_address`.

The derivation path was fixed (`evm-1`), so the buyer inherited an address the old agent could have
pre-signed transfers for. The path now carries the ownership generation, bumped by `set_owner`: a buyer
starts on a fresh address, and what sits on the old one does not pass with the firm (stated in SDK.md, so
bidders do not price it in).
