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
| After Tontine's job fee, 70% to the firm, 30% to shareholders by reward per share | `reverse_vickrey_pays_second_price_and_dividends`, demo step 2 | `make test`, `make demo` | simulated (sandbox) |
| Deposits reach tender through the mainnet intents.near code (`mt_transfer_call` -> `mt_on_transfer`) | demo steps 1 to 3 | `make demo` | simulated (sandbox, mainnet code) |
| tender moves its intents.near balance as predecessor, no intent signed | demo step 2 (`withdraw` -> `mt_balance_of`) | `make demo` | simulated (sandbox, mainnet code) |
| Shareholder withdraws dividends to its wallet | demo step 2 (`ft_withdraw` from intents, then `ft_balance_of`) | `make demo` | simulated (sandbox, mainnet code) |
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
| Buyback multiple 5.4x at 2.5% emission | `thesis multiple reproduces the spec figure`, `thesis/result.json` | `make thesis` | measured (public data, snapshot 2026-10-30) |
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
| Contracts deploy on protocol 86 (mainnet until about 2026-11-04) and 88 (from about 2026-11-07) | demo on sandbox 2.13.4 and 2.14.0 | `make demo`, `SANDBOX_VERSION=2.14.0 make demo` | simulated (sandbox) |
| Audit findings 01 to 04 fixed (old owner's keys, firm-held dividends, storage, liquidation treasury) | `audit-poc.ts` prints NOT REPRODUCED; `poc_f1_*`, `poc_f4_*` | `cd ts && npx tsx src/audit-poc.ts`, `make test` | simulated (sandbox) |
| Loans are at least 1 USDC, at most 20 open per firm (audit 05) | `poc_f5_dust_loans_bloat_the_firm` | `make test` | unit |
| A dispute restarts the judge's 3 days before the job can expire (audit 06) | `poc_f6_late_dispute_then_expire_before_the_judge` | `make test` | unit |
| No keeper reward for a job auction nobody won (audit 07) | `poc_f7_keeper_farms_auctions_nobody_bid_on` | `make test` | unit |
| The thesis verdict is read only on or after 2026-11-14 | `evaluate stays pending until the 12-day window is complete and read on time` | `make test` | unit |
| Callers prepay the storage they create | F3 in `audit-poc.ts` | `cd ts && npx tsx src/audit-poc.ts` | simulated (sandbox) |
| Predictions hash published before the window | not yet: `thesis.ts freeze`, then a mainnet tx | | pending |
| A third party paid a job on-chain | not yet | | pending |
| Anyone launches a firm (`create_firm`), owns its 100 shares and can list them at once | `anyone_creates_a_firm_and_owns_its_shares`, demo step 5b | `make test`, `make demo` | simulated (sandbox) |
| A firm created by `create_firm` has the firm contract and two function call keys, no full access key | demo step 5b | `make demo` | simulated (sandbox) |
| Only the admin stores the firm code | `only_admin_sets_firm_code` | `make test` | unit |
| 1% job fee to Tontine, taken before the 70/30 split | `job_fee_goes_to_tontine_before_the_dividend_split` | `make test` | unit |
| 0.5% share sale fee, from the seller's proceeds | `share_sale_fee_comes_out_of_the_seller_proceeds` | `make test` | unit |
| Loans follow the owner's rate and cap, and pay interest | `loans_follow_the_owner_terms_and_earn_interest` | `make test` | unit |
| A loan without terms earns no interest | `loans_without_terms_stay_at_zero_interest` | `make test` | unit |
| Keepers are paid from Tontine's fees, never from an empty balance | `keepers_are_paid_from_tontine_fees_when_there_are_any` | `make test` | unit |
| A delivery is judged against criteria fixed when the job was posted | `client_accepts_and_the_firm_is_paid_at_once` (criteria stored), demo step 5c | `make test`, `make demo` | simulated (sandbox) |
| Optimistic review: the client accepts, or silence pays the firm after the window | `client_accepts_and_the_firm_is_paid_at_once`, `silence_pays_the_firm_after_the_review_window` | `make test` | unit |
| Only the client disputes, and only within the window | `only_the_client_disputes_and_only_in_the_window` | `make test` | unit |
| A panel of rival firms rejects an empty delivery; the loser's slashed bond pays the majority | `panel_rejects_an_empty_delivery_and_the_loser_pays_the_evaluators`, demo step 5c | `make test`, `make demo` | simulated (sandbox) |
| An evaluator against the majority or silent loses its stake; a tie keeps the delivery | `panel_accepts_good_work_and_the_minority_loses_its_stake`, `a_silent_evaluator_is_slashed_and_a_tie_keeps_the_delivery` | `make test` | unit |
| Votes are sealed and only panel members vote | `votes_are_sealed_and_only_panel_members_vote`, `vote hash matches the contract format` | `make test` | unit |
| No eligible evaluator: the judge decides; the judge cannot overrule an optimistic delivery | `no_eligible_evaluator_falls_back_to_the_judge`, `the_judge_cannot_overrule_an_optimistic_delivery` | `make test` | unit |
| Criteria checks are deterministic | `criteria checks are deterministic and fail on the first broken rule` | `make test` | unit |
| A liquidation without a buyer winds the firm up: creditors, then shareholders | `a_liquidation_without_a_buyer_winds_the_firm_up` | `make test` | unit |
| An owner closes its firm; the shareholders get the treasury; a closed firm no longer bids or borrows | `an_owner_closes_its_firm_and_the_shareholders_get_the_treasury` | `make test` | unit |
| A firm with an open job cannot close | `a_firm_with_an_open_job_cannot_close` | `make test` | unit |
| Owners publish their firm's spec on chain (JSON object, owner only) | `owners_publish_their_firm_spec` | `make test` | unit |
| A firm runs on its owner's machine with its own keys (SDK runner) | `ts/src/agent.ts` against the devnet `/rpc` | `npx tsx src/agent.ts firm.json` | simulated (devnet) |
