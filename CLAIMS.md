# CLAIMS

One line per claim of the README: the test that proves it, the command, and whether it is measured on
a real network or simulated. Explorer links are added when the mainnet run happens.

| Claim | Proof | Command | Badge |
| --- | --- | --- | --- |
| Lowest sealed bid wins, paid the second-lowest price | `reverse_vickrey_pays_second_price_and_dividends`, demo step 2 | `make test`, `make demo` | simulated (sandbox) |
| Single bid is paid the budget | `single_bid_paid_at_budget` | `make test` | unit |
| Reveal must match the commit | `reveal_must_match_commit`, `bid_hash_vector` (Rust and TS share one vector) | `make test` | unit |
| One bid per owner per auction (anti-shill) | `anti_shill_one_bid_per_owner`, demo step 2 | `make test`, `make demo` | simulated (sandbox) |
| Bidding requires an owner bond | `bid_requires_bond` | `make test` | unit |
| 70% to the firm, 30% to shareholders by reward per share | `reverse_vickrey_pays_second_price_and_dividends`, demo step 2 | `make test`, `make demo` | simulated (sandbox) |
| Shareholder withdraws dividends to its wallet | demo step 2 (`withdraw` then `ft_balance_of`) | `make demo` | simulated (sandbox) |
| Failed withdraw is refunded | `failed_withdraw_is_refunded` | `make test` | unit |
| Rejected delivery refunds the client and slashes the bond | `rejected_delivery_slashes_bond_and_refunds_client`, demo step 3 | `make test`, `make demo` | simulated (sandbox) |
| Undelivered job expires and is treated as rejected | `undelivered_job_expires` | `make test` | unit |
| Only the judge posts verdicts | `only_judge_gives_verdict` | `make test` | unit |
| Firm under the floor for N epochs is liquidated, bought by a rival at the second price | `liquidation_cascade_and_takeover`, demo step 4 | `make test`, `make demo` | simulated (sandbox) |
| Cascade: 2% fee, then creditors, then shareholders | `liquidation_cascade_and_takeover`, demo step 4 | `make test`, `make demo` | simulated (sandbox) |
| Buyer gets 100% of the shares and the owner field of the firm contract | demo step 4 (`mt_balance_of`, `get_state`) | `make demo` | simulated (sandbox) |
| Firm accounts never have a full access key | demo (`view_access_key_list`) | `make demo` | simulated (sandbox) |
| 21 USDC spend on a 20 USDC budget is rejected | `spend_21_on_budget_20_rejected`, demo step 5 | `make test`, `make demo` | simulated (sandbox) |
| Failed spend is rolled back | `failed_transfer_rolls_back` | `make test` | unit |
| Agent key cannot call a deposit-taking method | demo step 5 | `make demo` | simulated (sandbox) |
| Intents deposits credited, impostor contracts refused | `mt_on_transfer_credits_intents_deposits`, `mt_on_transfer_rejects_impostor` | `make test` | unit |
| Firm pays its inference from its treasury | demo step 2 | `make demo` | simulated (sandbox) |
| Judge never accepts an empty deliverable | `judge never accepts an empty deliverable` | `make test` | unit |
| Buyback multiple 4.9x at 2.5% emission | `thesis multiple reproduces the spec figure`, `thesis/result.json` | `make thesis` | measured (public data, snapshot 2026-10-30) |
| Take rate 12-day blocks 1.95-3.02 bp (Jul-Aug), 3.89-5.58 bp since 2026-09-11 | `thesis/index.html` | `make thesis` | measured (public data) |
| Phases and deadlines capped at 30 days (no overflow can freeze `settle`) | `huge_deliver_secs_refused` | `make test` | unit |
| No loans to a firm in liquidation | `no_loans_to_a_firm_in_liquidation` | `make test` | unit |
| Bond lock and slash follow the owner who bid, even after a sale | `lock_and_slash_follow_the_owner_who_bid` | `make test` | unit |
| Delivered job without a verdict is cancelled after 3 days, no slash | `delivered_job_without_verdict_times_out_without_slash` | `make test` | unit |
| One bid per firm per auction | `one_bid_per_firm_even_after_a_sale` | `make test` | unit |
| Dividend rounding never pays more than distributed | `dividend_rounding_never_pays_more_than_distributed` | `make test` | unit |
| A takeover voids older share asks | `takeover_voids_old_asks` | `make test` | unit |
| A takeover deletes the old owner's agent keys and freezes spending | `only_tender_sets_owner`, demo step 4 | `make test`, `make demo` | simulated (sandbox) |
| A failed owner push to the firm contract can be retried by anyone | `failed_owner_sync_can_be_retried`, demo step 4 | `make test`, `make demo` | simulated (sandbox) |
| Contracts deploy on protocol 86 (mainnet today) and 88 | demo on sandbox 2.13.4 and 2.14.0 | `make demo`, `SANDBOX_VERSION=2.14.0 make demo` | simulated (sandbox) |
| Predictions hash published before the window | not yet: `thesis.ts freeze`, then a mainnet tx | | pending |
| A third party paid a job on-chain | not yet | | pending |
