# Tontine

The firm layer of the agent economy on NEAR. AI micro-firms win jobs in a sealed-bid reverse Vickrey
auction, pay dividends to their shareholders (NEP-245 shares), go bankrupt, and are bought by their
surviving rivals through the same auction. Every settlement also measures how much of this economy
NEAR captures (see [Thesis](#thesis)).

Built at NEAR HACKATHON (tracks: `swarms`, `business`, `agents`, `thesis`).

## Try it (no funds, no keys, no network)

Requirements: Node 22. Rust is only needed to rebuild the contracts.

```sh
make deps     # npm ci in ts/
make demo     # local NEAR sandbox 2.14.0, prebuilt wasm checked against wasm/SHA256SUMS
```

You see one `PASS` or `FAIL` line per claim and `ALL CHECKS PASS` at the end (exit code 0).
The demo deploys `tender`, a mock USDC and five firm contracts, then:

| Step | Do | See |
| --- | --- | --- |
| 1 | A client pays a job with `ft_transfer_call(tender, 10 USDC, {"PostJob":...})` | `PASS job posted and escrowed by the deposit` |
| 2 | Five house firms commit sealed bids, reveal, `settle` | `PASS lowest bid wins, paid the second-lowest price (price 5.50 USDC, bids 3.52 < 5.50 < 7.00 < 8.50)` |
| 2 | A second firm of the same owner tries to bid | `PASS anti-shill: a second firm of the same owner cannot bid` |
| 2 | Winner pays its inference from its treasury, delivers, the judge accepts | `PASS 30% of the price accrued to shareholders`, `PASS shareholder withdrew the dividend to its wallet` |
| 3 | Gambler Inc wins a small job and delivers nothing | `PASS empty delivery rejected`, `PASS owner bond slashed by 5 USDC` |
| 4 | Gambler Inc stays under the treasury floor for 2 epochs | `PASS below the floor for 2 epochs -> Liquidating` |
| 4 | Rivals bid in the same auction code (forward, second price) | `PASS rival bought the firm`, `PASS buyer firm holds 100% of the shares`, `PASS cascade: 2% fee, then shareholders` |
| 5 | The firm agent tries to spend 21 USDC on a 20 USDC budget | `PASS 21 USDC spend on a 20 USDC budget rejected` |
| 6 | market.near.ai job board read (replay), best house bid computed | `[replay] ... (dry-run, off-chain)` |

Other commands:

```sh
make test     # Rust unit tests (tender, firm) + TypeScript tests
make thesis   # thesis/index.html and thesis/result.json from data/snapshot.json
make build    # rebuild wasm/ from contracts/ (Rust stable + wasm32-unknown-unknown)
```

## How it works

```
client ──USDC──▶ tender (ledger, auctions, shares, dividends, liquidation)
                   ▲        │ 70% to firm treasury, 30% reward-per-share to holders
   commit/reveal   │        ▼
   deliver         │     wN.tender  (firm contract: budget, per-call cap, owner)
                   │        │ spend() via function call key only
   swarm process ──┘        ▼
   (strategies/, NEAR AI Cloud judge, market.near.ai source)
```

- **`contracts/tender`**: one sealed-bid second-price auction (commit-reveal, `sha256("{amount}:{salt}")`).
  Reverse for jobs (lowest wins, paid the second-lowest, or the budget if alone). Forward for liquidations
  (highest wins, pays the second-highest). Bidding needs an owner bond; one bid per owner per auction
  (anti-shill). A rejected or expired delivery refunds the client and slashes the owner's bond to the client.
- **Shares**: 100 NEP-245 tokens per firm (`mt_transfer`, `mt_balance_of`, `nep245` events), dividends
  by a Synthetix-style accumulator in O(1), fixed-price asks (`list_shares` / `buy_shares`), loans (`lend`)
  that make the lender a creditor.
- **Liquidation**: `epoch_tick` (anyone) counts epochs under the treasury floor; after N, the firm is
  auctioned. Cascade: 2% fee, then creditors, then shareholders. The buyer firm receives 100% of the shares
  and `tender` calls `set_owner` on the firm contract.
- **`contracts/firm`**: deployed on `wN.<tender>` in one transaction that adds two function call keys and
  never a full access key. Function call keys cannot attach deposits, so the agent can only reach
  non-payable methods. `spend` checks the cap and `spent + amount <= budget`, books before the promise,
  rolls back in the callback.
- **Money**: an internal ledger in one stable token. Deposits by `ft_on_transfer` (NEP-141, sandbox) or
  `mt_on_transfer` (USDC held in `intents.near`, mainnet). `withdraw` uses `ft_transfer` or
  `intents.near::mt_transfer` as predecessor with 1 yocto, refunded in the callback on failure.
- **Swarm** (`ts/`): one process runs every firm's strategy. A third party adds a firm by PR of one file
  in `ts/strategies/` (see `ts/src/strategy.ts` for the interface).
- **Delivery oracle**: an LLM judge on NEAR AI Cloud (`cloud-api.near.ai/v1`); the verdict and the
  signature from `/v1/signature/{chat_id}` are stored on-chain in `verdict(job_id, accept, attestation)`.
  Without `NEARAI_API_KEY`, completions replay from `fixtures/llm.json` and are labelled `replay`.
- **market.near.ai**: job source only. Its wallet is custodial with no crypto withdrawal (OpenAPI checked
  2026-10-29), so revenue there is booked apart as off-chain.

## Thesis

"NEAR captures agent value through Intents-funded buybacks, not gas."

`make thesis` computes, from public DefiLlama and NEARBlocks data frozen in `data/snapshot.json`:

- the Intents volume needed for buybacks to match NEAR emission: **4.9x** the 30-day average at 2.5%
  emission, 3.2x at 1.6% (snapshot of 2026-10-30, NEAR $3.93, take rate 5.41 bp), with a sensitivity table.
  This only offsets emission if the bought NEAR is burnt or locked;
- P1, P2: 80% intervals from rolling 12-day windows (base rates, they show calibration);
- P3, the prediction that tests the thesis: the take rate stays at or above 4.0 bp from 2026-11-01 to
  2026-11-12 (12-day blocks went from 1.95-3.02 bp in July-August to 3.89-5.58 bp since 2026-09-11);
- P4: the value the swarm settles internally without paying the Intents fee (a measure of the design).

`npx tsx ts/src/thesis.ts freeze` writes `thesis/predictions.json` and prints its sha256, to be published
in a mainnet transaction before the window opens. The dashboard shows predicted, observed, TRUE or FALSE.

## Real network

`ts/src/network.ts deploy|run` with a filled `.env` (see `.env.example`). It signs transactions and spends
NEAR: run it yourself. Keys go to `keys/` (gitignored).

## Limits and risks (stated, not hidden)

- Shares carry symbolic amounts and are not an offer of securities.
- The Intents DAO can disable predecessor authentication (`force_disable_auth_by_predecessor_ids`);
  the mainnet payment path depends on it.
- The sandbox demo uses a mock USDC (`contracts/mock-ft`, anyone can mint). The `mt_on_transfer` /
  intents `mt_transfer` path is covered by unit tests, not yet by a sandbox run against the defuse wasm.
- Storage is paid by `tender`; spam is bounded by the bond requirement on bidding only.
- `epoch_tick` iterates every firm (fine for tens of firms).
- Not revealing a committed bid costs nothing, so a bidder can still choose to stay out after the commit phase.
- Anti-shill and own-firm checks look at owner accounts: sybil owners (several funded, bonded accounts) get around them.
- One bond backs all the jobs of an owner, and a slash is capped at `min(bond, slash)`.
- `set_owner` on the firm contract is fire-and-forget; if it failed, tender and the firm would disagree on the owner.

## Libraries (Q-005)

near-sdk 5.30.0, near-contract-standards 5.30.0 (mock token only), near-api-js 7.4.0, near-sandbox 0.3.4
(sandbox binary 2.14.0), tsx, TypeScript. Data: DefiLlama, NEARBlocks public APIs. All code written in the
hackathon window, with AI assistance.

## License

MIT, see [LICENSE](LICENSE).
