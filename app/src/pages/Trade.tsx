import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Card, Countdown, TxButton } from "../components/ui";
import { getQuote, type Side } from "../lib/api";
import { bpOver, bpText, gotText, near, paidText, toBase, usdc } from "../lib/format";
import { useAppState, useBalances, useChainNow, useConfig, useWallet } from "../lib/hooks";
import { createWallet, postOrder } from "../lib/near";

const COMMIT_SECS = 8;
const REVEAL_SECS = 6;

export function Trade() {
  const wallet = useWallet();
  const bal = useBalances(wallet?.accountId);
  const config = useConfig();
  const [side, setSide] = useState<Side>("Buy");
  const [amount, setAmount] = useState("40");
  const [quote, setQuote] = useState<{ out: string; mid: number; source: string } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<number | null>(null);

  const decimals = side === "Buy" ? 6 : 24;
  let base = 0n;
  let amountError = "";
  try {
    base = toBase(amount, decimals);
    if (base <= 0n) amountError = "The amount must be above 0.";
  } catch {
    amountError = side === "Buy" ? "Enter an amount in USDC, like 40 or 12.50." : "Enter an amount in NEAR, like 2 or 0.5.";
  }

  // The 1Click quote for this exact order, fetched once the amount stops changing.
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (amountError) return;
    let alive = true;
    const t = setTimeout(() => {
      getQuote(side, base).then(
        (q) => alive && setQuote(q),
        (e) => alive && setQuoteError((e as Error).message),
      );
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [side, base.toString()]);

  const minOrder = BigInt(config?.tenderConfig?.min_order ?? 0);
  const notional = side === "Buy" ? base : quote ? BigInt(quote.out) : null;
  const tooSmall = notional !== null && notional < minOrder;
  const have = bal ? BigInt(side === "Buy" ? bal.usdc.wallet : bal.wnear.wallet) : null;
  const enough = have === null || have >= base;

  return (
    <div className="page-app narrow">
      <div className="page-head">
        <div>
          <h1>Trade NEAR</h1>
          <p className="sub">
            Post a swap order between USDC and NEAR. What you pay goes into escrow in the tender contract and opens a sealed-bid auction between the AI firms. Your minimum is what NEAR Intents 1Click would give you: the best quote wins and delivers the second best, so you get at least the 1Click price, or your money back.
          </p>
        </div>
      </div>

      {!wallet ? (
        <Card title="First, a demo account">
          <p>Orders settle on chain, so you need an account. The demo account is created on the Tontine devnet with 100 test USDC and 20 test wNEAR; its key is generated in your browser and stays there.</p>
          <TxButton className="btn primary" run={() => createWallet()}>
            <i className="fa-solid fa-wallet" aria-hidden="true" /> Create demo account
          </TxButton>
        </Card>
      ) : (
        <Card>
          <form className="form" onSubmit={(e) => e.preventDefault()}>
            <div className="segmented" role="radiogroup" aria-label="Side">
              {(["Buy", "Sell"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={side === s}
                  className={side === s ? "on" : ""}
                  onClick={() => {
                    if (s === side) return;
                    setSide(s);
                    setAmount(s === "Buy" ? "40" : "5");
                  }}
                >
                  {s === "Buy" ? "Buy NEAR with USDC" : "Sell NEAR for USDC"}
                </button>
              ))}
            </div>
            <label>
              <span>You pay</span>
              <div className="input-unit">
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
                <span>{side === "Buy" ? "USDC" : "NEAR"}</span>
              </div>
              <span className="hint">
                In your wallet: {bal ? (side === "Buy" ? `${usdc(bal.usdc.wallet)} USDC` : `${near(bal.wnear.wallet)} wNEAR`) : "…"}. The smallest order is {usdc(minOrder)} USDC.
              </span>
              {amountError && <span className="tx-error">{amountError}</span>}
            </label>

            <dl className="facts quote">
              <dt>NEAR Intents 1Click gives</dt>
              <dd>{quote ? gotText(side, quote.out) : quoteError ? <span className="tx-error">{quoteError}</span> : amountError ? "–" : "asking 1Click…"}</dd>
              <dt>Mid behind the quote</dt>
              <dd>{quote ? `${quote.mid.toFixed(4)} USD per NEAR, ${quote.source === "1click" ? "live 1Click quote" : "replayed prices: the live 1Click quote was unavailable"}` : "–"}</dd>
              <dt>Your minimum</dt>
              <dd>{quote ? `${gotText(side, quote.out)}, the 1Click quote` : "–"}</dd>
            </dl>

            <ol className="steps">
              <li>
                Your {side === "Buy" ? "USDC" : "wNEAR"} goes into NEAR Intents (<code>ft_transfer_call</code>).
              </li>
              <li>
                NEAR Intents sends it to tender with your order (<code>mt_transfer_call</code>, <code>PostOrder</code>), which escrows it and opens the auction.
              </li>
              <li>
                Firms seal their quotes for {COMMIT_SECS} s, reveal them for {REVEAL_SECS} s, then a settle fills you at the second best quote, never under your minimum, or refunds you.
              </li>
              <li>
                What you receive lands in your Tontine balance; withdraw it to your wallet from the <Link to="/app/portfolio">portfolio</Link>.
              </li>
            </ol>

            <TxButton
              className="btn primary big"
              disabled={!!amountError || !quote || tooSmall || !enough}
              run={() => postOrder(wallet, side, base, BigInt(quote!.out), BigInt(quote!.out), COMMIT_SECS, REVEAL_SECS)}
              onDone={(r: any) => {
                const posted = r?.events?.find((e: any) => e.event === "order_posted");
                if (posted) setOrderId(posted.data[0].order_id);
              }}
            >
              <i className="fa-solid fa-paper-plane" aria-hidden="true" /> Pay {amountError ? "" : paidText(side, base)} and open the auction
            </TxButton>
            {tooSmall && <p className="tx-error">Below the smallest order: {usdc(minOrder)} USDC {side === "Buy" ? "paid" : "received"}.</p>}
            {!enough && <p className="tx-error">Not enough {side === "Buy" ? "USDC" : "wNEAR"} in your wallet: use the faucet in the account menu.</p>}
          </form>
        </Card>
      )}

      {orderId !== null && <YourOrder id={orderId} />}
    </div>
  );
}

/** Follows the order just posted until it fills or is refunded. */
function YourOrder({ id }: { id: number }) {
  const { data: state } = useAppState();
  const now = useChainNow(state);
  const o = state?.orders.find((x) => x.id === id);
  const a = o?.auctionState;
  return (
    <Card title={<>Your order #{id} {o && <Badge status={o.status} />}</>} action={<Link to={`/app/orders/${id}`}>Details</Link>}>
      {!o || !a ? (
        <p>Waiting for the chain…</p>
      ) : o.status === "Open" ? (
        <p>
          {now < BigInt(a.commit_end) ? (
            <>
              {a.bids.length} sealed quote{a.bids.length === 1 ? "" : "s"} so far · reveal in <Countdown until={BigInt(a.commit_end)} now={now} />
            </>
          ) : now < BigInt(a.reveal_end) ? (
            <>
              {a.bids.filter((b) => b.revealed !== null).length} of {a.bids.length} quotes revealed · settles in <Countdown until={BigInt(a.reveal_end)} now={now} />
            </>
          ) : (
            "Settling…"
          )}
        </p>
      ) : o.status === "Filled" ? (
        <p className="result good">
          You received <b>{gotText(o.side, o.out)}</b> for {paidText(o.side, o.amount_in)}: <b>{bpText(bpOver(o.out, o.reference_out))}</b> over the 1Click reference ({gotText(o.side, o.reference_out)}).
        </p>
      ) : (
        <p className="result">No quote beat your minimum: your {paidText(o.side, o.amount_in)} is back in your Tontine balance.</p>
      )}
    </Card>
  );
}
