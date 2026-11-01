# Running and deploying Tontine

How the hosted app works and how to run it yourself. The product and the demo are in [README.md](README.md).

## Run the app

```sh
make deps app   # npm ci in ts/ and app/, then build the website into app/dist
make serve      # http://127.0.0.1:8080
```

`make serve` runs one Node process (`ts/src/server.ts`) that:

- starts a NEAR sandbox (2.13.4, protocol 86) and deploys what `make demo` deploys: the mainnet
  `intents.near` code, one `tender` per market in Intents mode (NEAR, ETH and SOL against USDC), mock USDC,
  wNEAR, wETH and wSOL, and house firms with bonded owners, cash, the asset and shares for sale: six on NEAR,
  three each on ETH and SOL (rule or bandit managers). The default sandbox root key is public, so it is
  replaced first;
- prices each asset at the market mid, the median of Binance, OKX and Coinbase (the replay when offline), and
  runs one house swarm per market for real: sealed quotes, reveals, settlement, the managers, epochs,
  liquidations; a house client visits the markets in turn and posts a buy or a sell, at the market
  reference, on one with no open order;
- keeps the house accounts funded: every `UPKEEP_SECS`, root tops up the gas, tender storage and bonds of the
  house client, firms and owners (`ts/src/upkeep.ts`);
- indexes the events of every tender and the firm contracts from final blocks and serves them at `/api/*`,
  live at `/api/stream` (server-sent events);
- forwards an allowlist of JSON-RPC methods at `/rpc`, so a visitor's browser signs its own transactions;
  transactions pass only as function calls to the devnet's contracts (intents, tokens, tenders, firms);
- serves the website from `app/dist`.

| Page | What you do there |
| --- | --- |
| `/` | Landing: the swarm replays `make demo`, then live figures and the feed of the devnet |
| `/app` | Dashboard: KPIs across markets with Tontine's revenue, a market's price and fills, live feed, firms, the testnet showcase |
| `/app/trade` | Exchange-style screen with NEAR, ETH and SOL tabs (`?market=ETH`): candles with Tontine's fills, market or limit order, the firms' indicative quotes, your orders and balances |
| `/app/orders`, `/app/orders/:id` | Every order: sealed quotes, winner, the second best delivered, what the client received, the market reference, the surplus share, edge, dividends |
| `/app/firms`, `/app/firms/:id` | By market: cash, inventory, value, policy, manager decisions, shareholders; buy shares, claim dividends, lend |
| `/app/portfolio` | Your trading balance and wallet per token, deposit and withdraw in one step, faucet, your orders and shares |
| `/city` | SEALED: the three markets as floating islands (three.js), one tower per firm; back the firm you think wins each sealed auction with play chips; `app/plaza-dev.html` is a dev-only harness of the scene (`npm run dev`, then `/plaza-dev.html`) |
| `/thesis` | The thesis figures, the take rate by 12-day block and the pre-registered predictions |

"Create demo account" generates an ed25519 key in the browser (stored in localStorage, never sent) and
asks the server for a devnet account on its public key with 5 NEAR, and 100 test USDC, 20 wNEAR, 0.04 wETH
and 1 wSOL in its trading balance. Deposits, orders, share trades, claims and withdrawals are then
transactions signed in the browser. Per IP address: 5 accounts and 10 faucet calls per hour, 600 RPC calls
and 60 quotes per minute, 8 live streams.

One trading balance: your NEAR Intents account (`mt_balance_of`) serves every market. An order is one
`mt_transfer_call` to the market's tender; after each fill or refund a keeper in the server calls the tender's
`withdraw_to_intents(client)`, so the proceeds are back in NEAR Intents within seconds. Money left in a
tender (dividends, share sales) shows as "in markets", moved back in one click.

"Connect a wallet": a wallet of another chain trades from an implicit account inside NEAR Intents, derived
from its key, with no NEAR account. intents.near verifies each wallet's own message standard:

| Wallet | Signs with | Account inside NEAR Intents |
| --- | --- | --- |
| EVM (MetaMask, Rabby, Coinbase Wallet; Base, Ethereum...) | `personal_sign`, ERC-191 | its lower-case `0x` address |
| Tron (TronLink) | `signMessageV2`, TIP-191 | the same `0x` form of its address |
| Solana (Phantom, Solflare, Backpack) | `signMessage`, raw Ed25519 | its public key in hex (64 characters) |
| TON (Tonkeeper, MyTonWallet extensions) | TonConnect `signData`, text | its public key in hex |
| Stellar (Freighter) | `signMessage`, SEP-53 | its public key in hex |
| Passkey (Face ID, Touch ID, Windows Hello) | WebAuthn, P-256 | `0x` + keccak256("p256" + key), 20 bytes |

