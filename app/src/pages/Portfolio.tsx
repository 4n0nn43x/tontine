import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BalanceRows, MoveFunds } from "../components/Funds";
import { Badge, Card, Empty, FirmChip, TxButton } from "../components/ui";
import { nameOf, faucet, getConfig } from "../lib/api";
import { bpOver, bpText, gotText, near, paidText, toBase, usdc } from "../lib/format";
import { useAppState, useBalances, useWallet } from "../lib/hooks";
import { createWallet, tenderCall, view } from "../lib/near";

export function Portfolio() {
  const wallet = useWallet();
  const bal = useBalances(wallet?.accountId, 3000);
  const { data: state } = useAppState();
  const [pending, setPending] = useState<Record<number, string>>({});
  const [listAmount, setListAmount] = useState<Record<number, string>>({});
  const [listPrice, setListPrice] = useState<Record<number, string>>({});

  const positions = wallet && state ? state.firms.map((f) => ({ f, h: f.holdings.find((h) => h.account === wallet.accountId) })).filter((x) => x.h) : [];
  const posKey = positions.map((p) => `${p.f.id}:${p.h!.shares}:${p.f.acc_per_share}`).join(",");
  useEffect(() => {
    if (!wallet || !positions.length) return;
    let alive = true;
    (async () => {
      const c = await getConfig();
      const out: Record<number, string> = {};
      for (const p of positions) out[p.f.id] = await view(c.tender, "pending_dividends", { firm_id: p.f.id, account_id: wallet.accountId });
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
            <p className="sub">Your USDC and NEAR, your orders, your shares in AI firms and the dividends they pay you.</p>
          </div>
        </div>
        <Card title="No account yet">
          <p>Create a demo account on the Tontine devnet: 100 test USDC and 20 test wNEAR, a key generated in your browser, nothing to install.</p>
          <TxButton className="btn primary" run={() => createWallet()}>
            <i className="fa-solid fa-wallet" aria-hidden="true" /> Create demo account
          </TxButton>
        </Card>
      </div>
    );
  }

  const myOrders = state?.orders.filter((o) => o.client === wallet.accountId) ?? [];

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
          <BalanceRows bal={bal} />
          <p className="fine">
            Trading balance: held in the tender contract, withdraw any time. Gas: {bal ? near(bal.near, 2) : "…"} NEAR, storage prepaid: {bal ? near(bal.storage, 2) : "…"} NEAR.
          </p>
        </Card>

        <Card title="Deposit or withdraw">
          <MoveFunds wallet={wallet} bal={bal} />
          <div className="actions-row">
            <TxButton className="btn small" run={() => faucet(wallet.accountId)}>
              <i className="fa-solid fa-faucet-drip" aria-hidden="true" /> Get 100 USDC and 20 wNEAR
            </TxButton>
          </div>
        </Card>
      </div>

      <Card title="Your orders" action={<Link to="/app/trade">Trade NEAR</Link>}>
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
                  <th className="num">Vs 1Click</th>
                </tr>
              </thead>
              <tbody>
                {myOrders.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link to={`/app/orders/${o.id}`}>#{o.id}</Link>
                    </td>
                    <td>{o.side === "Buy" ? "Buy NEAR" : "Sell NEAR"}</td>
                    <td className="num">{paidText(o.side, o.amount_in)}</td>
                    <td>
                      <Badge status={o.status} />
                    </td>
                    <td className="num">{o.out ? gotText(o.side, o.out) : "–"}</td>
                    <td className="num">{bpText(bpOver(o.out, o.reference_out))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No order of yours among the latest {state?.orders.length ?? 0}.</Empty>
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
                {positions.map(({ f, h }, i) => (
                  <tr key={f.id}>
                    <td>
                      <FirmChip id={f.id} name={nameOf(f)} index={i} />
                    </td>
                    <td className="num">{h!.shares}</td>
                    <td className="num">{pending[f.id] !== undefined ? usdc(pending[f.id], 4) : "…"}</td>
                    <td>
                      <TxButton className="btn small" disabled={!pending[f.id] || pending[f.id] === "0"} run={() => tenderCall(wallet, "claim_dividends", { firm_id: f.id })}>
                        Claim
                      </TxButton>
                    </td>
                    <td>
                      <div className="inline small">
                        <input placeholder="shares" value={listAmount[f.id] ?? ""} onChange={(e) => setListAmount({ ...listAmount, [f.id]: e.target.value })} aria-label="Shares to list" />
                        <input placeholder="USDC each" value={listPrice[f.id] ?? ""} onChange={(e) => setListPrice({ ...listPrice, [f.id]: e.target.value })} aria-label="Price per share" />
                        <TxButton
                          className="btn small"
                          run={() => tenderCall(wallet, "list_shares", { firm_id: f.id, amount: Math.floor(Number(listAmount[f.id])), price_per_share: toBase(listPrice[f.id] ?? "0").toString() })}
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
