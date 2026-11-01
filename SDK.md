# Tontine SDK: run your own firm

A firm is a NEAR account (`w<id+1>.<tender>`) with the firm contract, two agent keys and no full access
key. You own its 100 shares. It is a market maker: its agent (your process, on your machine) quotes the
NEAR/USDC orders posted to `tender`, by sealed bid, and earns keeper rewards. Tontine never holds your keys.

## 1. Launch the firm

On the site, **Firms > Launch your firm**, choose "I run my agent myself". The site generates the two agent
keys in your browser, calls `create_firm` with their public halves (3 NEAR), publishes your spec, bonds 5 USDC
and funds the firm, then downloads `firm-<id>.json`:

```json
{
  "rpc": "https://<host>/rpc",
  "tender": "tender.sandbox",
  "firm_id": 6,
  "account": "w7.tender.sandbox",
  "keys": { "tender": "ed25519:...", "firm": "ed25519:..." },
  "strategy": "firms/example.ts"
}
```

Without the site, call `create_firm(agent_keys, budget, max_per_call, epoch_secs)` yourself with 3 NEAR and
150 TGas attached, then `set_firm_profile`, `deposit_bond`, and fund the firm account with USDC and wNEAR
(a deposit through NEAR Intents with the message `{"Credit": "<firm account>"}`).

## 2. Write the strategy

```ts
import { defaultQuote, defineFirm } from "../src/sdk.ts";

export default defineFirm({
  spec: {
    name: "Example Maker",                        // 2 to 32 characters, shown everywhere
    description: "NEAR/USDC orders of 5 to 200 USDC, 9 bp from the mid.",   // up to 280 characters
    skills: ["NEAR/USDC"],                        // up to 10
    min_budget: 5,                                // USDC
    max_budget: 200,
  },
  // The default quote: the market mid (median of Binance, OKX, Coinbase), less `spreadBps`, leaning toward
  // `targetAssetShare` of value in the asset.
  params: { spreadBps: 9, targetAssetShare: 0.4, skewBps: 25 },
  // Optional: your own quote, the amount the firm delivers (NEAR for a buy, USDC for a sell), or null to pass.
  quote: (order, me, market, params) => defaultQuote(order, me, market, params),
  // Optional manager that retunes the params from the firm's results: true (an LLM on NEAR AI Cloud with
  // NEARAI_API_KEY, else the stated rule), "rule", or "bandit" (UCB1 over a grid of spreads). See `make bench`.
  managed: false,
});
```

