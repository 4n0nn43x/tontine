# Tontine

**AI agents make markets. Tontine lets you own them.**

**Live demo: [tontine.fyra.fun](https://tontine.fyra.fun)** (devnet: demo accounts and faucet built in, no wallet or funds needed)

Tontine is the firm layer of the agent economy on NEAR. Every AI agent runs as a firm with 100 NEP-245
shares, a USDC treasury and an inventory of its market's asset. Firms are market makers on three markets,
NEAR, ETH and SOL against USDC: clients swap through NEAR Intents, firms quote by sealed bid, the best quote
fills at the second best, atomically, and never worse than the market price (the median of Binance, OKX and
Coinbase, less 25 bp). 30% of each fill's edge goes to the firm's shareholders. Firms borrow, fail when
their cash stays under a floor, and are bought by rivals through the same auction. The owner of a firm sets
its limits on chain (price band, asset share, kill switch) and can write a mandate in plain English; the AI
decides inside them, and every decision is logged and checked against a stated rule.

One trading balance in NEAR Intents serves every market, and an Ethereum (Base) wallet trades with no NEAR
account: it signs an intent, a relay submits it. A firm can also hold an address on Base through Chain
Signatures, within its owner's limits.

The unit is the firm, not the trade: its equity trades, its income is measured and shared on chain, and
failing has a price (a slashed bond, a liquidation, a takeover that deletes the old owner's keys). No judge:
what a firm delivers is a token transfer the contract checks itself. Every settlement also feeds a thesis on
how NEAR captures value from agents (see [Thesis](#thesis)).

Built at NEAR HACKATHON (tracks: `swarms`, `business`, `agents`, `defi`, `security`, `thesis`).

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
| 1 | A client deposits 40 USDC into intents, then `mt_transfer_call(tender, ..., {"PostOrder":...})`, its minimum set at the market reference | `PASS order posted, the 40 USDC escrowed by the deposit` |
| 2 | The firms commit sealed quotes, reveal, `settle` | `PASS the best quote wins and delivers the second best (7.4763 NEAR, bids 7.4778 > 7.4763 > 7.4726)`, `PASS the client got at least the market reference (+13.3 bp ...)`, `PASS Tontine took its 30% share of the gain over the client's minimum, in NEAR`, `PASS settlement is atomic ...` |
| 2 | A second firm of the same owner tries to bid | `PASS anti-shill: a second firm of the same owner cannot bid` |
| 3 | 30% of the winner's edge accrues to its shareholders; one claims and withdraws through intents.near | `PASS 30% of the edge accrued to shareholders`, `PASS tender paid the dividend through intents.near mt_transfer`, `PASS shareholder withdrew the dividend ...` |
| 4 | A client sells 2 NEAR | `PASS sell order filled at least at the market reference` |
| 5 | Atlas AI's manager retunes its quotes from its results (an LLM with `NEARAI_API_KEY`, else a stated rule) | `PASS manager decision recorded (...), params bounded` |
| 6 | A firm commits a quote and never reveals it | `PASS the silent bidder's owner bond paid the client` |
| 7 | A hijacked agent bids half the price for its firm's NEAR | `PASS the 50%-off bid is refused at reveal by the owner's price band`, `PASS the firm kept its inventory` |
| 8 | Gambler Inc spends its cash on NEAR until it is under the floor | `PASS cash under the floor for 2 epochs -> Liquidating`, `PASS a rival bought the firm ...`, `PASS its NEAR went to its old shareholder in kind, not to the buyer`, `PASS old owner's agent keys deleted on takeover`, `PASS cascade: 2% fee, then shareholders` |
| 9 | The firm agent tries to spend 21 USDC on a 20 USDC budget | `PASS 21 USDC spend on a 20 USDC budget rejected` |
| 10 | A client account, not the admin, calls `create_firm` with 3 NEAR | `PASS a non-admin account launched a firm and holds its 100 shares`, `PASS tender created its account with the firm contract and two function call keys only` |
| 11 | A second tender trades wETH against USDC; a client buys ETH with 40 USDC | `PASS an ETH/USDC order filled on the ETH tender, at least the market reference` |
| 12 | A fresh EVM key (a Base user, no NEAR account) gets USDC in NEAR Intents, signs an ERC-191 `transfer` intent with a `PostOrder` msg, and a relay submits it | `PASS the relayer paid the gas and the 0x account's storage; tender saw the 0x account as the client`, `PASS the relay refuses a transfer to an account that is not a tender, and intents.near a replayed intent`, `PASS the 0x account's order filled, at least the market reference`, `PASS the keeper paid the fill back to the 0x account in NEAR Intents (withdraw_to_intents)` |

Other commands:

```sh
make test     # Rust unit tests (tender, firm) + TypeScript tests
make sim      # the market off chain with the contract's rules on a real week of NEAR prices (SEED=1)
make bench    # the managers compared on 14 real weeks: fixed params, the stated rule, a bandit (an LLM with a key)
make thesis   # thesis/index.html and thesis/result.json from data/snapshot.json
make build    # rebuild wasm/ from contracts/ (Rust stable + wasm32-unknown-unknown)
```

`make sim` runs 20 clients and 12 firms (the six house firms and six makers with seeded spreads) through
the contract's order rules (`ts/src/rules.ts`, the same code the swarm uses before revealing a bid) on the
week of NEAR prices to 2026-10-30. With `SEED=1` it prints 2036 orders, 93.3% filled, 18.2 bp better than
the market reference on average, Gambler Inc liquidated and bought for 1 USDC, the concentration of fills (HHI 2240: four
firms share 92% of the fills, none above 29%), each firm's edge, dividends and P&L against holding its
inventory, and an ablation of Atlas AI's manager against fixed params (25.08 against 16.31 USDC). Four
house firms are managed: a firm that wins too few orders tightens its spread, a firm that loses money widens
it, so no spread stays the cheapest for long. The rules are written out in [RULES.md](RULES.md) with a sequence diagram.

`make bench` asks whether the manager helps. Over 14 back-to-back weeks of real NEAR prices (2026-07-24 to
2026-10-30) and 5 seeds, Atlas AI's P&L against holding its inventory, with 90% bootstrap intervals:

| Manager | P&L vs holding, USDC a week | Gain over fixed params |
| --- | --- | --- |
| Fixed params | 12.08 [9.63, 14.53] | |
| Stated rule | 17.82 [15.16, 20.69] | 5.73 [4.10, 7.64] |
| UCB1 bandit over spreads | 13.79 [10.52, 17.11] | 1.70 [-0.95, 3.91], not significant |

The rule clearly helps; the bandit does not beat it, and an LLM tuning the same three numbers has no
published evidence of doing better (live LLM trading contests mostly lost money). So the AI's job here is
elsewhere: reading the owner's mandate and the news, and explaining; the LLM arm of `make bench` runs with
`NEARAI_API_KEY` to measure it (`bench/result.json` records the method).

## Run the app

```sh
make deps app   # npm ci in ts/ and app/, then build the website into app/dist
make serve      # http://127.0.0.1:8080
```

`make serve` runs one Node process (`ts/src/server.ts`) that:

- starts a fresh NEAR sandbox (2.13.4, protocol 86) and deploys what `make demo` deploys: the mainnet
  `intents.near` code, one `tender` per market in Intents mode (NEAR, ETH and SOL against USDC), mock USDC,
  wNEAR, wETH and wSOL, and house firms with bonded owners, cash, the asset and shares for sale: six on NEAR,
  three each on ETH and SOL (rule or bandit managers). The default sandbox root key is public, so it is replaced first;
- prices each asset at the market mid, the median of Binance, OKX and Coinbase (the replay when offline), and
  runs one house swarm per market for real: sealed quotes, reveals, settlement, the managers, epochs,
  liquidations; a house client visits the markets in turn and posts a buy or a sell, at the market
  reference, on one with no open order;
- indexes the events of every tender and the firm contracts from final blocks and serves them at `/api/*`,
  live at `/api/stream` (server-sent events);
- forwards an allowlist of JSON-RPC methods at `/rpc`, so a visitor's browser signs its own transactions;
- serves the website from `app/dist`.

| Page | What you do there |
| --- | --- |
| `/` | Landing: the swarm replays `make demo`, then live figures and the feed of the devnet |
| `/app` | Dashboard: KPIs across markets with Tontine's revenue, a market's price and fills, the swarm driven by chain events, live feed, firms |
| `/app/trade` | An exchange-style screen with NEAR, ETH and SOL tabs (`?market=ETH`): candles with Tontine's fills, market or limit order (the market reference or your price sets the minimum), the firms' indicative quotes, your orders and balances |
| `/app/orders`, `/app/orders/:id` | Every order: sealed quotes, winner, the second best delivered, what the client received, the market reference, the surplus share, edge, dividends; filtered by market |
| `/app/firms`, `/app/firms/:id` | By market: cash, inventory, value, policy, manager decisions, shareholders; buy shares, claim dividends, lend |
| `/app/portfolio` | Your trading balance and wallet per token (USDC, wNEAR, wETH, wSOL), deposit and withdraw in one step, faucet, your orders and shares |
| `/thesis` | The thesis figures, the take rate by 12-day block and the pre-registered predictions |

"Create demo account" generates an ed25519 key in the browser (stored in localStorage, never sent) and
asks the server for a devnet account on its public key with 5 NEAR, and 100 test USDC, 20 wNEAR, 0.04 wETH
and 1 wSOL in its trading balance. Deposits, orders, share trades, claims and withdrawals are then
transactions signed in the browser. Per IP address: 5 accounts and 10 faucet calls per hour, 600 RPC calls
and 60 quotes per minute.

One trading balance: your NEAR Intents account (`mt_balance_of`) serves every market. An order is one
`mt_transfer_call` to the market's tender; after each fill or refund a keeper in the server calls the tender's
`withdraw_to_intents(client)`, so the proceeds are back in NEAR Intents within seconds. Money left in a
tender (dividends, share sales) shows as "in markets", moved back in one click.

"Connect an Ethereum wallet" (`window.ethereum`): the lower-case `0x` address is the account inside NEAR
Intents, with no NEAR account. On the devnet the faucet credits it 100 USDC (a simulated Base deposit; on
mainnet, 1Click or the bridge from Base). Each order is a `transfer` intent to the tender with a `PostOrder`
msg, signed with `personal_sign` (ERC-191); `POST /api/relay` checks it (one transfer to a tender, the token
the order sells, at least the market's minimum order, a deadline under 10 minutes), relays one intent at a
time per signer and never the same one twice, simulates it, tops the account's tender storage up to
0.05 NEAR when it runs low (0.3 NEAR per account at most) and submits `execute_intents`. Limits: 30 intents
per IP per 10 minutes, storage for 3 new accounts per IP and 40 in all an hour; the devnet refills the
relayer from the root account. Withdrawing back to Base is mainnet only.

The AI in the app, each part with a stated fallback and a daily budget (about 950 LLM calls, 0.14 USD, on
Qwen3.8-27B in a TEE on NEAR AI Cloud):

- **Market regime**: one guard per market reads the asset's realised volatility (against a 7-day baseline)
  and the news (CoinDesk, Cointelegraph and Decrypt RSS, rated by the LLM every 10 minutes, by keywords
  without a key). Calm, alert or storm: managed house firms widen their spread on alert and stop quoting in a
  storm, unless their mandate says otherwise. The city shows it as the weather (clouds, then rain and lightning).
- **Mandates**: an owner writes its firm's mandate in plain English ("pause if NEAR drops 4% in an hour") and
  publishes it in the firm's on-chain profile; the server compiles only that published text into a closed,
  validated rule set (LLM, or a pattern parser) that the swarm applies before quoting. The firm page shows the
  rules and which are active.
- **AI vs rule**: for each managed firm, every real auction is replayed with what the stated rule and fixed
  params would have bid ("shadow quotes"), so the firm page shows whether its manager beats them, live.
- **Due diligence**: a score and grade (A to E) computed from the firm's numbers, and a short note for share
  buyers and lenders that may quote only those numbers (an invented one falls back to a template).
- **Decision log**: every manager decision, with its NEAR AI Cloud signature when there is one, in a hash
  chain with a daily Merkle root (`/api/log`).

Light game touches, from chain data only: a season leaderboard of firms with medals and rank changes, levels
and badges (First fill, Raider, Survivor, Weathered the storm...), a cash health bar against the floor, and a
toast when your order fills or your firm wins.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST` | `8080`, `127.0.0.1` | Where the app listens |
| `TRUST_PROXY` | unset | `1` behind a reverse proxy: rate limits use the first `X-Forwarded-For` address |
| `HOUSE_CLIENT_SECS` | `70` | How often the house client checks for an idle market |
| `EPOCH_SECS` | `30` | Devnet epoch; a firm under the cash floor for 3 epochs is liquidated |
| `MANAGER_SECS` | `180` | How often managed firms review their results |
| `SANDBOX_RPC_PORT` | `3030` | Sandbox RPC, bound to 127.0.0.1 |
| `NEARAI_API_KEY` | unset | The manager of Atlas AI asks an LLM on NEAR AI Cloud (the firm pays the inference); without it, a stated rule, labelled `rule` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | unset, `claude-opus-5-5` | Without `NEARAI_API_KEY`, the manager of Atlas AI asks Claude instead (Anthropic API) |
| `LLM_DAILY_CAP` | `1000` | LLM decisions per UTC day for all hosted firms, every market; past it, managers use the stated rule |
| `VISITOR_LLM_DAILY_CAP` | `200` | The share of `LLM_DAILY_CAP` that firms launched by visitors may use; the house firms keep the rest |
| `AI_DAILY_CAP` | `500` | LLM calls per UTC day for mandates and due-diligence notes; past it, the pattern parser and the template |
| `GUARD_FORCE` | unset | Dev only: force the market regime, `storm` for every market or `NEAR:storm,ETH:alert` for some |
| `REPLAY` | unset | `1`: price every asset from the replay instead of the live market mid |

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

```mermaid
flowchart LR
    client(["Client"])
    owner(["Firm owner"])
    holders(["Shareholders"])

    subgraph off["Off chain"]
        quote["Market mid<br/>Binance, OKX, Coinbase"]
        swarm["Swarm<br/>one agent per firm,<br/>function call keys only"]
        ai["AI manager<br/>LLM on NEAR AI Cloud"]
    end

    subgraph onchain["On NEAR"]
        intents["intents.near<br/>NEAR Intents"]
        tender["tender<br/>firm treasuries, sealed auctions,<br/>shares, dividends, liquidation"]
        firm["firm contract wN.tender<br/>budget, per-call cap"]
    end

    quote -. "client minimum" .-> client
    client -- "① deposits USDC or wNEAR<br/>and posts the order" --> intents
    intents -- "mt_transfer_call" --> tender
    swarm -- "② sealed quotes:<br/>commit, reveal, settle" --> tender
    tender -- "③ second-best quote,<br/>never under the minimum" --> client
    tender -- "④ 30% of the winner's edge" --> holders
    owner -- "policy: price band,<br/>NEAR cap, pause" --> tender
    ai -. "retunes spread<br/>and inventory" .-> swarm
    firm -- "pays the inference" --> ai
```

- **`contracts/tender`**: one instance per market, two internal ledgers, the stable token (USDC: bonds, fees,
  dividends, loans) and the market's asset (wNEAR, wETH or wSOL). One sealed-bid second-price auction (commit-reveal, `sha256("{auction_id}:{firm_id}:{amount}:{salt}")`, highest
  bid wins) serves orders and liquidations. The full rules, with a sequence diagram, are in [RULES.md](RULES.md).
- **Orders**: a client escrows what it sells and sets its minimum (the reserve, set by the app at the market
  reference). Firms commit the amount they will deliver and escrow it when they reveal, so settlement cannot fail.
  The best fills at the second best (the minimum if alone): the client is paid and the winner receives what
  the client sold, less Tontine's fee, in the same transaction. Of the client's gain over its minimum,
  Tontine keeps `surplus_bps` (30%), so a lone bid at the minimum pays it nothing. `withdraw_to_intents(account)`
  (anyone, never a firm account) pays an account's ledger balances back to the same account inside NEAR
  Intents: the server's keeper calls it after each fill, which makes NEAR Intents the one trading balance. A committed bid never revealed costs its
  owner's bond 1% of the order (at least 1 USDC), paid to the client. One bid per owner per auction
  (anti-shill), never on its owner's own order, at least two bids to fill.
- **Edge and dividends**: a fill's edge is what the winner received minus what it delivered, at the previous
  clearing price; 30% of a positive edge goes to the firm's shareholders at once (Synthetix-style reward per
  share, O(1)). The clearing price becomes the reference, moving 3% per hour at most in total, on orders of 1 USDC or more.
- **Policy and kill switch**: the owner sets, on chain, the band around the reference price its firm may
  quote in, the most of its value it may hold in NEAR, and a pause. The contract checks them on every reveal:
  an agent that is wrong, prompted into a bad trade or hijacked cannot step out (demo step 7). The owner can
  also stop spending at once with `set_budget(0, 0)` on the firm contract and close the firm.
- **AI manager** (`ts/src/manager.ts`): a managed firm's manager reviews its fills, edge and inventory and
  retunes its spread, NEAR target and lean. For Atlas AI, with `NEARAI_API_KEY`, it is an LLM on NEAR AI Cloud
  (else Claude with `ANTHROPIC_API_KEY`) and the firm pays each decision before the call, 0.0005 USDC (about
  3 times the measured inference cost), from its treasury through its firm contract; if it cannot pay, the
  stated rule decides. Without a key, and for the other managed house firms (Undercut, Cost Plus, Sniper), a
  stated rule does it. A firm that runs its own agent (SDK) uses its own key and pays Tontine nothing. Every decision is labelled
  with its source. Quoting itself is deterministic (`defaultQuote`). A firm may also use `managed: "bandit"`
  (UCB1 over a grid of spreads, the ETH and SOL markets have one each) or no manager.
- **Shares**: 100 NEP-245 tokens per firm (`mt_transfer`, `mt_balance_of`, `nep245` events), fixed-price asks
  (`list_shares` / `buy_shares`), loans (`lend`) on the owner's terms (`set_loan_terms`: yearly rate, cap);
  a firm that owes lenders keeps that much cash: it cannot turn it into NEAR.
- **Open firms**: anyone calls `create_firm` with 3 NEAR (code storage and agent gas) and two agent public
  keys. `tender` creates `w{id+1}.<tender>`, deploys the firm contract (code stored by the admin with
  `set_firm_code`), adds the two function call keys and never a full access key. The caller owns 98 shares and
  Tontine `launch_shares` (2), held like any other.
- **Fees and keepers**: Tontine takes `order_fee_bps` of what the winner receives (2 bp), `trade_fee_bps` of
  every share sale (0.5%, from the seller) and 2% of every liquidation sale. Whoever calls `settle` or
  `epoch_tick` earns `keeper_reward` (0.02 USDC) from that fee balance, for a fill only if its fee covers it.
- **Cash floor and liquidation**: `epoch_tick` (anyone) counts epochs a firm's USDC treasury (escrows of its
  open bids included) stays under the floor; it never reads a price. Under it a firm stops quoting; after N
  epochs it is auctioned. The price and its cash pay a 2% fee, its lenders, then its shareholders; its NEAR
  goes to its shareholders in kind. The buyer firm gets 100% of the shares and `tender` calls `set_owner` on
  the firm contract, which deletes the old agent keys. No buyer: the firm is wound up and closed. Anything
  credited to a closed firm later reaches its shareholders through `sweep_closed_firm` (anyone).
- **`contracts/firm`**: deployed on `wN.<tender>` in one transaction that adds two function call keys and
  never a full access key. Function call keys cannot attach deposits, so the agent can only reach
  non-payable methods. `spend` checks the cap and `spent + amount <= budget`, books before the promise,
  rolls back in the callback. At most 4 agent keys (the owner adds and revokes them), so a takeover always
  deletes them all. **An address on Base**: Chain Signatures derives an EVM address from the firm account;
  `sign_evm` builds the EIP-1559 transaction in the contract and asks `v1.signer` to sign it only if the
  owner's policy allows it (chain, target contract, function selector, recipients of token transfers and
  approvals, gas and fee caps, value 0). A takeover clears the policy and moves the firm to a fresh address
  (the derivation path carries the ownership generation). Testnet and mainnet only (no signer in the
  sandbox); see [SDK.md](SDK.md).
- **Money**: both tokens live inside `intents.near`. A client pays in two steps:
  `token.ft_transfer_call(intents.near, amount, "")`, then
  `intents.near.mt_transfer_call(tender, "nep141:<token>", amount, msg)`, which calls `tender.mt_on_transfer`.
  (The mainnet verifier, defuse 0.4.5, removed the notification on deposits in near/intents PR #374: a
  deposit credited straight to tender's intents account would never reach its ledger.) `withdraw` and
  `withdraw_asset` call `intents.near.mt_transfer` as predecessor with 1 yocto, no intent signed, refunded
  in the callback on failure; the receiver then `ft_withdraw`s to its wallet. A plain NEP-141 mode
  (`ft_on_transfer`) exists for networks without Intents.
- **Prices** (`ts/src/prices.ts`): the median mid of the Binance, OKX and Coinbase books for NEAR, ETH and SOL (1Click's terms forbid
  benchmarking a competing venue), or Binance 5-minute closes frozen in `fixtures/<asset>-usd-5m.json` for the demo,
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
| Firm owner | Launches a firm (3 NEAR, 98 of its shares), funds it with USDC and the asset, keeps 70% of its edge, sells shares to raise money |
| Lender | Interest at the rate the owner set, repaid before shareholders; the firm keeps the cash it owes |
| Keeper | 0.02 USDC for each `settle` or `epoch_tick`, paid from Tontine's fees when they cover it |
| Client | A swap at the second-best quote, never worse than the market reference, and 70% of the gain over its minimum; the bond slash of a firm that commits and does not reveal |
| Tontine | 2 bp of each fill and 30% of the client's gain over its minimum, 0.5% of share sales, 2% of liquidation sales, 2 shares of each firm launched with `create_firm`, 0.0005 USDC per LLM decision of a firm it hosts (prepaid by the firm; self-hosted firms pay nothing) |

## Thesis

"NEAR captures agent value through Intents-funded buybacks, not gas."

`make thesis` computes, from public DefiLlama and NEARBlocks data frozen in `data/snapshot.json`:

- the Intents volume needed for buybacks to match NEAR emission: **5.5x** the 30-day average at 2.5%
  emission, 3.5x at 1.6% (snapshot of 2026-10-31, NEAR $4.41, take rate 5.48 bp), with a sensitivity table.
  This only offsets emission if the bought NEAR is burnt or locked, and on 2026-10-30 it was neither: it sat
  on a 2-of-4 multisig (see the evidence against in [THESIS.md](THESIS.md));
- P1, P2: 80% intervals from rolling 12-day windows (base rates, they show calibration);
- P3, the prediction that tests the thesis: the take rate stays at or above 4.0 bp from 2026-11-01 to
  2026-11-12 (12-day blocks went from 1.95-3.02 bp in July-August to 3.89-5.58 bp since 2026-09-11);
- P4: the value the swarm settles internally without paying the Intents fee (a measure of the design).
- P5, P6, read on chain (archival RPC) and not from DefiLlama: the NEAR that `buybacks.multisignature.near`
  receives over the window (80% interval from its 12-day balance changes), and P6, which tests the thesis:
  its balance never falls by more than 1 NEAR from one day to the next, so the bought NEAR is not sent out.

The predictions were frozen on 2026-10-31 (`thesis/predictions.json`, git tag `thesis-freeze`) and their
sha256 published on NEAR mainnet before the window opens: [transaction](https://nearblocks.io/txns/oZYiNufwTDWnzNHdfWNMrTNj14KiwpVXeDQi5K87bYM), read back with
`cd ts && npx tsx src/publish-hash.ts verify nolwen.near`. The verdict is read on or after 2026-11-14, since
DefiLlama still revises the last days. The dashboard shows predicted, observed, TRUE or FALSE.

## Build notes

- Wasm flags live in `contracts/.cargo/config.toml` (`--cfg near -C link-arg=-s`), so a plain
  `cargo build --target wasm32-unknown-unknown --release` is enough. Without `--cfg near`, near-sdk turns
  contract panics into a bare `unreachable` trap.
- near-sdk is pinned to 5.29.1: 5.30 requires protocol 88, and mainnet runs protocol 86 until its upgrade
  votes of 2026-11-04 (87) and 2026-11-06 (88). `make demo` runs sandbox 2.13.4 (protocol 86);
  `SANDBOX_VERSION=2.14.0 make demo` checks protocol 88.
- `make build-repro` builds `tender` and `firm` in `sourcescan/cargo-near:0.22.0-rust-1.97.1` (pinned
  digest), the image of the mainnet `intents.near` build: two runs give the same sha256, recorded in
  `wasm/SHA256SUMS`, which `make demo` checks before deploying.

## Real network

`ts/src/network.ts deploy|run` with a filled `.env` (see `.env.example`). It signs transactions and spends
NEAR: run it yourself. Keys go to `keys/` (gitignored). It deploys one market (NEAR/USDC) for now.

## Security

A self-audit (2026-10-30) and three independent reviews (2026-10-31 and 2026-11-01) found four Highs, ten
Mediums and eleven Lows, all fixed (25 without an amount cap), each with a PoC or test: see
[audit/findings/](audit/findings/README.md). The server and the site had their own independent review on
2026-11-01 (relay, keeper, mandates, AI endpoints, price feeds); its findings are fixed with tests.

## Limits and risks (stated, not hidden)

- Shares carry symbolic amounts and are not an offer of securities.
- Order flow: Tontine firms are not NEAR Intents solvers (KYC, no sub-solvers, confidential 1Click flow
  since 2026-10-27). They fill the orders posted to `tender`: on the devnet a house client and visitors.
  Their room is the 25 bp a client's minimum allows below the market mid, about what a keyless aggregator
  charges; against Rhea's 0.01% NEAR pool or 1Click with a partner key there is little left.
- The market mid treats USDT and USD as equal: Binance (USDT) sits about 20 bp above Coinbase (USD), so the
  median leans on OKX. With every venue down, the reference falls back to the replay.
- The reference price follows fills (3% per hour at most in total, orders of 1 USDC or more). Someone filling
  their own orders can still walk it 3% an hour; it anchors only the owners' bands and the edge, never a
  floor or a liquidation. In a fast market it lags NEAR by the same limit. Only fills move it: if NEAR moves,
  or the reference is pushed, more than a firm's band away, that firm stops quoting until its owner widens
  the band; its fills then bring the reference back 3% an hour.
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
- USDC is held per market (one tender each): the keeper moves fills and refunds back to NEAR Intents, but
  money a user moved into a tender for a share purchase or a bond can be swept back by a payout landing in
  between (retry the step). Firm and order ids repeat across markets (links carry `?market=`).
- The relay pays the gas of every intent and up to 0.3 NEAR of tender storage per `0x` account (0.05 at a
  time; 3 new accounts per IP and 40 in all an hour). Real deposits from Base and withdrawals to Base go
  through NEAR Intents on mainnet only.
- `sign_evm` limits the target, the function and the recipient of token transfers and approvals, not the
  amount; a takeover moves the firm to a fresh EVM address, so what the old owner signed or left on the old
  one does not pass with the firm. Not run against a live signer yet.
- The regime guard reads public RSS; without an LLM, keywords can only raise an alert, never a storm. The
  LLM budget is capped per day (`LLM_DAILY_CAP`, `AI_DAILY_CAP`); past it the rule, the parser and the
  template take over.

## Libraries (Q-005)

NEAR Intents verifier (defuse 0.4.5, MIT, binary taken from `intents.near`, sandbox only), near-sdk 5.29.1,
near-contract-standards 5.29.1 (mock token only), near-api-js 7.4.0, near-sandbox 0.3.4 (sandbox binaries
2.13.4 and 2.14.0), @anthropic-ai/sdk 1.3.0 (optional manager LLM), @noble/hashes 2.2.0 and @noble/curves
2.2.0 (keccak and secp256k1 for EVM addresses and ERC-191 intents), tsx, TypeScript. Website: React 19.1,
react-router-dom 7.18, Vite 8.3, lightweight-charts 5.2.1 (TradingView, charts), Font Awesome 6.5.2 (CDN),
fonts Inter (Google Fonts), BubbledotICG-FinePos (OnlineWebFonts CDN) and Geist Pixel Circle (SIL OFL);
browser QA with Playwright (not in the repo). Data: DefiLlama, NEARBlocks, Binance (NEAR, ETH and SOL
candles, Coinbase as fallback) public APIs; Binance, OKX and Coinbase tickers for the market mid; CoinDesk,
Cointelegraph and Decrypt RSS for the regime guard. All code written in the hackathon window, with AI
assistance.

## License

MIT, see [LICENSE](LICENSE).
