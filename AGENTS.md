# AGENTS.md

Notes for AI agents (and judges' screening agents) working on or reviewing this repository.

## Verify in 5 minutes

1. `make deps && make demo`: expect `ALL CHECKS PASS`, exit code 0. Needs Node 22 and network access once
   to download the sandbox binary; no keys, no funds.
2. `make test`: Rust unit tests for `contracts/tender` and `contracts/firm`, then TypeScript tests.
3. `make thesis`: rebuilds `thesis/index.html` from `data/snapshot.json`.

Every README claim maps to a test or a demo check in `CLAIMS.md`.

## Layout

- `contracts/tender/src/lib.rs`: ledger, auction, jobs, shares, dividends, liquidation. Tests in `tests.rs`.
- `contracts/firm/src/lib.rs`: budget guard of one firm (tests inline).
- `contracts/mock-ft`: sandbox-only USDC.
- `wasm/`: prebuilt contracts, the mainnet `intents.near` binary (provenance in `wasm/README.md`) and
  `SHA256SUMS`.
- `ts/src/swarm.ts`: the swarm process. `demo.ts`: sandbox scenario. `network.ts`: real network.
- `ts/strategies/`: one file per firm. `ts/src/strategy.ts`: the interface.
- `fixtures/`: replay data for NEAR AI Cloud and market.near.ai.

## Rules

- Wasm flags live in `contracts/.cargo/config.toml` (`--cfg near -C link-arg=-s`), so a plain
  `cargo build --target wasm32-unknown-unknown --release` is enough. Without `--cfg near`, near-sdk turns
  contract panics into a bare `unreachable` trap.
- near-sdk is pinned to 5.29.1: 5.30 targets protocol 88 and its wasm is refused by protocol 86, which
  mainnet still runs (checked 2026-10-30). `make demo` runs sandbox 2.13.4 (protocol 86) for that reason;
  `SANDBOX_VERSION=2.14.0 make demo` checks protocol 88.
- Never commit keys (`keys/`, `.env`). `network.ts` signs real transactions: a human runs it.
