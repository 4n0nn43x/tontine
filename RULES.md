# RULES

The rules of the Tontine market, as `contracts/tender` enforces them. `ts/src/rules.ts` mirrors them for the
swarm (a bid is checked before it is revealed) and for the simulation (`make sim`); `rules.test.ts` uses the
contract's own test vectors.

## Who

- **Client**: swaps USDC for NEAR (a buy) or NEAR for USDC (a sell) through NEAR Intents. A client from
  another chain, with an implicit account inside intents.near (`0x...` or 64 hex, from its wallet's key)
  and no NEAR key, is paid back by `withdraw_to_intents(account_id)`: anyone (a relayer) moves that account's
  whole USDC and NEAR balances in tender to the same account inside intents.near (Intents mode only, about
  60 TGas). There is no receiver parameter, so it only pays an account its own money; firm accounts are
  refused.
- **Firm**: an AI market maker on its own account `wN.<tender>` with 100 shares, a USDC treasury, a wNEAR
  inventory and an owner who posts a bond. Its agent holds two function call keys: one bids on tender, one
  calls the firm contract (`spend` from the firm's budget for inference, `sign_evm`). No key can attach a deposit, so on NEAR an agent key moves money only through `spend`, under the owner's
  budget; on EVM chains only through `sign_evm`, to targets, functions and token recipients the owner listed.
  The owner can add keys with `add_agent_key` and revoke them with `remove_agent_key`, up to 4 at a time, so
  a takeover deletes them all in one call.
- **Owner**: bonds 5 USDC or more to let its firms bid, sets their policy, may close them.
- **Shareholder**: holds shares; receives 30% of each fill's edge, the cash of a wound-up firm and its NEAR.
- **Keeper**: anyone who settles an auction or ticks an epoch; paid 0.02 USDC from Tontine's fees when they
  cover it (a fill pays it only if its fee, valued in USDC at the last price, covers the reward).

## An order

```mermaid
sequenceDiagram
    participant C as Client
    participant I as intents.near
    participant T as tender
    participant F as Firms (agents)
    C->>I: ft_transfer_call (deposit USDC or wNEAR)
    C->>I: mt_transfer_call(tender, msg PostOrder{side, amount_in, min_out})
    I->>T: mt_on_transfer: escrow amount_in, open a sealed auction (reserve = min_out)
    F->>T: commit_bid(sha256("auction:firm:amount:salt")) during the commit phase
    F->>T: reveal_bid(amount, salt): policy checked, amount escrowed from the firm
    F->>T: settle (anyone, after the reveal phase)
    T->>C: the second-best amount (or min_out if alone) less the surplus share, in the same transaction
    T->>F: winner receives amount_in less the fee; 30% of its edge to its shareholders
```

1. **Post**: the client escrows `amount_in` and sets `min_out`, the least it accepts. The app sets it to the
   market reference: the median mid of Binance, OKX and Coinbase, less 25 bp. At least 1 USDC of notional (`min_order`);
   phases of 10 minutes at most. The reference price at posting time is stored with the order.
2. **Commit**: a firm commits `sha256("{auction_id}:{firm_id}:{amount}:{salt}")` of the amount it will deliver. Only solvent firms;
   one bid per owner (anti-shill) and per firm; never on its owner's own order; never while paused.
3. **Reveal**: the contract checks, in order: the amount is at least `min_out`; the firm is not liquidating
   or closed; the implied price is within the owner's band of the reference price stored with the order;
   a firm that owes lenders keeps that much cash; its NEAR share after a buy stays under its cap. Then it
   escrows the amount from the firm. A refused reveal is a bid not revealed.
4. **Settle** (anyone, after the reveal phase): with at least `min_bidders` revealed bids, the highest wins
   and delivers the second highest (or `min_out` if alone). The client receives it less Tontine's surplus
   share: `surplus_bps` of `out - min_out`, in the token the client receives, so never less than `min_out`
   (a lone bid leaves no surplus). The winner receives `amount_in` less Tontine's fee (`order_fee_bps`),
   losers get their escrow back. Fewer bids: everyone is refunded. A committed bid never revealed costs its
   owner's bond `no_reveal_slash_bps` of the notional (at least `slash`), paid to the client, unless the firm
   was put in liquidation, closed or taken over meanwhile.
5. **Edge and dividends**: the fill's edge is what the winner received minus what it delivered (the whole
   second price, surplus share included), valued at the previous clearing price. 30% of a positive edge goes to its shareholders at once (reward per share).
   The clearing price then becomes the reference, moving at most `max_move_bps` per hour in total, however
   many fills there are.

Why the second price: a firm's best strategy is to bid what the fill is worth to it; it keeps the gap to
the next best as margin. Why sealed: no firm sees the others' quotes before committing.

## Firms

- **Policy** (owner, on chain): price band around the reference price, maximum share of value in NEAR, pause
  (kill switch). An agent, or an AI manager, chooses its quotes inside these bounds and cannot step out.
- **Cash floor**: `epoch_tick` (anyone, once per epoch) counts a firm whose USDC treasury, escrows of its open
  bids included, is under `treasury_floor`. It never depends on a price. Under it, the firm stops quoting;
  after `epochs_before_liquidation` epochs it is put up for sale.
- **Liquidation**: the same sealed auction, highest bid wins at the second-highest price. The price and the
  firm's cash pay a 2% fee, then its lenders with interest, then its shareholders; its NEAR goes to its
  shareholders in kind. The buyer firm gets 100% of the shares and the owner field of the firm contract,
  whose old agent keys are deleted. No buyer: the firm is wound up the same way and closed.
- **Launch**: anyone creates a firm with `create_firm`; the creator gets 100 shares less `launch_shares`, which
  go to Tontine (`admin`), a shareholder like any other: dividends, liquidation and wind-up proceeds. House
  firms registered by the admin (`register_firm`) keep all 100 with their owner.
- **Closing**: an owner closes its firm when it has no open bid: lenders first, then shareholders. What
  reaches a closed firm's account later (NEAR from the wind-up of a firm it holds shares of, dividends) is
  paid out the same way by `sweep_closed_firm(firm_id)`, which anyone can call.
- **Loans**: anyone lends at least 1 USDC on the owner's terms (rate, cap), 20 open loans at most.

## Parameters (devnet)

| Parameter | Value |
| --- | --- |
| `order_fee_bps` | 2 (0.02% of what the winner receives) |
| `surplus_bps` | 3000 (30% of what the client gets over its `min_out`) |
| `launch_shares` | 2 (of the 100 shares of each firm launched with `create_firm`) |
| `min_order` | 1 USDC |
| `min_bidders` | 2 |
| `max_move_bps` | 300 per hour |
| `no_reveal_slash_bps`, `slash` | 100 (1% of the order), at least 1 USDC |
| `treasury_floor`, epochs | 40 USDC, 3 epochs of 30 s |
| Default policy | band 10%, NEAR share 80% at most |
| Markets | NEAR, ETH and SOL against USDC, one tender each, the same parameters |
| `dividend_bps` | 3000 (30% of the edge) |
| `liquidation_fee_bps`, `trade_fee_bps` | 200, 50 |

The surplus share and the order fee are Tontine's revenue, paid to `admin`; launch shares make Tontine a 2%
shareholder of every firm launched on it. Both are 0 in a config that omits them.
