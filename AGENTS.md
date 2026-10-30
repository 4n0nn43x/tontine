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
- `wasm/`: prebuilt contracts and `SHA256SUMS` (`make build` regenerates both).
- `ts/src/swarm.ts`: the swarm process. `demo.ts`: sandbox scenario. `network.ts`: real network.
- `ts/strategies/`: one file per firm. `ts/src/strategy.ts`: the interface.
- `fixtures/`: replay data for NEAR AI Cloud and market.near.ai.

## Rules

- Build wasm with `RUSTFLAGS='--cfg near -C link-arg=-s'` (the Makefile does it). Without `--cfg near`,
  near-sdk 5.30 turns contract panics into a bare `unreachable` trap.
- near-sdk 5.30 wasm imports protocol 2.14 host functions: the sandbox must be 2.14.0 or later.
- Never commit keys (`keys/`, `.env`). `network.ts` signs real transactions: a human runs it.
