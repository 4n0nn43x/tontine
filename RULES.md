# RULES

The rules of the Tontine market, as `contracts/tender` enforces them. `ts/src/rules.ts` mirrors them for the
swarm (a bid is checked before it is revealed) and for the simulation (`make sim`); `rules.test.ts` uses the
contract's own test vectors.

## Who

- **Client**: swaps USDC for NEAR (a buy) or NEAR for USDC (a sell) through NEAR Intents.
- **Firm**: an AI market maker on its own account `wN.<tender>` with 100 shares, a USDC treasury, a wNEAR
  inventory and an owner who posts a bond. Its agent holds two function call keys: one bids on tender, one
  spends from the firm's budget (inference). No key can attach a deposit, so no agent key moves money out.
- **Owner**: bonds 5 USDC or more to let its firms bid, sets their policy, may close them.
- **Shareholder**: holds shares; receives 30% of each fill's edge, the cash of a wound-up firm and its NEAR.
- **Keeper**: anyone who settles an auction or ticks an epoch; paid 0.02 USDC from Tontine's fees when they cover it.

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
    F->>T: commit_bid(sha256("amount:salt")) during the commit phase
    F->>T: reveal_bid(amount, salt): policy checked, amount escrowed from the firm
    F->>T: settle (anyone, after the reveal phase)
    T->>C: the second-best amount (or min_out if alone), in the same transaction
    T->>F: winner receives amount_in less the fee; 30% of its edge to its shareholders
```

1. **Post**: the client escrows `amount_in` and sets `min_out`, the least it accepts. The app sets it to the
   NEAR Intents 1Click quote, so a fill is never worse than 1Click. At least 1 USDC of notional (`min_order`);
   phases of 10 minutes at most. The reference price at posting time is stored with the order.
2. **Commit**: a firm commits `sha256("{amount}:{salt}")` of the amount it will deliver. Only solvent firms;
   one bid per owner (anti-shill) and per firm; never on its owner's own order; never while paused.
3. **Reveal**: the contract checks, in order: the amount is at least `min_out`; the firm is not liquidating
   or closed; the implied price is within the owner's band of the reference price stored with the order;
   a firm that owes lenders keeps that much cash; its NEAR share after a buy stays under its cap. Then it
   escrows the amount from the firm. A refused reveal is a bid not revealed.
4. **Settle** (anyone, after the reveal phase): with at least `min_bidders` revealed bids, the highest wins
   and delivers the second highest (or `min_out` if alone). The client receives it, the winner receives
   `amount_in` less Tontine's fee (`order_fee_bps`), losers get their escrow back. Fewer bids: everyone is
   refunded. A committed bid never revealed costs its owner's bond `no_reveal_slash_bps` of the notional (at
   least `slash`), paid to the client, unless the firm was put in liquidation or closed meanwhile.
5. **Edge and dividends**: the fill's edge is what the winner received minus what it delivered, valued at
   the previous clearing price. 30% of a positive edge goes to its shareholders at once (reward per share).
   The clearing price then becomes the reference, moving at most `max_move_bps` per fill.

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
- **Closing**: an owner closes its firm when it has no open bid: lenders first, then shareholders.
- **Loans**: anyone lends at least 1 USDC on the owner's terms (rate, cap), 20 open loans at most.

## Parameters (devnet)

| Parameter | Value |
| --- | --- |
| `order_fee_bps` | 2 (0.02% of what the winner receives) |
| `min_order` | 1 USDC |
| `min_bidders` | 2 |
| `max_move_bps` | 300 per fill |
| `no_reveal_slash_bps`, `slash` | 100 (1% of the order), at least 1 USDC |
| `treasury_floor`, epochs | 40 USDC, 3 epochs of 30 s |
| Default policy | band 10%, NEAR share 80% at most |
| `dividend_bps` | 3000 (30% of the edge) |
| `liquidation_fee_bps`, `trade_fee_bps` | 200, 50 |
