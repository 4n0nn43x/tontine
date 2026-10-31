# THESIS

"NEAR captures agent value through Intents-funded buybacks, not gas."

Figures below come from `data/snapshot.json` (fetched 2026-10-31, data through 2026-10-30) unless a line
says otherwise. Anyone can rebuild them.

## Rebuild

```sh
make thesis                           # thesis/index.html and thesis/result.json from data/snapshot.json
cd ts && npx tsx src/thesis.ts snapshot   # refetch the raw data (DefiLlama, NEARBlocks; public, no key)
```

The predictions are frozen in `thesis/predictions.json` (git tag `thesis-freeze`). Its sha256
`8970fc636d1e001603ae47fab9ef3c702f55145270fbba5c65ffe63cf22351d2` was published on `social.near` by `nolwen.near` on 2026-10-31 at 14:54 UTC,
block 222435278, before the window opens: [transaction](https://nearblocks.io/txns/oZYiNufwTDWnzNHdfWNMrTNj14KiwpVXeDQi5K87bYM).
`cd ts && npx tsx src/publish-hash.ts verify nolwen.near` reads it back and compares. The verdict is read on
or after 2026-11-14 for the window 2026-11-01 to 2026-11-12.

## Evidence for

- Over the last 30 days, Intents revenue was $2.15M (65.6% of it to the buyback multisig, see 5 below)
  and NEAR L1 gas fees $0.19M: Intents brings in about 11 times what gas does.
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
2. **The scale is small.** Emission at the 2.5% maximum rate is about 2.73M NEAR a month ($12.0M at
   $4.41); Intents revenue covered 18% of it, the multisig's share about 12%. Intents volume would have to
   grow 5.5 times to match it.
3. **Agents are not measured.** No public series separates the Intents volume that agents drive; the
   figures measure Intents, not agents.
4. **Agent economies can leak value.** Value that agents settle among themselves pays no Intents fee: the
   Tontine swarm does it by design (P4 measures it).
5. **"Revenue" is not all buybacks.** DefiLlama's `revenue` (equal to `holdersRevenue`) for `near-intents`
   is the NEAR sent to three wallets: `buybacks.multisignature.near`, `fefundsadmin.sputnik-dao.near` (a
   front-end fund DAO) and `1csfundsadmin.sputnik-dao.near`. Over the 30 days to 2026-10-30 the buyback
   multisig received 65.6% of it (on-chain balance changes).

## What would change my mind

- **P3 is FALSE**: the take rate is under 4.0 bp from 2026-11-01 to 2026-11-12. The regime change was
  transient, and the thesis is rejected for now.
- **P6 is FALSE** (the balance of `buybacks.multisignature.near` falls by more than 1 NEAR in a day between
  2026-11-01 and 2026-11-13), or the multisig sends the bought NEAR back to the market later: the buybacks
  are treasury management, not value capture.
- **Stronger case**: the multisig's NEAR is burnt or locked, or emission drops toward 1.6%
  ([HSP-029](https://gov.near.org/t/42644), in vote since 2026-10-07), which brings the multiple to 3.5x.