A passkey is created on the site and its public key is kept in the browser (WebAuthn returns it only at
creation): forgetting it loses the account. On the devnet the faucet credits an account 100 USDC (a
simulated deposit; on mainnet, 1Click or the NEAR Intents bridge from its chain). Each order is a
`transfer` intent to the tender with a `PostOrder` msg, signed in the wallet; `POST /api/relay` checks it
(the envelope of its standard, the account form of its key, one transfer to a tender, the token the order
sells, at least the market's minimum order, a deadline under 10 minutes), relays one intent at a time per
signer and never the same one twice, simulates it, tops the account's tender storage up to 0.05 NEAR when it
runs low (0.3 NEAR per account at most) and submits `execute_intents`. Limits: 30 intents per IP per 10
minutes, storage for 3 new accounts per IP and 40 in all an hour; the devnet refills the relayer from the
root account. Withdrawing back to the wallet's chain is mainnet only.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST` | `8080`, `127.0.0.1` | Where the app listens |
| `TRUST_PROXY` | unset | `1` behind a reverse proxy: rate limits use the first `X-Forwarded-For` address |
| `HOUSE_CLIENT_SECS` | `25` | How often the house client checks for an idle market |
| `EPOCH_SECS` | `30` | Devnet epoch; a firm under the cash floor for 3 epochs is liquidated |
| `MANAGER_SECS` | `180` | How often managed firms review their results |
| `UPKEEP_SECS` | `300` | How often root tops up the house accounts' gas, tender storage and bonds |
| `SANDBOX_RPC_PORT` | `3030` | Sandbox RPC, bound to 127.0.0.1 |
| `DEVNET_DIR` | unset | A directory where the devnet survives restarts (see below); unset, every start is a new chain |
| `NODE_MAX_MB` | `900` | Past this resident memory, neard is restarted on the same chain (a few seconds without RPC) |
| `TESTNET_ACCOUNT`, `TESTNET_KEY` | unset | A funded testnet account and its key: the server also runs the testnet showcase (below) |
| `TESTNET_RPC`, `TESTNET_DIR` | FastNEAR testnet, `keys/` | Its RPC, and where it keeps the keys of the accounts it creates (`testnet.json`) |
| `SHOWCASE_ORDER_MIN` | `5` | Minutes between two house orders on testnet (each market in turn) |
| `NEARAI_API_KEY` | unset | The manager of Atlas AI asks an LLM on NEAR AI Cloud (the firm pays the inference); without it, a stated rule, labelled `rule` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | unset, `claude-opus-5-5` | Without `NEARAI_API_KEY`, the manager of Atlas AI asks Claude instead (Anthropic API) |
| `LLM_DAILY_CAP` | `1000` | LLM decisions per UTC day for all hosted firms, every market; past it, managers use the stated rule |
| `VISITOR_LLM_DAILY_CAP` | `200` | The share of `LLM_DAILY_CAP` that firms launched by visitors may use; the house firms keep the rest |
| `AI_DAILY_CAP` | `500` | LLM calls per UTC day for mandates and due-diligence notes; past it, the pattern parser and the template |
| `GUARD_FORCE` | unset | Dev only: force the market regime, `storm` for every market or `NEAR:storm,ETH:alert` for some |
| `REPLAY` | unset | `1`: price every asset from the replay instead of the live market mid |

### A devnet that lasts

By default the devnet lives in the process: a restart starts a new chain (orders and demo accounts start
over; the app drops a saved demo account that no longer exists). With `DEVNET_DIR` set, the chain survives
restarts and crashes: the node's data and the keys of the accounts the server signs with stay there, and the
server saves its own state every 30 s and on shutdown (the indexed events and totals, the firms' params and
decisions, the decision log, the visitors' firms with their agent keys). The next start resumes in a few
seconds; the indexer reads again the blocks after the last save, so no event is lost.

- A new chain starts when the contracts or the setup changed (no state migration). A resume that fails exits
  without deleting anything, so the service manager starts it again; the third failure in a row starts a new
  chain.
- A stop (SIGTERM) or a restart of neard first lets the running auctions reveal and settle (about 15 s), so
  no sealed bid is left unrevealed and no owner is slashed: give the process 45 s to stop.
- A watchdog exits when the node stops answering or stops making blocks for 2 minutes, so the service
  manager restarts the whole process.
- Bandit statistics and shadow quotes start over; mandates are compiled again from the profiles on chain.

`make app-dev` runs the Vite dev server with hot reload against a running `make serve`.

### Testnet showcase

`ts/src/showcase.ts`. The devnet is a private chain: nobody outside can check its transactions, but it
answers in a second and has no rate limit, so visitors trade there. With `TESTNET_ACCOUNT` and
`TESTNET_KEY`, the server also runs the whole system on NEAR testnet, a public chain, under that account, at a
pace the free RPCs allow (about 8 requests a second, measured): our copy of the intents.near mainnet code
(NEAR Intents is not deployed on testnet), mock USDC, wNEAR, wETH and wSOL, the three tenders with the
devnet's twelve house firms and their managers, and a house order every 5 minutes on each market in turn,
auctioned by the same swarm. Once each, it proves on that public chain what the sandbox cannot or only
simulates: the MPC network (`v1.signer-prod.testnet`) signs a Base Sepolia USDC transfer for a firm through
`sign_evm`, within its owner's policy, and the signature recovers to the firm's derived address (signed, not
broadcast: the address holds no Base Sepolia ETH); and one order from each wallet standard (EVM, Tron,
Solana, Stellar, TON, passkey), signed by a fresh key, relayed with `execute_intents`, filled and paid back
with `withdraw_to_intents`. The dashboard shows it under "Live on NEAR testnet", with a nearblocks link for
every transaction.

The setup needs about 100 testnet NEAR (intents.near's code alone takes 13 of storage), then about 3 to 4 a
day of gas and storage, which the master tops up for the house accounts before each order (`upkeep.ts`). It
runs step by step, saves after each one and resumes where it stopped (out of NEAR, a restart). An order is
saved as soon as it is posted, and auctions left open by a restart are settled from the chain.

### Website details

The landing background is a pixel-art city at dusk (Canvas 2D, no WebGL) where every building is a firm. It
**replays the real `make demo` run** with its figures; on the dashboard the same city is driven by the
events of the devnet. With `prefers-reduced-motion` it renders one still frame. QA helpers on the landing:
`?t=24` jumps to second 24 of the replay, `&still` renders a single frame.

Shared links get a preview (X, Discord, Slack, Telegram...): crawlers do not run the app, so the server writes
each page's title, description and Open Graph tags into `index.html` (`ts/src/meta.ts`). An order or firm link
describes that order or firm from the chain. The image, `app/public/og.png`, is a still of the landing
(`/?t=24&still`).

## Deploy on a VPS

One small Linux server is enough (2 GB of RAM: the sandbox uses about 600 MB, the Node process about 170 MB)
with glibc 2.39 or newer (Ubuntu 24.04, Debian 13: neard 2.13.4 does not start on older ones). Node 22 must be
on the default `PATH` (`/usr/bin` or `/usr/local/bin`), for example from NodeSource; the first start downloads
the sandbox binary.

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
Environment=PORT=8080 HOST=127.0.0.1 TRUST_PROXY=1 DEVNET_DIR=/opt/tontine/devnet
ExecStart=/usr/bin/make serve
Restart=on-failure
RestartSec=5
TimeoutStopSec=45

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
127.0.0.1. To update: `git pull && make app && sudo systemctl restart tontine` (the chain resumes with
`DEVNET_DIR`). Without `DEVNET_DIR`, a clean stop deletes the devnet data; after a crash, remove the leftover
`ts/node_modules/.cache/tmp/near-sandbox-*` directories while the service is stopped (about 100 MB each).

## Build notes

- Wasm flags live in `contracts/.cargo/config.toml` (`--cfg near -C link-arg=-s`), so a plain
  `cargo build --target wasm32-unknown-unknown --release` is enough. Without `--cfg near`, near-sdk turns
  contract panics into a bare `unreachable` trap.
- near-sdk is pinned to 5.29.1, which builds for protocol 86 (5.30 requires protocol 88). `make demo` runs
  sandbox 2.13.4 (protocol 86); `SANDBOX_VERSION=2.14.0 make demo` checks protocol 88.
- `make build-repro` builds `tender` and `firm` in `sourcescan/cargo-near:0.22.0-rust-1.97.1` (pinned
  digest), the image of the mainnet `intents.near` build: two runs give the same sha256, recorded in
  `wasm/SHA256SUMS`, which `make demo` checks before deploying.

## Real network

`ts/src/network.ts deploy|run` with a filled `.env` (see `.env.example`). It signs transactions and spends
NEAR: run it yourself. Keys go to `keys/` (gitignored). It deploys the NEAR/USDC market only; the testnet
showcase above runs all three markets.
