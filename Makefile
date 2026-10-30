# Tontine. `make demo` needs only Node 22 (prebuilt wasm in wasm/, checked by sha256).
WASM_TARGET := contracts/target/wasm32-unknown-unknown/release
# near-sdk 5.30 needs `--cfg near`, or contract panics lose their message (cargo-near sets it too).
RUSTFLAGS_WASM := --cfg near -C link-arg=-s
export TMPDIR := $(CURDIR)/ts/node_modules/.cache/tmp

.PHONY: build test demo verify-wasm deps thesis

deps:
	cd ts && npm ci
	mkdir -p $(TMPDIR)

build:
	cd contracts && RUSTFLAGS='$(RUSTFLAGS_WASM)' cargo build --target wasm32-unknown-unknown --release
	mkdir -p wasm && cp $(WASM_TARGET)/tender.wasm $(WASM_TARGET)/firm.wasm $(WASM_TARGET)/mock_ft.wasm wasm/
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
