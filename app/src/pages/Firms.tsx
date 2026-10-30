import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Card, Empty, EventFeed, Kpi, TxButton } from "../components/ui";
import { getConfig, type FirmState } from "../lib/api";
import { firmColor, short, toBase, usdc } from "../lib/format";
import { useAppState, useBalances, useEvents, useFirmName, useWallet } from "../lib/hooks";
import { depositToTender, tenderCall, view, type Wallet } from "../lib/near";

const STRATEGY_NOTES: Record<string, string> = {
  "Undercut & Co": "Bids 55% of every budget; buys rivals that have delivered before.",
  "Cost Plus Ltd": "Prices from the size of the brief, three times its estimated cost.",
  "Gambler Inc": "Underbids small jobs it cannot do and delivers nothing: it exists to be slashed and liquidated.",
  "Premium Partners": "Charges 85% of the budget; invests in firms in liquidation.",
  "Sniper Holdings": "Only large jobs, at 70%; buys any firm in liquidation at a quarter of its treasury.",
};

export function Firms() {
  const { data: state } = useAppState();
  return (
    <div className="page-app">
      <div className="page-head">
        <div>
          <h1>Firms</h1>
          <p className="sub">A firm is a NEAR account with a contract and no full access key. Its AI agent can bid and deliver, its budget is enforced on chain, and 100 NEP-245 shares split its dividends.</p>
        </div>
      </div>
      <div className="firm-grid">
        {state?.firms.map((f, i) => <FirmCard key={f.id} f={f} index={i} />) ?? <Empty>Loading…</Empty>}
      </div>
    </div>
  );
}

function FirmCard({ f, index }: { f: FirmState; index: number }) {
  const name = f.strategy?.name ?? `Firm #${f.id}`;
  return (
    <Link className="firm-card" to={`/app/firms/${f.id}`} style={{ ["--tint" as any]: firmColor(name, index) }}>
      <div className="firm-card-head">
        <span className="dot big" />
        <div>
          <h2>{name}</h2>
          <p>{STRATEGY_NOTES[name] ?? (f.strategy?.house ? "House strategy." : "Third-party strategy.")}</p>
        </div>
        <Badge status={f.status} />
      </div>
      <dl className="firm-figures">
        <dt>Treasury</dt>
        <dd>{usdc(f.treasury)}</dd>
        <dt>Revenue</dt>
        <dd>{usdc(f.revenue)}</dd>
        <dt>Dividends</dt>
        <dd>{usdc(f.dividends)}</dd>
        <dt>Delivered / rejected</dt>
        <dd>
          {f.delivered} / {f.rejected}
        </dd>
      </dl>
    </Link>
  );
}

/** Make sure the wallet has `need` USDC inside tender, depositing the difference first. */
async function ensureLedger(w: Wallet, need: bigint) {
  const c = await getConfig();
  const have = BigInt(await view<string>(c.tender, "balance_of", { account_id: w.accountId }));
  if (have < need) await depositToTender(w, need - have);
}

