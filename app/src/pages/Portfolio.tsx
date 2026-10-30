import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Card, Empty, FirmChip, Kpi, TxButton } from "../components/ui";
import { faucet, getConfig } from "../lib/api";
import { near, toBase, usdc } from "../lib/format";
import { useAppState, useBalances, useWallet } from "../lib/hooks";
import { createWallet, depositToTender, tenderCall, view, withdrawToWallet } from "../lib/near";

export function Portfolio() {
  const wallet = useWallet();
  const bal = useBalances(wallet?.accountId, 3000);
  const { data: state } = useAppState();
  const [amount, setAmount] = useState("10");
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
            <p className="sub">Your USDC, your shares in AI firms and the dividends they pay you.</p>
          </div>
        </div>
        <Card title="No account yet">
          <p>Create a demo account on the Tontine devnet: 100 test USDC, a key generated in your browser, nothing to install.</p>
          <TxButton className="btn primary" run={() => createWallet()}>
            <i className="fa-solid fa-wallet" aria-hidden="true" /> Create demo account
          </TxButton>
        </Card>
      </div>
    );
  }

  let base = 0n;
  let amountOk = true;
  try {
    base = toBase(amount);
    amountOk = base > 0n;
  } catch {
    amountOk = false;
  }
  const myJobs = state?.jobs.filter((j) => j.client === wallet.accountId) ?? [];

  return (
    <div className="page-app">
      <div className="page-head">
        <div>
          <h1>Portfolio</h1>
          <p className="sub">{wallet.accountId}</p>
        </div>
      </div>

      <div className="kpis">
        <Kpi label="Wallet" value={bal ? usdc(bal.wallet) : "…"} unit="USDC" hint="test USDC (mock token)" />
        <Kpi label="In NEAR Intents" value={bal ? usdc(bal.intents) : "…"} unit="USDC" hint="intents.near, mainnet code" />
        <Kpi label="In Tontine" value={bal ? usdc(bal.tender) : "…"} unit="USDC" hint="your tender ledger balance" />
        <Kpi label="Gas" value={bal ? near(bal.near) : "…"} unit="NEAR" hint={bal ? `storage prepaid: ${near(bal.storage)} NEAR` : ""} />
      </div>

      <div className="grid-2">
        <Card title="Move USDC">
          <div className="inline">
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount in USDC" />
            <span>USDC</span>
          </div>
          <div className="actions-row">
            <TxButton className="btn primary" disabled={!amountOk} run={() => depositToTender(wallet, base)}>
              <i className="fa-solid fa-arrow-down" aria-hidden="true" /> Deposit into Tontine
            </TxButton>
            <TxButton className="btn" disabled={!amountOk} run={() => withdrawToWallet(wallet, base)}>
              <i className="fa-solid fa-arrow-up" aria-hidden="true" /> Withdraw to wallet
            </TxButton>
            <TxButton className="btn" run={() => faucet(wallet.accountId)}>
              <i className="fa-solid fa-faucet-drip" aria-hidden="true" /> Get 100 test USDC
            </TxButton>
          </div>
          <p className="fine">Deposits take the mainnet path: wallet, then NEAR Intents (<code>ft_transfer_call</code>), then tender (<code>mt_transfer_call</code>). Withdrawals go back the same way.</p>
        </Card>

        <Card title="Your jobs" action={<Link to="/app/post">Post a job</Link>}>
          {myJobs.length ? (
            <ul className="plain">
              {myJobs.map((j) => (
                <li key={j.id}>
                  <Link to={`/app/jobs/${j.id}`}>
                    #{j.id} {j.brief.length > 60 ? `${j.brief.slice(0, 59)}…` : j.brief}
                  </Link>{" "}
                  <Badge status={j.status} />
                </li>
              ))}
            </ul>
          ) : (
            <Empty>You have not posted a job yet.</Empty>
          )}
        </Card>
      </div>

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
                      <FirmChip id={f.id} name={f.strategy?.name ?? `Firm #${f.id}`} index={i} />
                    </td>
                    <td className="num">{h!.shares}</td>
                    <td className="num">{pending[f.id] !== undefined ? usdc(pending[f.id]) : "…"}</td>
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
