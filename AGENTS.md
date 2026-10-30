# AGENTS.md

Notes for AI agents (and judges' screening agents) working on or reviewing this repository.

## Verify in 5 minutes

1. `make deps && make demo`: expect `ALL CHECKS PASS`, exit code 0. Needs Node 22 and network access once
   to download the sandbox binary; no keys, no funds.
2. `make test`: Rust unit tests for `contracts/tender` and `contracts/firm`, then TypeScript tests.
3. `make thesis`: rebuilds `thesis/index.html` from `data/snapshot.json`.
4. `make deps app serve`, then http://127.0.0.1:8080: the same contracts on a local devnet with the house
   swarm running, a dashboard, and a demo account to trade NEAR/USDC and buy shares from the browser.
5. `make sim`: the market off chain with the contract's rules on a real week of NEAR prices.

Every README claim maps to a test or a demo check in `CLAIMS.md`.

## Layout

- `contracts/tender/src/lib.rs`: two ledgers, auction, orders, policy, shares, dividends, liquidation. Tests in `tests.rs`. Rules in `RULES.md`.
- `contracts/firm/src/lib.rs`: budget guard of one firm (tests inline).
- `contracts/mock-ft`: sandbox-only USDC.
- `wasm/`: prebuilt contracts, the mainnet `intents.near` binary (provenance in `wasm/README.md`) and
  `SHA256SUMS`.
- `ts/src/swarm.ts`: the swarm process. `rules.ts`: the contract's order rules in TS. `strategy.ts`, `manager.ts`: quoting and the AI manager. `prices.ts`: 1Click and replayed prices. `sim.ts`: the off-chain market. `demo.ts`: sandbox scenario. `network.ts`: real network.
- `ts/src/server.ts`: the hosted app (devnet from `devnet.ts`, swarm loops, event indexer from `indexer.ts`,
  JSON API, RPC proxy, static website). `app/`: the website (Vite, React, Canvas 2D city).
- `ts/strategies/`: one file per firm. `ts/src/strategy.ts`: the interface.
- `fixtures/near-usd-5m.json`: NEAR 5-minute closes (Binance) for the demo, the simulation and offline runs.

## Rules

- Wasm flags live in `contracts/.cargo/config.toml` (`--cfg near -C link-arg=-s`), so a plain
  `cargo build --target wasm32-unknown-unknown --release` is enough. Without `--cfg near`, near-sdk turns
  contract panics into a bare `unreachable` trap.
- near-sdk is pinned to 5.29.1: 5.30 declares protocol 88 as its minimum and its wasm is refused by
  protocol 86, which mainnet runs until its upgrade votes of 2026-11-04 (87) and 2026-11-06 (88) (nearcore
  2.14.0, checked 2026-10-30). `make demo` runs sandbox 2.13.4 (protocol 86) for that reason;
  `SANDBOX_VERSION=2.14.0 make demo` checks protocol 88, which mainnet runs from about 2026-11-07.
- `make build-repro` builds tender and firm reproducibly in `sourcescan/cargo-near:0.22.0-rust-1.97.1`
  (pinned digest), the image the mainnet intents.near build used. Two runs give the same sha256, and
  the result passes `make demo` on protocol 86.
- Never commit keys (`keys/`, `.env`). `network.ts` signs real transactions: a human runs it.