export function FirmDetail() {
  const id = Number(useParams().id);
  const { data: state } = useAppState();
  const firmName = useFirmName(state);
  const wallet = useWallet();
  const bal = useBalances(wallet?.accountId);
  const events = useEvents(400);
  const f = state?.firms.find((x) => x.id === id);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [asks, setAsks] = useState<Record<string, { amount: number; price_per_share: string; takeover: number } | null>>({});
  const [buyAmount, setBuyAmount] = useState("5");
  const [lendAmount, setLendAmount] = useState("5");

  const holdersKey = f ? f.holdings.map((h) => `${h.account}:${h.shares}`).join(",") : "";
  useEffect(() => {
    if (!f) return;
    let alive = true;
    (async () => {
      const c = await getConfig();
      const p: Record<string, string> = {};
      const a: Record<string, any> = {};
      for (const h of f.holdings) {
        p[h.account] = await view(c.tender, "pending_dividends", { firm_id: f.id, account_id: h.account });
        a[h.account] = await view(c.tender, "get_ask", { firm_id: f.id, seller: h.account });
      }
      if (alive) {
        setPending(p);
        setAsks(a);
      }
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, holdersKey, f?.acc_per_share, bal?.tender]);

  if (!f) return <div className="page-app"><Empty>Loading firm #{id}…</Empty></div>;
  const name = f.strategy?.name ?? `Firm #${f.id}`;
  const mine = f.holdings.find((h) => h.account === wallet?.accountId);
  const history = events.filter((e) => e.data?.firm_id === id || e.data?.winner === id || e.data?.buyer_firm_id === id || e.contract === f.account);
  const openAsks = f.holdings.filter((h) => asks[h.account] && asks[h.account]!.takeover === f.takeovers && asks[h.account]!.amount > 0);

  return (
    <div className="page-app">
      <div className="page-head">
        <div>
          <p className="crumbs">
            <Link to="/app/firms">Firms</Link> / {name}
          </p>
          <h1 className="firm-title" style={{ ["--tint" as any]: firmColor(name, id) }}>
            <span className="dot big" /> {name} <Badge status={f.status} />
          </h1>
          <p className="sub">{STRATEGY_NOTES[name] ?? "Third-party strategy."}</p>
        </div>
      </div>

      <div className="kpis">
        <Kpi label="Treasury" value={usdc(f.treasury)} unit="USDC" hint={f.status === "Solvent" ? "above the 2 USDC floor" : `${f.epochs_below_floor} epoch(s) under the floor`} />
        <Kpi label="Revenue" value={usdc(f.revenue)} unit="USDC" hint={`${f.delivered} job${f.delivered === 1 ? "" : "s"} delivered`} />
        <Kpi label="Dividends paid" value={usdc(f.dividends)} unit="USDC" hint="30% of each job" />
        <Kpi label="Slashed" value={usdc(f.slashed)} unit="USDC" hint={`${f.rejected} rejected`} />
        <Kpi label="Owner bond" value={usdc(f.ownerBond)} unit="USDC" hint="needs 5 to bid" />
        <Kpi label="Takeovers" value={f.takeovers} hint={f.takeovers ? "this firm changed hands" : "never sold"} />
      </div>

      <div className="grid-2">
        <Card title="Shareholders (NEP-245, 100 shares)">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Holder</th>
                  <th className="num">Shares</th>
                  <th className="num">Unclaimed dividends</th>
                  <th className="num">For sale</th>
                </tr>
              </thead>
              <tbody>
                {f.holdings.map((h) => (
                  <tr key={h.account} className={h.account === wallet?.accountId ? "me" : ""}>
                    <td>{h.account === wallet?.accountId ? "you" : short(h.account, 26)}</td>
                    <td className="num">{h.shares}</td>
                    <td className="num">{pending[h.account] !== undefined ? usdc(pending[h.account]) : "…"}</td>
                    <td className="num">{asks[h.account] && asks[h.account]!.takeover === f.takeovers ? `${asks[h.account]!.amount} at ${usdc(asks[h.account]!.price_per_share)}` : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="facts">
            <dt>Firm account</dt>
            <dd>{f.account}</dd>
            <dt>Owner</dt>
            <dd>{short(f.owner, 30)}</dd>
          </dl>
        </Card>

        <Card title="Invest">
          {!wallet ? (
            <Empty>Create a demo account (top right) to buy shares, claim dividends or lend.</Empty>
          ) : (
            <div className="actions">
              {mine && (
                <div className="action">
                  <h3 className="mini">Your position: {mine.shares} shares</h3>
                  <p>Unclaimed dividends: {pending[wallet.accountId] !== undefined ? usdc(pending[wallet.accountId]) : "…"} USDC.</p>
                  <TxButton className="btn primary" disabled={!pending[wallet.accountId] || pending[wallet.accountId] === "0"} run={() => tenderCall(wallet, "claim_dividends", { firm_id: f.id })}>
                    <i className="fa-solid fa-hand-holding-dollar" aria-hidden="true" /> Claim dividends
                  </TxButton>
                </div>
              )}
              {openAsks.length ? (
                openAsks
                  .filter((h) => h.account !== wallet.accountId)
                  .map((h) => {
                    const ask = asks[h.account]!;
                    let n = 0;
                    try {
                      n = Math.max(0, Math.min(ask.amount, Math.floor(Number(buyAmount))));
                    } catch {
                      n = 0;
                    }
                    const cost = BigInt(ask.price_per_share) * BigInt(n);
                    return (
                      <div className="action" key={h.account}>
                        <h3 className="mini">
                          Buy shares from {short(h.account)} ({ask.amount} at {usdc(ask.price_per_share)} USDC)
                        </h3>
                        <div className="inline">
                          <input inputMode="numeric" value={buyAmount} onChange={(e) => setBuyAmount(e.target.value)} aria-label="Shares to buy" />
                          <span>shares = {usdc(cost)} USDC</span>
                        </div>
                        <TxButton
                          className="btn primary"
                          disabled={n < 1 || f.status === "Liquidating"}
                          run={async () => {
                            await ensureLedger(wallet, cost);
                            return tenderCall(wallet, "buy_shares", { firm_id: f.id, seller: h.account, amount: n });
                          }}
                        >
                          <i className="fa-solid fa-chart-pie" aria-hidden="true" /> Buy {n} shares
                        </TxButton>
                      </div>
                    );
                  })
              ) : (
                <p>No shares of {name} are for sale right now.</p>
              )}
              <div className="action">
                <h3 className="mini">Lend to {name}</h3>
                <p>The loan goes to the treasury. In a liquidation, creditors are repaid before shareholders; until then the owner can spend it: it is unsecured credit.</p>
                <div className="inline">
                  <input inputMode="decimal" value={lendAmount} onChange={(e) => setLendAmount(e.target.value)} aria-label="USDC to lend" />
                  <span>USDC</span>
                </div>
                <TxButton
                  className="btn"
                  disabled={f.status === "Liquidating"}
                  run={async () => {
                    const amount = toBase(lendAmount);
                    await ensureLedger(wallet, amount);
                    return tenderCall(wallet, "lend", { firm_id: f.id, amount: amount.toString() });
                  }}
                >
                  <i className="fa-solid fa-building-columns" aria-hidden="true" /> Lend
                </TxButton>
              </div>
            </div>
          )}
        </Card>
      </div>

      <Card title="History">
        <EventFeed events={history} firm={firmName} limit={50} />
      </Card>
    </div>
  );
}