`ts/firms/example.ts` is a complete example. Second-price auction: quote what a fill is worth to you, you
keep the gap to the next best. Before committing, the runner drops any quote the contract would refuse at
reveal (under the client's minimum, outside your band, over your NEAR cap, more than your balance): a
committed bid you do not reveal costs your bond 1% of the order (at least 1 USDC), paid to the client.

The spec is published on chain (`set_firm_profile`, JSON, 2000 bytes at most) and shown on the site.

## 3. Set its limits

The owner sets the firm's policy on chain, and the contract checks it on every bid: `set_policy(firm_id,
{ band_bps, max_asset_bps, paused })`, from the firm page or yourself. Defaults: bids within 10% of the
reference price, at most 80% of the firm's value in NEAR. `paused: true` stops all bidding (kill switch);
`set_budget(0, 0)` on the firm contract stops spending.

A mandate in plain English steers the agent inside those limits ("pause if NEAR drops 4% in an hour",
"never hold more than 50% in NEAR"). Publish it in the firm's profile as `"mandate": "..."` with
`set_firm_profile`; the hosted devnet compiles only that published text into a closed rule set and applies it
before quoting (the firm page shows the rules). In your own runner, `compileMandate` and `evaluateMandate` from
`ts/src/mandate.ts` do the same.

## 4. Run it

```sh
cd ts && npm ci
npx tsx src/agent.ts ../firm-6.json      # the strategy path in the file is relative to the file
```

The agent loops every 2 seconds:

| It sees | It does |
| --- | --- |
| An order in its commit phase | its quote; if not null, `commit_bid`, then `reveal_bid`, then `settle` (first one wins the keeper reward) |
| An order past its reveal phase, not settled | `settle` |
| Every 3 minutes, if `managed` | its manager reviews fills, edge and inventory and retunes the params, with your own `NEARAI_API_KEY` (you pay your inference; Tontine charges nothing) |
| An epoch that ended | `epoch_tick` (keeper reward) |

Add `"owner": { "account": "...", "key": "ed25519:..." }` to the file to let the agent republish the spec
when you change it. The agent never needs the owner key to quote. Takeover bids (buying a firm in
liquidation) are signed by the owner and are not part of the runner yet.

## 5. Earn, and stop

- The winner of an order receives what the client sold; 30% of the fill's edge goes to the shareholders (you first).
- Keep cash above the floor (40 USDC on the devnet): three epochs under it put the firm up for sale, and
  its NEAR goes to its shareholders in kind.
- To stop for good, `close_firm` from the firm page once it has no open bid: the cash pays the lenders, then
  the shareholders; the NEAR goes to the shareholders.
- After a liquidation the contract deletes your agent keys and gives the firm to its buyer; your share of the
  sale is already in your ledger balance. You can switch the agent off.

The SDK (`ts/src/sdk.ts`) also exports `defaultQuote`, `bidHash` and the types `Strategy`, `FirmSpec`,
`OrderView`, `FirmCtx`, `Market`, `Params`.

## 6. An EVM address for your firm (Chain Signatures)

The firm account controls an EVM key held by the NEAR MPC network: one address on every EVM chain, such as
Base (8453) and Base Sepolia (84532). Its derivation path (`evm_path()`: `evm-1`, then `evm-2` after a
takeover...) changes with each owner, so a buyer starts on a fresh address: transactions the old owner
signed cannot touch it, and what sits on the old address does not pass with the firm (bidders should not
price it in). Fund it with ETH for gas.

The owner sets, on the firm contract:

- `set_evm_policy({ chain_ids, targets: [{ to, selectors }], max_gas, max_fee_per_gas, recipients })`: the
  chains, the contracts (lower case `0x` + 40 hex) and their 4-byte selectors (`0x` + 8 hex) the agent may
  call, the gas and fee caps, and the addresses an ERC-20 `transfer`, `approve` or `transferFrom` may send to
  or approve (none listed: those calls are refused). At most 16 items per list. `set_evm_policy(null)` stops
  EVM signing. A takeover clears the policy.
- `set_signer("v1.signer-prod.testnet")` on testnet. The default is `v1.signer` (mainnet).

The agent, with its firm key, calls `sign_evm(tx)`: an EIP-1559 call with value 0, to a listed contract and
selector, under the caps. The contract hashes the transaction and asks the signer to sign it (about 5 s);
the result is the signature.

```ts
import { broadcast, deriveEvmAddress, signedTxHex, type EvmTx, type MpcSignature } from "../src/evm.ts";

const address = await deriveEvmAddress(provider, "v1.signer-prod.testnet", firm.account); // fund it
const tx: EvmTx = { chain_id: 84532, nonce, max_priority_fee_per_gas: "1000000", max_fee_per_gas: "100000000",
  gas_limit: 80000, to: usdc, data };                     // nonce: eth_getTransactionCount(address)
const { value: sig } = await call<MpcSignature>(agentFirm, firm.account, "sign_evm", { tx });
const hash = await broadcast("https://sepolia.base.org", signedTxHex(tx, sig));
```

A selector limits the call, not all of its arguments: token transfers and approvals must go to a listed
recipient, but the amount is not capped, and other calls are checked by target and selector only. A signed
transaction stays valid until its nonce is used; after a takeover it can only touch the old address.

Testnet or mainnet only: the sandbox and the devnet have no MPC signer, so `make demo` does not cover it.
The unit tests in `contracts/firm` check the policy, and the encoding against an ethereumjs vector and a real Base transaction.
