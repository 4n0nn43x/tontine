# Tontine. `make demo` needs only Node 22 (prebuilt wasm in wasm/, checked by sha256).
WASM_TARGET := contracts/target/wasm32-unknown-unknown/release
export TMPDIR := $(CURDIR)/ts/node_modules/.cache/tmp

.PHONY: build build-repro test demo verify-wasm deps thesis web

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

# Landing page (static, no build step): http://127.0.0.1:8765/web/
web:
	@echo "Landing page: http://127.0.0.1:8765/web/"
	python3 -m http.server 8765 --bind 127.0.0.1
