# THESIS

"NEAR captures agent value through Intents-funded buybacks, not gas."

Figures below come from `data/snapshot.json` (fetched 2026-10-30, data through 2026-10-29) unless a line
says otherwise. Anyone can rebuild them.

## Rebuild

```sh
make thesis                           # thesis/index.html and thesis/result.json from data/snapshot.json
cd ts && npx tsx src/thesis.ts snapshot   # refetch the raw data (DefiLlama, NEARBlocks; public, no key)
```

The predictions are frozen in `thesis/predictions.json`; its sha256 is published on `social.near` before
2026-11-01 (`npx tsx src/publish-hash.ts verify <account>` reads it back). The verdict is read on or after
2026-11-14 for the window 2026-11-01 to 2026-11-12.

## Evidence for

- Over the last 30 days, Intents fees allocated to NEAR buybacks were $2.16M and NEAR L1 gas fees $0.20M:
  buybacks are about 11 times what gas brings in.
- The protocol take rate changed regime: 12-day blocks went from 1.95-3.02 bp in July-August to
  3.89-5.58 bp since 2026-09-11 (`thesis/result.json`, `blocks`).

## Evidence against

1. **The bought NEAR is not burnt or locked.** On 2026-10-30, `buybacks.multisignature.near` held
   2,132,114 NEAR, none staked or locked, behind four function call keys limited to the multisig methods
   and 2 confirmations: two signers can move it. By the condition this thesis sets itself, the buybacks
   offset nothing yet. Check it:
   ```sh
   curl -s https://rpc.mainnet.fastnear.com -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"buybacks.multisignature.near"}}'
   ```
2. **The scale is small.** Emission at the 2.5% maximum rate is about 2.73M NEAR a month ($11.9M at
   $4.36); buybacks covered 18% of it. Intents volume would have to grow 5.4 times to match it.
3. **Agents are not measured.** No public series separates the Intents volume that agents drive; the
   figures measure Intents, not agents.
4. **Agent economies can leak value.** Value that agents settle among themselves pays no Intents fee: the
   Tontine swarm does it by design (P4 measures it).
5. **"Revenue" is a label.** DefiLlama's `revenue` (equal to `holdersRevenue`) for `near-intents` is the
   fee share allocated to buybacks, not observed purchases.

## What would change my mind

- **P3 is FALSE**: the take rate is under 4.0 bp from 2026-11-01 to 2026-11-12. The regime change was
  transient, and the thesis is rejected for now.
- **The multisig sells or sends the bought NEAR back to the market**: the buybacks are treasury
  management, not value capture.
- **Stronger case**: the multisig's NEAR is burnt or locked, or emission drops toward 1.6%
  ([HSP-029](https://gov.near.org/t/42644), in vote since 2026-10-07), which brings the multiple to 3.5x.
