import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BalanceRows, EvmFunds, InMarkets, MoveFunds } from "../components/Funds";
import { Badge, Card, Empty, FirmChip, TxButton } from "../components/ui";
import { nameOf, faucet, getConfig, marketBySymbol, SYMBOLS } from "../lib/api";
import { ASSETS, bpOver, bpText, gotText, near, paidText, toBase, usdc } from "../lib/format";
import { inMarket, useBalances, useStates, useWallet } from "../lib/hooks";
import { connectEthereum, createWallet, tenderCall, view } from "../lib/near";

export function Portfolio() {
  const wallet = useWallet();
  const bal = useBalances(wallet?.accountId);
  const states = useStates();
  const [pending, setPending] = useState<Record<string, string>>({});
  const [listAmount, setListAmount] = useState<Record<string, string>>({});
  const [listPrice, setListPrice] = useState<Record<string, string>>({});

  // Shares and orders in every market; firm and order ids repeat across markets, so keys carry the symbol.
  const positions = wallet ? SYMBOLS.flatMap((s) => (states[s]?.firms ?? []).map((f) => ({ s, f, h: f.holdings.find((h) => h.account === wallet.accountId), key: `${s}:${f.id}` })).filter((x) => x.h)) : [];
  const posKey = positions.map((p) => `${p.key}:${p.h!.shares}:${p.f.acc_per_share}`).join(",");
  useEffect(() => {
    if (!wallet || !positions.length) return;
    let alive = true;
    (async () => {
      const c = await getConfig();
      const out: Record<string, string> = {};
      for (const p of positions) out[p.key] = await view(marketBySymbol(c, p.s)!.tender, "pending_dividends", { firm_id: p.f.id, account_id: wallet.accountId });
      if (alive) setPending(out);
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [wallet?.accountId, posKey]);

  if (!wallet) {
    return (
      <div className="page-app narrow">
        <div className="page-head">
          <div>
            <h1>Portfolio</h1>
            <p className="sub">Your USDC, NEAR, ETH and SOL, your orders, your shares in AI firms and the dividends they pay you.</p>
          </div>
        </div>
        <Card title="No account yet">
          <p>Create a demo account on the Tontine devnet: test USDC, wNEAR, wETH and wSOL, a key generated in your browser, nothing to install.</p>
          <div className="actions-row">
            <TxButton className="btn primary" run={() => createWallet()}>
              <i className="fa-solid fa-wallet" aria-hidden="true" /> Create demo account
            </TxButton>
            <TxButton className="btn" run={() => connectEthereum()}>
              <i className="fa-brands fa-ethereum" aria-hidden="true" /> Connect an Ethereum wallet
            </TxButton>
          </div>
          <p className="fine">An Ethereum wallet trades from its 0x account in NEAR Intents: it signs each order, the relay pays the gas.</p>
        </Card>
      </div>
    );
  }

  const myOrders = SYMBOLS.flatMap((s) => (states[s]?.orders ?? []).filter((o) => o.client === wallet.accountId).map((o) => ({ o, s })));

  return (
    <div className="page-app">
      <div className="page-head">
        <div>
          <h1>Portfolio</h1>
          <p className="sub">{wallet.accountId}</p>
        </div>
      </div>

      <div className="grid-2">
        <Card title="Balances">
          <BalanceRows bal={bal} wallet={!wallet.evm} />
          <InMarkets wallet={wallet} bal={bal} />
          <p className="fine">
            {wallet.evm
              ? "Trading balance: your 0x account in NEAR Intents, used by every market."
              : `Trading balance: held in NEAR Intents, used by every market. Gas: ${bal ? near(bal.near, 2) : "…"} NEAR, storage prepaid: ${bal ? near(bal.storage, 2) : "…"} NEAR.`}
          </p>
        </Card>

        {wallet.evm ? (
          <Card title="Add funds">
            <EvmFunds wallet={wallet} />
          </Card>
        ) : (
          <Card title="Deposit or withdraw">
            <MoveFunds wallet={wallet} bal={bal} />
            <div className="actions-row">
              <TxButton className="btn small" run={() => faucet(wallet.accountId)}>
                <i className="fa-solid fa-faucet-drip" aria-hidden="true" /> Get test USDC, wNEAR, wETH and wSOL
              </TxButton>
            </div>
          </Card>
        )}
      </div>

      <Card title="Your orders" action={<Link to="/app/trade">Trade</Link>}>
        {myOrders.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Side</th>
                  <th className="num">Paid</th>
                  <th>Status</th>
                  <th className="num">Got</th>
                  <th className="num">Vs market</th>
                </tr>
              </thead>
              <tbody>
                {myOrders.map(({ o, s }) => (
                  <tr key={`${s}${o.id}`}>
                    <td>
                      <Link to={inMarket(`/app/orders/${o.id}`, s)}>#{o.id}</Link>
                    </td>
                    <td>{`${o.side} ${s}`}</td>
                    <td className="num">{paidText(o.side, o.amount_in, ASSETS[s])}</td>
                    <td>
                      <Badge status={o.status} />
                    </td>
                    <td className="num">{o.out ? gotText(o.side, o.out, ASSETS[s]) : "–"}</td>
                    <td className="num">{bpText(bpOver(o.out, o.reference_out))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No order of yours among the latest of each market.</Empty>
        )}
      </Card>

      <Card title="Your shares">
        {!positions.length ? (
          <Empty>
            No shares yet. Owners list some of their shares for sale: open a <Link to="/app/firms">firm</Link> to buy, then claim the dividends it pays.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Firm</th>
                  <th className="num">Shares</th>
                  <th className="num">Unclaimed</th>
                  <th />
                  <th>Sell</th>
                </tr>
              </thead>
              <tbody>
                {positions.map(({ s, f, h, key }, i) => (
                  <tr key={key}>
                    <td>
                      <span className="mk-tag">{s}</span>
                      <FirmChip id={f.id} name={nameOf(f)} index={i} market={s} />
                    </td>
                    <td className="num">{h!.shares}</td>
                    <td className="num">{pending[key] !== undefined ? usdc(pending[key], 4) : "…"}</td>
                    <td>
                      <TxButton className="btn small" disabled={!pending[key] || pending[key] === "0"} run={() => tenderCall(wallet, "claim_dividends", { firm_id: f.id }, s)}>
                        Claim
                      </TxButton>
                    </td>
                    <td>
                      <div className="inline small">
                        <input placeholder="shares" value={listAmount[key] ?? ""} onChange={(e) => setListAmount({ ...listAmount, [key]: e.target.value })} aria-label="Shares to list" />
                        <input placeholder="USDC each" value={listPrice[key] ?? ""} onChange={(e) => setListPrice({ ...listPrice, [key]: e.target.value })} aria-label="Price per share" />
                        <TxButton
                          className="btn small"
                          run={() => tenderCall(wallet, "list_shares", { firm_id: f.id, amount: Math.floor(Number(listAmount[key])), price_per_share: toBase(listPrice[key] ?? "0").toString() }, s)}
                        >
                          List
                        </TxButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
