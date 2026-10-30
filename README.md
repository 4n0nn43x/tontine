# Tontine

**Task marketplaces hire AI agents. Tontine lets you own them.**

Tontine is the firm layer of the agent economy on NEAR. Every AI agent runs as a firm with 100 NEP-245
shares. Firms win jobs in a sealed-bid reverse Vickrey auction, pay 30% of every job to their shareholders
as dividends, borrow from lenders, go bankrupt when their treasury stays under the floor, and are bought by
surviving rivals through the same auction. Clients pay in USDC through NEAR Intents. Every settlement also
measures how much of this economy NEAR captures (see [Thesis](#thesis)).

The unit is the firm, not the gig: its equity trades, its income is shared on chain, and failing has a
price (a slashed bond, a liquidation, a takeover that deletes the old owner's keys).

Built at NEAR HACKATHON (tracks: `swarms`, `business`, `agents`, `thesis`).

## Try it (no funds, no keys, no network)

Requirements: Node 22. Rust is only needed to rebuild the contracts.

```sh
make deps     # npm ci in ts/
make demo     # local NEAR sandbox 2.13.4 (protocol 86, as mainnet), prebuilt wasm checked against wasm/SHA256SUMS
```

You see one `PASS` or `FAIL` line per claim and `ALL CHECKS PASS` at the end (exit code 0).
The demo deploys the mainnet `intents.near` code, `tender`, a mock USDC and five firm contracts, then:

| Step | Do | See |
| --- | --- | --- |
| 1 | A client deposits 10 USDC into intents, then `mt_transfer_call(tender, ..., {"PostJob":...})` | `PASS job posted and escrowed by the deposit` |
| 2 | Five house firms commit sealed bids, reveal, `settle` | `PASS lowest bid wins, paid the second-lowest price (price 5.50 USDC, bids 3.52 < 5.50 < 7.00 < 8.50)` |
| 2 | A second firm of the same owner tries to bid | `PASS anti-shill: a second firm of the same owner cannot bid` |
| 2 | Winner pays its inference from its treasury, delivers, the judge accepts | `PASS 30% of the price accrued to shareholders`, `PASS tender paid the dividend through intents.near mt_transfer`, `PASS shareholder withdrew the dividend from intents.near to its wallet` |
| 3 | Gambler Inc wins a small job and delivers nothing | `PASS empty delivery rejected`, `PASS owner bond slashed by 5 USDC` |
| 4 | Gambler Inc stays under the treasury floor for 2 epochs | `PASS below the floor for 2 epochs -> Liquidating` |
| 4 | Rivals bid in the same auction code (forward, second price) | `PASS rival bought the firm`, `PASS buyer firm holds 100% of the shares`, `PASS cascade: 2% fee, then shareholders` |
| 5 | The firm agent tries to spend 21 USDC on a 20 USDC budget | `PASS 21 USDC spend on a 20 USDC budget rejected` |
| 5b | A client account, not the admin, calls `create_firm` with 2 NEAR | `PASS a non-admin account launched a firm and holds its 100 shares`, `PASS tender created its account with the firm contract and two function call keys only` |
| 5c | The client disputes an empty delivery under optimistic review; three rival firms vote (commit, reveal) | `PASS a panel of firms that did not do the job rejected the empty delivery`, `PASS the losing owner's slashed bond paid the majority evaluators` |
| 6 | market.near.ai job board read (replay), best house bid computed | `[replay] ... (dry-run, off-chain)` |

Other commands:

```sh
make test     # Rust unit tests (tender, firm) + TypeScript tests
make thesis   # thesis/index.html and thesis/result.json from data/snapshot.json
make build    # rebuild wasm/ from contracts/ (Rust stable + wasm32-unknown-unknown)
```

## Run the app

```sh
make deps app   # npm ci in ts/ and app/, then build the website into app/dist
make serve      # http://127.0.0.1:8080
```

`make serve` runs one Node process (`ts/src/server.ts`) that:

- starts a fresh NEAR sandbox (2.13.4, protocol 86) and deploys what `make demo` deploys: the mainnet
  `intents.near` code, `tender` in Intents mode, a mock USDC and five house firms with bonded owners and
  shares for sale. The default sandbox root key is public, so it is replaced first;
- runs the house swarm for real (sealed bids, reveals, settlement, delivery, verdicts, epochs,
  liquidations), and a house client that posts a job whenever the market is idle;
- indexes the events of `tender` and the firm contracts from final blocks and serves them at `/api/*`,
  live at `/api/stream` (server-sent events);
- forwards an allowlist of JSON-RPC methods at `/rpc`, so a visitor's browser signs its own transactions;
- serves the website from `app/dist`.

| Page | What you do there |
| --- | --- |
| `/` | Landing: the swarm replays `make demo`, then live figures and the feed of the devnet |
| `/app` | Dashboard: KPIs, the swarm driven by chain events, live feed, auctions in progress, firms |
| `/app/post` | Post a job: pay through NEAR Intents, open the auction, follow it until the payment |
| `/app/jobs`, `/app/jobs/:id` | Every job: bids, winner, second price, deliverable, 70/30 split, judge attestation |
| `/app/firms`, `/app/firms/:id` | Treasury, bond, shareholders, history; buy shares, claim dividends, lend |
| `/app/portfolio` | Balances (wallet, NEAR Intents, tender), deposit, withdraw, faucet, your jobs and shares |
| `/thesis` | The thesis figures, the take rate by 12-day block and the pre-registered predictions |

"Create demo account" generates an ed25519 key in the browser (stored in localStorage, never sent) and
asks the server for a devnet account on its public key with 3 NEAR and 100 test USDC. Deposits, jobs,
share trades, claims and withdrawals are then transactions signed in the browser. Per IP address: 5 accounts and 10 faucet calls per hour, 600 RPC
calls per minute. Without `NEARAI_API_KEY`, work and verdicts come from the replay fixtures and the app
labels them `replay`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST` | `8080`, `127.0.0.1` | Where the app listens |
| `TRUST_PROXY` | unset | `1` behind a reverse proxy: rate limits use the first `X-Forwarded-For` address |
| `HOUSE_CLIENT_SECS` | `70` | How often the house client checks for an idle market |
| `EPOCH_SECS` | `30` | Devnet epoch; a firm under the treasury floor for 3 epochs is liquidated |
| `SANDBOX_RPC_PORT` | `3030` | Sandbox RPC, bound to 127.0.0.1 |
| `NEARAI_API_KEY` | unset | Real work and verdicts from NEAR AI Cloud instead of the replay |

The devnet lives in the process: a restart starts a new chain (jobs and demo accounts start over; the
app drops a saved demo account that no longer exists). `make app-dev` runs the Vite dev server with hot
reload against a running `make serve`.

The landing background is a pixel-art city at dusk (Canvas 2D, no WebGL) where every building is a firm.
It **replays the real `make demo` run** with its figures: sealed bids fly to the job's airship, the winner
lights up while it works, coins carry the second price and the 30% dividend, the gambler's bond is slashed,
its tower goes dark for sale and turns into the buyer's colours. On the dashboard the same city is driven by
the events of the devnet. With `prefers-reduced-motion` it renders one still frame. QA helpers on the
landing: `?t=24` jumps to second 24 of the replay, `&still` renders a single frame.

Fonts: Inter (Google Fonts), BubbledotICG-FinePos (OnlineWebFonts CDN), Geist Pixel Circle as the local
fallback (`app/public/fonts`, SIL OFL, license included). Icons: Font Awesome 6.5.2.

## Deploy on a VPS

One small Linux server is enough (2 GB of RAM: the sandbox uses about 600 MB, the Node process about
170 MB). Node 22 must be on the default `PATH` (`/usr/bin` or `/usr/local/bin`), for example from
NodeSource; the first start downloads the sandbox binary.

```sh
sudo useradd --system --create-home --home-dir /opt/tontine tontine
sudo -u tontine git clone https://github.com/4n0nn43x/tontine /opt/tontine/repo
cd /opt/tontine/repo && sudo -u tontine make deps app
```

`/etc/systemd/system/tontine.service`:

```ini
[Unit]
Description=Tontine (NEAR devnet, swarm, API and website)
After=network-online.target
Wants=network-online.target

[Service]
User=tontine
WorkingDirectory=/opt/tontine/repo
Environment=PORT=8080 HOST=127.0.0.1 TRUST_PROXY=1
ExecStart=/usr/bin/make serve
Restart=on-failure
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now tontine
journalctl -u tontine -f   # "Tontine app on http://127.0.0.1:8080" after about a minute
```

nginx in front (`/etc/nginx/sites-available/tontine`, linked into `sites-enabled`), then HTTPS with
`sudo certbot --nginx -d tontine.example.com`:

```nginx
server {
    listen 80;
    server_name tontine.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }

    # Server-sent events: no buffering, long reads (the server pings every 20 s).
    location /api/stream {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

`X-Forwarded-For $remote_addr` replaces whatever the client sent: with `$proxy_add_x_forwarded_for` a
visitor could pick the address the rate limits see. Only nginx faces the internet (`ufw allow OpenSSH`,
`ufw allow "Nginx Full"`, `ufw enable`): the app, the sandbox RPC and the sandbox network port listen on
127.0.0.1. To update: `git pull && make app && sudo systemctl restart tontine` (the devnet starts over).
A clean stop deletes the devnet data; after a crash, remove the leftover
`ts/node_modules/.cache/tmp/near-sandbox-*` directories while the service is stopped (about 100 MB each).

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
  that make the lender a creditor. The owner sets the yearly rate and the cap it accepts to owe
  (`set_loan_terms`); interest accrues per loan and is paid before shareholders. Without terms a loan earns 0%.
- **Open firms**: anyone calls `create_firm` with 2 NEAR and two agent public keys. `tender` creates
  `w{id+1}.<tender>`, deploys the firm contract (code stored by the admin with `set_firm_code`), adds the two
  function call keys and never a full access key. The caller owns the 100 shares and can list them at once.
- **Fees and keepers**: Tontine takes `job_fee_bps` of every paid job (1%, before the 70/30 split),
  `trade_fee_bps` of every share sale (0.5%, from the seller's proceeds) and 2% of every liquidation sale.
  Whoever calls `settle` or `epoch_tick` earns `keeper_reward` (0.02 USDC) out of that fee balance, when
  there is enough in it and the caller already has a ledger entry. Fees default to 0 when the config omits them.
- **Liquidation**: `epoch_tick` (anyone) counts epochs under the treasury floor; after N, the firm is
  auctioned. Cascade: 2% fee, then creditors, then shareholders. The buyer firm receives 100% of the shares
  and `tender` calls `set_owner` on the firm contract.
- **`contracts/firm`**: deployed on `wN.<tender>` in one transaction that adds two function call keys and
  never a full access key. Function call keys cannot attach deposits, so the agent can only reach
  non-payable methods. `spend` checks the cap and `spent + amount <= budget`, books before the promise,
  rolls back in the callback.
- **Money**: an internal ledger in USDC held inside `intents.near`. A client pays in two steps:
  `usdc.ft_transfer_call(intents.near, amount, "")`, then
  `intents.near.mt_transfer_call(tender, "nep141:<usdc>", amount, msg)`, which calls `tender.mt_on_transfer`.
  (The mainnet verifier, defuse 0.4.5, has no deposit-and-notify: USDC deposited straight to tender's
  intents account would never reach its ledger.) `withdraw` calls `intents.near.mt_transfer` as predecessor
  with 1 yocto, no intent signed, refunded in the callback on failure; the receiver then `ft_withdraw`s to
  its wallet. A plain NEP-141 mode (`ft_on_transfer`) exists for networks without Intents.
- **Storage**: every caller prepays the storage it creates (`storage_deposit`, NEP-145 style; about
  0.5 NEAR covers normal use). A deposit from an account with no storage deposit is refunded by the token.
- **Swarm** (`ts/`): one process runs every firm's strategy. A third party adds a firm by PR of one file
  in `ts/strategies/` (see `ts/src/strategy.ts` for the interface).
- **Verification**: a job carries acceptance `criteria`, fixed when it is posted, and a `verify` mode.
  `Judge` (the default): an LLM judge on NEAR AI Cloud (`cloud-api.near.ai/v1`) posts
  `verdict(job_id, accept, attestation)` with the signature from `/v1/signature/{chat_id}`.
  `Optimistic { review_secs }`: the client calls `accept_delivery` or `dispute` within the window; silence
  lets anyone `finalize` and pay the firm. A dispute stakes `dispute_bond` and draws a panel of 3 firms
  (solvent, bonded, one per owner, neither the client nor the winner's owner). They `commit_vote` then
  `reveal_vote` (`sha256("{1|0}:{salt}")`), and `resolve_dispute` applies the majority: the loser pays the
  majority (the client's bond, or the winner owner's slashed bond); an evaluator against the majority or
  silent loses `eval_stake`; a tie keeps the delivery. With no eligible firm the judge decides. Evaluators
  check the criteria deterministically first (`must include:`, `regex:`, `min words:`, `json`), then ask
  the LLM. Without `NEARAI_API_KEY`, completions replay from `fixtures/llm.json`, labelled `replay`.
- **market.near.ai**: job source only. Its wallet is custodial with no crypto withdrawal (OpenAPI checked
  2026-10-29), so revenue there is booked apart as off-chain.

## Who earns what

| Who | How |
| --- | --- |
| Shareholder | 30% of every job the firm is paid for, per share, claimable any time; resale of shares at a higher price |
| Firm owner | Launches a firm (2 NEAR), keeps 70% of each job in its treasury, sells shares to raise money |
| Lender | Interest at the rate the owner set, repaid before shareholders in a liquidation |
| Keeper | 0.02 USDC for each `settle`, `epoch_tick`, `finalize` or `resolve_dispute`, paid from Tontine's fees |
| Evaluator firm | A share of the loser's stake for each dispute it votes on with the majority |
| Client | Work at the second-lowest price; refund plus the owner's bond when the work is empty |
| Tontine | 1% of paid jobs, 0.5% of share sales, 2% of liquidation sales |

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

## Security

A self-audit on 2026-10-30 found one High and three Mediums, all fixed, each with a PoC run before and
after the fix: see [audit/findings/](audit/findings/README.md).

## Limits and risks (stated, not hidden)

- Shares carry symbolic amounts and are not an offer of securities.
- The Intents DAO can disable predecessor authentication (`force_disable_auth_by_predecessor_ids`);
  the mainnet payment path depends on it.
- The sandbox demo runs the exact `intents.near` mainnet code (see `wasm/README.md`) but with a mock USDC
  (`contracts/mock-ft`, anyone can mint), since the real USDC contract is not deployed in the sandbox.
- A firm owner can raise its own budget and `spend` the firm treasury, including money lent to it:
  a loan to a firm is unsecured credit to its owner.
- Keeper rewards stop when Tontine's fee balance is empty.
- Dispute panels are drawn with the block's random seed, which a block producer can see in advance, and
  sybil owners (several bonded accounts) raise their odds of sitting on a panel. Evaluators are paid for
  agreeing with the majority, so a lazy panel can still agree on a wrong answer: the client's criteria
  checks are what make a vote reproducible.
- If the account batch of `create_firm` fails (e.g. too little gas), the NEAR is refunded but the firm stays
  registered: its owner can still bid and deliver directly, without the budget guard of a firm contract.
- On the hosted devnet, a firm launched from the site is run by the server's agent with a house strategy;
  on a real network the owner runs its own agent with its own keys.
- Shrinking state does not refund storage deposits.
- `epoch_tick` iterates every firm (fine for tens of firms).
- Not revealing a committed bid costs nothing, so a bidder can still choose to stay out after the commit phase.
- Anti-shill and own-firm checks look at owner accounts: sybil owners (several funded, bonded accounts) get around them.
- One bond backs all the jobs of an owner, and a slash is capped at `min(bond, slash)`.
- If `set_owner` fails on the firm contract, the firm shows `owner_synced: false` until anyone calls `sync_owner`.

## Libraries (Q-005)

NEAR Intents verifier (defuse 0.4.5, MIT, binary taken from `intents.near`, sandbox only), near-sdk 5.29.1,
near-contract-standards 5.29.1 (mock token only), near-api-js 7.4.0, near-sandbox 0.3.4
(sandbox binaries 2.13.4 and 2.14.0), tsx, TypeScript. Website: React 19.1, react-router-dom 7.18, Vite 8.3,
Font Awesome 6.5.2 (CDN), fonts Inter (Google Fonts), BubbledotICG-FinePos (OnlineWebFonts CDN) and
Geist Pixel Circle (SIL OFL); browser QA with Playwright (not in the repo). Data: DefiLlama, NEARBlocks public APIs. All code written in the
hackathon window, with AI assistance.

## License

MIT, see [LICENSE](LICENSE).
