# Tontine. `make demo` needs only Node 22 (prebuilt wasm in wasm/, checked by sha256).
WASM_TARGET := contracts/target/wasm32-unknown-unknown/release
export TMPDIR := $(CURDIR)/ts/node_modules/.cache/tmp

.PHONY: build build-repro test demo sim bench verify-wasm deps thesis app app-dev serve

deps:
	cd ts && npm ci
	mkdir -p $(TMPDIR)

build:
	cd contracts && cargo build --target wasm32-unknown-unknown --release
	mkdir -p wasm && cp $(WASM_TARGET)/tender.wasm $(WASM_TARGET)/firm.wasm $(WASM_TARGET)/mock_ft.wasm wasm/
	cd wasm && sha256sum *.wasm > SHA256SUMS

# Reproducible build of the mainnet contracts in the pinned cargo-near image (needs Docker, a clean git
# tree and `repository` set in contracts/{tender,firm}/Cargo.toml). Same image as the intents.near build.
build-repro:
	cd contracts/tender && cargo near build reproducible-wasm
	cd contracts/firm && cargo near build reproducible-wasm
	cp contracts/target/near/tender/tender.wasm contracts/target/near/firm/firm.wasm wasm/
	cd wasm && sha256sum *.wasm > SHA256SUMS

verify-wasm:
	cd wasm && sha256sum -c SHA256SUMS

test:
	cd contracts && cargo test
	cd ts && npx tsc --noEmit && npm test

demo: verify-wasm
	@test -d ts/node_modules || $(MAKE) deps
	mkdir -p $(TMPDIR)
	cd ts && npx tsx src/demo.ts

thesis:
	cd ts && npx tsx src/thesis.ts

# The swarm's market off chain, with the contract's rules, on NEAR's real price path (RULES.md).
SEED ?= 1
sim:
	@test -d ts/node_modules || $(MAKE) deps
	cd ts && SEED=$(SEED) npx tsx src/sim.ts

# Atlas AI's manager against fixed params, the rule and a UCB1 bandit (and the LLM with a key), over weekly
# windows and seeds; writes bench/result.json.
bench:
	@test -d ts/node_modules || $(MAKE) deps
	cd ts && SEED=$(SEED) npx tsx src/bench.ts

# The website (Vite + React), built into app/dist.
app:
	cd app && npm ci && npm run build

# The hosted app on one port (PORT=8080, HOST=127.0.0.1): a fresh NEAR devnet with the contracts, the
# house swarm and client, the chain indexer, the API and the website. See README "Run the app".
serve: verify-wasm
	@test -d ts/node_modules || $(MAKE) deps
	@test -f app/dist/index.html || $(MAKE) app
	mkdir -p $(TMPDIR)
	cd ts && npx tsx src/server.ts

# Vite dev server with hot reload, proxied to a running `make serve` (TONTINE_API, default http://127.0.0.1:8080).
app-dev:
	cd app && npm run dev
