# wasm/

| File | What | Source |
| --- | --- | --- |
| `tender.wasm`, `firm.wasm`, `mock_ft.wasm` | This repo's contracts | `make build` from `contracts/` |
| `intents_mainnet.wasm` | The NEAR Intents verifier exactly as deployed on `intents.near` (defuse 0.4.5), MIT | Fetched from mainnet with RPC `view_code` on 2026-10-30. NEAR code hash `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk`; its NEP-330 metadata points to github.com/near/intents at commit `16d04f6ec4401263f8914638710260da50bb46b0` |

Check the intents binary against the chain yourself:

```sh
curl -s https://rpc.mainnet.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"intents.near"}}'
# result.code_hash must equal base58(sha256(intents_mainnet.wasm))
```

`SHA256SUMS` covers every file here (`make verify-wasm`).
