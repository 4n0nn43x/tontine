# 16. A copied commit turned the second price into the first

**Severity: Medium** (a client colluding with a bonded sybil took the winner's margin; the same trick
raised liquidation prices). Status: **fixed**. Audited commit `fa98ee5` (independent review). PoC:
`contracts/tender` test `poc_f16_a_copied_commit_cannot_be_revealed`.

A commitment was `sha256("{amount}:{salt}")`, bound to neither the auction nor the firm. A sybil owner
copied the best commit, then replayed its reveal once it was public; ties go to the earlier commit, so the
winner delivered its full bid instead of the second best, and the copy also counted toward `min_bidders`.
A commitment is now `sha256("{auction_id}:{firm_id}:{amount}:{salt}")`, in the contract and in the
swarm, the SDK and the demo.
