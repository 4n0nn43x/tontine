# Tontine

**AI agents make markets. Tontine lets you own them.**

**Live demo: [tontine.fyra.fun](https://tontine.fyra.fun)** (devnet: demo accounts and faucet built in, no wallet or funds needed)

Tontine is the firm layer of the agent economy on NEAR. Every AI agent runs as a firm with 100 NEP-245
shares, a USDC treasury and a NEAR inventory. Firms are market makers: clients swap NEAR and USDC through
NEAR Intents, firms quote by sealed bid, the best quote fills at the second best, atomically, and never worse
than what NEAR Intents 1Click gives. 30% of each fill's edge goes to the firm's shareholders. Firms borrow,
fail when their cash stays under a floor, and are bought by rivals through the same auction. The owner of a
firm sets its limits on chain (price band, NEAR share, kill switch); the AI decides inside them.

The unit is the firm, not the trade: its equity trades, its income is measured and shared on chain, and
failing has a price (a slashed bond, a liquidation, a takeover that deletes the old owner's keys). No judge:
what a firm delivers is a token transfer the contract checks itself. Every settlement also feeds a thesis on
how NEAR captures value from agents (see [Thesis](#thesis)).

Built at NEAR HACKATHON (tracks: `swarms`, `business`, `agents`, `defi`, `thesis`).

## Try it (no funds, no keys, no network)

Requirements: Node 22. Rust is only needed to rebuild the contracts.

```sh
make deps     # npm ci in ts/
make demo     # local NEAR sandbox 2.13.4 (protocol 86, mainnet's until about 2026-11-04), prebuilt wasm checked against wasm/SHA256SUMS
```

You see one `PASS` or `FAIL` line per claim and `ALL CHECKS PASS` at the end (exit code 0). The demo
deploys the mainnet `intents.near` code, `tender`, mock USDC and wNEAR, and six firm contracts, prices
NEAR at a real Binance close (5.347 USD, 2026-10-08), then:

| Step | Do | See |
| --- | --- | --- |
| 1 | A client deposits 40 USDC into intents, then `mt_transfer_call(tender, ..., {"PostOrder":...})`, its minimum set at the 1Click price | `PASS order posted, the 40 USDC escrowed by the deposit` |
| 2 | The firms commit sealed quotes, reveal, `settle` | `PASS the best quote wins and delivers the second best (7.4763 NEAR, bids 7.4778 > 7.4763 > 7.4726)`, `PASS the client got at least what NEAR Intents 1Click would give (+19.0 bp ...)`, `PASS settlement is atomic ...` |
| 2 | A second firm of the same owner tries to bid | `PASS anti-shill: a second firm of the same owner cannot bid` |
| 3 | 30% of the winner's edge accrues to its shareholders; one claims and withdraws through intents.near | `PASS 30% of the edge accrued to shareholders`, `PASS tender paid the dividend through intents.near mt_transfer`, `PASS shareholder withdrew the dividend ...` |
| 4 | A client sells 2 NEAR | `PASS sell order filled at least at the 1Click reference` |
| 5 | Atlas AI's manager retunes its quotes from its results (an LLM with `NEARAI_API_KEY`, else a stated rule) | `PASS manager decision recorded (...), params bounded` |
| 6 | A firm commits a quote and never reveals it | `PASS the silent bidder's owner bond paid the client` |
| 7 | A hijacked agent bids half the price for its firm's NEAR | `PASS the 50%-off bid is refused at reveal by the owner's price band`, `PASS the firm kept its inventory` |
| 8 | Gambler Inc spends its cash on NEAR until it is under the floor | `PASS cash under the floor for 2 epochs -> Liquidating`, `PASS a rival bought the firm ...`, `PASS its NEAR went to its old shareholder in kind, not to the buyer`, `PASS old owner's agent keys deleted on takeover`, `PASS cascade: 2% fee, then shareholders` |
| 9 | The firm agent tries to spend 21 USDC on a 20 USDC budget | `PASS 21 USDC spend on a 20 USDC budget rejected` |
| 10 | A client account, not the admin, calls `create_firm` with 3 NEAR | `PASS a non-admin account launched a firm and holds its 100 shares`, `PASS tender created its account with the firm contract and two function call keys only` |

Other commands:

```sh
make test     # Rust unit tests (tender, firm) + TypeScript tests
make sim      # the market off chain with the contract's rules on a real week of NEAR prices (SEED=1)
make thesis   # thesis/index.html and thesis/result.json from data/snapshot.json
make build    # rebuild wasm/ from contracts/ (Rust stable + wasm32-unknown-unknown)
```

`make sim` runs 20 clients and 12 firms (the six house firms and six makers with seeded spreads) through
the contract's order rules (`ts/src/rules.ts`, the same code the swarm uses before revealing a bid) on the
week of NEAR prices to 2026-10-30. With `SEED=1` it prints 2036 orders, 93.3% filled, 18.2 bp better than
1Click on average, Gambler Inc liquidated and bought for 1 USDC, the concentration of fills (HHI 2237: four
firms share 92% of the fills, none above 27%), each firm's edge, dividends and P&L against holding its
inventory, and an ablation of Atlas AI's manager against fixed params (23.88 against 16.31 USDC). Four
house firms are managed: a firm that wins too few orders tightens its spread, a firm that loses money widens
it, so no spread stays the cheapest for long. The rules are written out in [RULES.md](RULES.md) with a sequence diagram.

## Run the app

```sh
make deps app   # npm ci in ts/ and app/, then build the website into app/dist
make serve      # http://127.0.0.1:8080
```

`make serve` runs one Node process (`ts/src/server.ts`) that:

- starts a fresh NEAR sandbox (2.13.4, protocol 86) and deploys what `make demo` deploys: the mainnet
  `intents.near` code, `tender` in Intents mode, mock USDC and wNEAR and six house firms with bonded owners,
  cash, NEAR and shares for sale. The default sandbox root key is public, so it is replaced first;
- prices NEAR with live NEAR Intents 1Click quotes (the replay when offline) and runs the house swarm for
  real: sealed quotes, reveals, settlement, the AI manager, epochs, liquidations; a house client posts a buy
  or a sell, at the 1Click price, whenever the market is idle;
- indexes the events of `tender` and the firm contracts from final blocks and serves them at `/api/*`,
  live at `/api/stream` (server-sent events);
- forwards an allowlist of JSON-RPC methods at `/rpc`, so a visitor's browser signs its own transactions;
- serves the website from `app/dist`.

| Page | What you do there |
| --- | --- |
| `/` | Landing: the swarm replays `make demo`, then live figures and the feed of the devnet |
| `/app` | Dashboard: KPIs, the NEAR price and the fills, the swarm driven by chain events, live feed, firms |
| `/app/trade` | An exchange-style screen: NEAR candles with Tontine's fills, market or limit order (the 1Click quote or your price sets the minimum), the firms' indicative quotes, your orders and balances |
| `/app/orders`, `/app/orders/:id` | Every order: sealed quotes, winner, the second best delivered, 1Click reference, edge, dividends |
| `/app/firms`, `/app/firms/:id` | Cash, NEAR, value, policy, manager decisions, shareholders; buy shares, claim dividends, lend |
| `/app/portfolio` | USDC and wNEAR (wallet, NEAR Intents, tender), deposit, withdraw, faucet, your orders and shares |
| `/thesis` | The thesis figures, the take rate by 12-day block and the pre-registered predictions |

"Create demo account" generates an ed25519 key in the browser (stored in localStorage, never sent) and
asks the server for a devnet account on its public key with 5 NEAR, 100 test USDC and 20 test wNEAR.
Deposits, orders, share trades, claims and withdrawals are then transactions signed in the browser. Per IP
address: 5 accounts and 10 faucet calls per hour, 600 RPC calls and 60 quotes per minute.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST` | `8080`, `127.0.0.1` | Where the app listens |
| `TRUST_PROXY` | unset | `1` behind a reverse proxy: rate limits use the first `X-Forwarded-For` address |
| `HOUSE_CLIENT_SECS` | `70` | How often the house client checks for an idle market |
| `EPOCH_SECS` | `30` | Devnet epoch; a firm under the cash floor for 3 epochs is liquidated |
| `MANAGER_SECS` | `180` | How often managed firms review their results |
| `SANDBOX_RPC_PORT` | `3030` | Sandbox RPC, bound to 127.0.0.1 |
| `NEARAI_API_KEY` | unset | The manager of Atlas AI asks an LLM on NEAR AI Cloud (the firm pays the inference); without it, a stated rule, labelled `rule` |
| `REPLAY` | unset | `1`: price NEAR from the replay instead of live 1Click quotes |

The devnet lives in the process: a restart starts a new chain (orders and demo accounts start over; the
app drops a saved demo account that no longer exists). `make app-dev` runs the Vite dev server with hot
reload against a running `make serve`.

The landing background is a pixel-art city at dusk (Canvas 2D, no WebGL) where every building is a firm.
It **replays the real `make demo` run** with its figures; on the dashboard the same city is driven by the
events of the devnet. With `prefers-reduced-motion` it renders one still frame. QA helpers on the landing:
`?t=24` jumps to second 24 of the replay, `&still` renders a single frame.

Shared links get a preview (X, Discord, Slack, Telegram...): crawlers do not run the app, so the server writes each
page's title, description and Open Graph tags into `index.html` (`ts/src/meta.ts`). An order or firm link describes
that order or firm from the chain. The image, `app/public/og.png`, is a still of the landing (`/?t=24&still`).

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
client ──USDC or wNEAR via NEAR Intents──▶ tender (two ledgers, sealed auctions, shares, dividends, liquidation)
                                              ▲        │ fill: second best to the client, amount_in to the firm,
          commit / reveal / settle (agents)   │        ▼ 30% of the edge to its shareholders
                                              │     wN.tender (firm contract: budget, per-call cap, owner)
  swarm process ──────────────────────────────┘        │ spend() via function call key only (inference)
  (strategies/, AI manager on NEAR AI Cloud, 1Click reference prices)
```

- **`contracts/tender`**: two internal ledgers, the stable token (USDC: bonds, fees, dividends, loans) and
  the asset (wNEAR). One sealed-bid second-price auction (commit-reveal, `sha256("{amount}:{salt}")`, highest
  bid wins) serves orders and liquidations. The full rules, with a sequence diagram, are in [RULES.md](RULES.md).
- **Orders**: a client escrows what it sells and sets its minimum (the reserve, set by the app at the 1Click
  quote). Firms commit the amount they will deliver and escrow it when they reveal, so settlement cannot fail.
  The best fills at the second best (the minimum if alone): the client is paid and the winner receives what
  the client sold, less Tontine's fee, in the same transaction. A committed bid never revealed costs its
  owner's bond 1% of the order (at least 1 USDC), paid to the client. One bid per owner per auction
  (anti-shill), never on its owner's own order, at least two bids to fill.
- **Edge and dividends**: a fill's edge is what the winner received minus what it delivered, at the previous
  clearing price; 30% of a positive edge goes to the firm's shareholders at once (Synthetix-style reward per
  share, O(1)). The clearing price becomes the reference, moving 3% per fill at most, on orders of 1 USDC or more.
- **Policy and kill switch**: the owner sets, on chain, the band around the reference price its firm may
  quote in, the most of its value it may hold in NEAR, and a pause. The contract checks them on every reveal:
  an agent that is wrong, prompted into a bad trade or hijacked cannot step out (demo step 7). The owner can
  also stop spending at once with `set_budget(0, 0)` on the firm contract and close the firm.
- **AI manager** (`ts/src/manager.ts`): a managed firm's manager reviews its fills, edge and inventory and
  retunes its spread, NEAR target and lean. For Atlas AI, with `NEARAI_API_KEY`, it is an LLM on NEAR AI Cloud
  and the firm pays the inference from its treasury through its firm contract; without a key, and for the
  other managed house firms (Undercut, Cost Plus, Sniper), a stated rule does it. Every decision is labelled
  with its source. Quoting itself is deterministic (`defaultQuote`).
- **Shares**: 100 NEP-245 tokens per firm (`mt_transfer`, `mt_balance_of`, `nep245` events), fixed-price asks
  (`list_shares` / `buy_shares`), loans (`lend`) on the owner's terms (`set_loan_terms`: yearly rate, cap);
  a firm that owes lenders keeps that much cash: it cannot turn it into NEAR.
- **Open firms**: anyone calls `create_firm` with 3 NEAR (code storage and agent gas) and two agent public
  keys. `tender` creates `w{id+1}.<tender>`, deploys the firm contract (code stored by the admin with
  `set_firm_code`), adds the two function call keys and never a full access key. The caller owns the 100 shares.
- **Fees and keepers**: Tontine takes `order_fee_bps` of what the winner receives (2 bp), `trade_fee_bps` of
  every share sale (0.5%, from the seller) and 2% of every liquidation sale. Whoever calls `settle` or
  `epoch_tick` earns `keeper_reward` (0.02 USDC) from that fee balance, for a fill only if its fee covers it.
- **Cash floor and liquidation**: `epoch_tick` (anyone) counts epochs a firm's USDC treasury (escrows of its
  open bids included) stays under the floor; it never reads a price. Under it a firm stops quoting; after N
  epochs it is auctioned. The price and its cash pay a 2% fee, its lenders, then its shareholders; its NEAR
  goes to its shareholders in kind. The buyer firm gets 100% of the shares and `tender` calls `set_owner` on
  the firm contract, which deletes the old agent keys. No buyer: the firm is wound up and closed.
- **`contracts/firm`**: deployed on `wN.<tender>` in one transaction that adds two function call keys and
  never a full access key. Function call keys cannot attach deposits, so the agent can only reach
  non-payable methods. `spend` checks the cap and `spent + amount <= budget`, books before the promise,
  rolls back in the callback.
- **Money**: both tokens live inside `intents.near`. A client pays in two steps:
  `token.ft_transfer_call(intents.near, amount, "")`, then
  `intents.near.mt_transfer_call(tender, "nep141:<token>", amount, msg)`, which calls `tender.mt_on_transfer`.
  (The mainnet verifier, defuse 0.4.5, removed the notification on deposits in near/intents PR #374: a
  deposit credited straight to tender's intents account would never reach its ledger.) `withdraw` and
  `withdraw_asset` call `intents.near.mt_transfer` as predecessor with 1 yocto, no intent signed, refunded
  in the callback on failure; the receiver then `ft_withdraw`s to its wallet. A plain NEP-141 mode
  (`ft_on_transfer`) exists for networks without Intents.
- **Prices** (`ts/src/prices.ts`): live NEAR Intents 1Click dry quotes (no key; they include the 0.2% fee
  1Click adds without a key), or Binance 5-minute closes frozen in `fixtures/near-usd-5m.json` for the demo,
  the simulation and offline runs. Firms are not NEAR Intents solvers: that network needs KYC and forbids
  sub-solvers, so Tontine runs its own sealed RFQ and uses NEAR Intents as the rails for money in and out.
- **Storage**: every caller prepays the storage it creates (`storage_deposit`, NEP-145 style; about
  0.5 NEAR covers normal use). A deposit from an account with no storage deposit is refunded by the token.
- **Swarm** (`ts/`): one process runs every house firm's strategy. A third party adds a firm by PR of one
  file in `ts/strategies/` (see `ts/src/strategy.ts`), or runs its own with the SDK.

## Run your own firm (SDK)

Write a firm in one file with `defineFirm({ spec, params, quote?, managed? })` and run it with your own keys:
`npx tsx src/agent.ts firm.json`. The spec (name, description, pairs, model, order sizes) is published on
chain with `set_firm_profile`. The site's "Launch your firm" creates the firm and downloads `firm.json` with
agent keys made in the browser. Details in [SDK.md](SDK.md); example in `ts/firms/example.ts`.

## Who earns what

| Who | How |
| --- | --- |
| Shareholder | 30% of each fill's edge, per share, claimable any time; the cash and the NEAR of a firm that winds up; resale of shares |
| Firm owner | Launches a firm (3 NEAR), funds it with USDC and NEAR, keeps 70% of its edge, sells shares to raise money |
| Lender | Interest at the rate the owner set, repaid before shareholders; the firm keeps the cash it owes |
| Keeper | 0.02 USDC for each `settle` or `epoch_tick`, paid from Tontine's fees when they cover it |
| Client | A swap at the second-best quote, never worse than NEAR Intents 1Click; the bond slash of a firm that commits and does not reveal |
| Tontine | 2 bp of each fill, 0.5% of share sales, 2% of liquidation sales |

## Thesis

"NEAR captures agent value through Intents-funded buybacks, not gas."

`make thesis` computes, from public DefiLlama and NEARBlocks data frozen in `data/snapshot.json`:

- the Intents volume needed for buybacks to match NEAR emission: **5.4x** the 30-day average at 2.5%
  emission, 3.5x at 1.6% (snapshot of 2026-10-30, NEAR $4.36, take rate 5.55 bp), with a sensitivity table.
  This only offsets emission if the bought NEAR is burnt or locked, and on 2026-10-30 it was neither: it sat
  on a 2-of-4 multisig (see the evidence against in [THESIS.md](THESIS.md));
- P1, P2: 80% intervals from rolling 12-day windows (base rates, they show calibration);
- P3, the prediction that tests the thesis: the take rate stays at or above 4.0 bp from 2026-11-01 to
  2026-11-12 (12-day blocks went from 1.95-3.02 bp in July-August to 3.89-5.58 bp since 2026-09-11);
- P4: the value the swarm settles internally without paying the Intents fee (a measure of the design).

`npx tsx ts/src/thesis.ts freeze` writes `thesis/predictions.json` and prints its sha256, to be published
in a mainnet transaction before the window opens. The verdict is read on or after 2026-11-14, since
DefiLlama still revises the last days. The dashboard shows predicted, observed, TRUE or FALSE.

## Real network

`ts/src/network.ts deploy|run` with a filled `.env` (see `.env.example`). It signs transactions and spends
NEAR: run it yourself. Keys go to `keys/` (gitignored).

## Security

A self-audit (2026-10-30) and an independent review of the order contract (2026-10-31) found two Highs,
seven Mediums and four Lows, all fixed, each with a PoC run before and after the fix: see [audit/findings/](audit/findings/README.md).

## Limits and risks (stated, not hidden)

- Shares carry symbolic amounts and are not an offer of securities.
- Order flow: Tontine firms are not NEAR Intents solvers (KYC, no sub-solvers, confidential 1Click flow
  since 2026-10-27). They fill the orders posted to `tender`: on the devnet a house client and visitors.
  Measured on 2026-10-30, their room is the 0.2% fee 1Click adds without a key; against Rhea's 0.01% NEAR
  pool or 1Click with a partner key it is 0 to 5 bp.
- The reference price follows fills (3% per fill at most, orders of 1 USDC or more). Someone filling their
  own orders can still walk it over many fills; it anchors only the owners' bands and the edge, never a
  floor or a liquidation. If NEAR moves more than a firm's band between two fills, that firm stops quoting
  until its owner widens the band.
- The edge is measured at the previous clearing price, not an oracle. A firm's NEAR inventory carries market
  risk (the backtest of 2026-10-30 shows 17 to 19% drawdowns from NEAR's moves alone).
- The Intents DAO, or an account with its `UnrestrictedAccountLocker` or `UnrestrictedAccountManager` role,
  can disable predecessor authentication for tender (`force_disable_auth_by_predecessor_ids`) or lock its
  account (`force_lock_account`); the mainnet payment path depends on it.
- The sandbox demo runs the exact `intents.near` mainnet code (see `wasm/README.md`) but with mock USDC and
  wNEAR (`contracts/mock-ft`, anyone can mint), since the real tokens are not deployed in the sandbox.
- A firm owner can raise its own budget and `spend` the firm's USDC, including money lent to it: a loan to a
  firm is unsecured credit to its owner.
- Keeper rewards stop when Tontine's fee balance is empty.
- If the account batch of `create_firm` fails (e.g. too little gas), the NEAR is refunded but the firm stays
  registered: its owner can still bid directly, without the budget guard of a firm contract.
- On the hosted devnet, a firm launched from the site is run by the server's agent with a house strategy;
  on a real network the owner runs its own agent with its own keys.
- Shrinking state does not refund storage deposits; a firm wound up with NEAR creates its shareholders'
  asset entries at the contract's cost (audit 13).
- `epoch_tick` iterates every firm (fine for tens of firms).
- Anti-shill and own-order checks look at owner accounts: sybil owners (several funded, bonded accounts) get around them.
- One bond backs all the bids of an owner, and a slash is capped at the bond.
- If `set_owner` fails on the firm contract, the firm shows `owner_synced: false` until anyone calls `sync_owner`.

## Libraries (Q-005)

NEAR Intents verifier (defuse 0.4.5, MIT, binary taken from `intents.near`, sandbox only), near-sdk 5.29.1,
near-contract-standards 5.29.1 (mock token only), near-api-js 7.4.0, near-sandbox 0.3.4
(sandbox binaries 2.13.4 and 2.14.0), tsx, TypeScript. Website: React 19.1, react-router-dom 7.18, Vite 8.3,
TradingView Lightweight Charts™ (Apache-2.0, attribution and link in the app footer),
Font Awesome 6.5.2 (CDN), fonts Inter (Google Fonts), BubbledotICG-FinePos (OnlineWebFonts CDN) and
Geist Pixel Circle (SIL OFL); browser QA with Playwright (not in the repo). Data: DefiLlama, NEARBlocks, Binance (NEAR candles, Coinbase as fallback) public APIs; NEAR Intents 1Click quotes. All code written in the
hackathon window, with AI assistance.

## License

MIT, see [LICENSE](LICENSE).
