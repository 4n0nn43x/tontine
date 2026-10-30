import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Badge, Card, Empty, EventFeed, Kpi, TxButton } from "../components/ui";
import { getConfig, requestAgent, specOf, type FirmState } from "../lib/api";
import { firmColor, short, toBase, usdc } from "../lib/format";
import { useAppState, useBalances, useConfig, useEvents, useFirmName, useWallet } from "../lib/hooks";
import { KeyPair } from "near-api-js";
import { ensureLedger, tenderCall, tx, view } from "../lib/near";

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
      <LaunchFirm />
      <div className="firm-grid">
        {state?.firms.map((f, i) => <FirmCard key={f.id} f={f} index={i} />) ?? <Empty>Loading…</Empty>}
      </div>
    </div>
  );
}

/** The firm contract's storage plus gas for its agent keys. */
const FIRM_NEAR = 3n * 10n ** 24n;

/** Anyone launches a firm: its own account and contract, 100 shares to the creator, an agent run by the devnet. */
/** Save a JSON file in the browser. */
function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Anyone launches a firm: its own account and contract, 100 shares to the creator, its spec on chain, and
 * an agent either run by this devnet or by the creator itself with keys that never leave the browser. */
function LaunchFirm() {
  const wallet = useWallet();
  const config = useConfig();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [skills, setSkills] = useState("translation, summaries");
  const [runner, setRunner] = useState<"devnet" | "self">("devnet");
  const [template, setTemplate] = useState(1);
  return (
    <Card title="Launch your firm">
      <div className="launch">
        <div>
          <p>
            Your firm gets its own NEAR account with no full access key, a contract that caps its spending, and 100 shares that you own: sell some to raise money, keep the rest for the dividends. Its spec (what it does, with
            which model) is published on chain. It costs 3 NEAR for the account and its agent's gas, a 5 USDC owner bond to bid and a 5 USDC starting treasury (the floor is 2 USDC). Tontine takes 1% of every job it wins.
          </p>
          <p>
            Run it yourself: write a strategy with the SDK (<code>defineFirm</code>), then <code>npx tsx src/agent.ts firm.json</code> with the file you download here. See <code>SDK.md</code> in the repository.
          </p>
        </div>
        {!wallet ? (
          <Empty>Create a demo account (top right) to launch a firm.</Empty>
        ) : (
          <div className="launch-form">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Firm name" maxLength={32} aria-label="Firm name" />
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it does, in one sentence" maxLength={280} aria-label="Description" />
            <input value={skills} onChange={(e) => setSkills(e.target.value)} placeholder="Skills, comma separated" aria-label="Skills" />
            <select value={runner} onChange={(e) => setRunner(e.target.value as "devnet" | "self")} aria-label="Who runs the agent">
              <option value="devnet">This devnet runs my agent</option>
              <option value="self">I run my agent myself (download its keys)</option>
            </select>
            {runner === "devnet" && (
              <select value={template} onChange={(e) => setTemplate(Number(e.target.value))} aria-label="Strategy">
                {(config?.templates ?? []).filter((t) => t.name !== "Gambler Inc").map((t) => (
                  <option key={t.index} value={t.index}>
                    Strategy of {t.name}
                  </option>
                ))}
              </select>
            )}
            <TxButton
              className="btn primary"
              disabled={name.trim().length < 2 || !description.trim()}
              run={async () => {
                const c = await getConfig();
                const spec = { name: name.trim(), description: description.trim(), skills: skills.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10) };
                // Self-run: the agent keys are made here and only saved to your disk.
                const own = runner === "self" ? [KeyPair.fromRandom("ed25519"), KeyPair.fromRandom("ed25519")] : null;
                const agentKeys = own ? own.map((k) => k.getPublicKey().toString()) : await requestAgent(spec.name, template);
                const r = await tx(wallet, c.tender, "create_firm", { agent_keys: agentKeys, budget: toBase("5").toString(), max_per_call: toBase("1").toString(), epoch_secs: 3600 }, FIRM_NEAR, 250);
                const reg = r.events.find((e) => e.event === "firm_registered")?.data[0];
                if (!reg) throw new Error("the firm was not registered");
                await tenderCall(wallet, "set_firm_profile", { firm_id: reg.firm_id, profile: JSON.stringify(spec) });
                await ensureLedger(wallet, toBase("10"));
                await tenderCall(wallet, "deposit_bond", { amount: toBase("5").toString() });
                await tenderCall(wallet, "transfer", { receiver_id: reg.account, amount: toBase("5").toString() });
                if (own) {
                  download(`firm-${reg.firm_id}.json`, {
                    rpc: `${location.origin}/rpc`,
                    tender: c.tender,
                    firm_id: reg.firm_id,
                    account: reg.account,
                    keys: { tender: own[0].toString(), firm: own[1].toString() },
                    strategy: "firms/example.ts",
                  });
                }
                navigate(`/app/firms/${reg.firm_id}`);
                return r;
              }}
            >
              <i className="fa-solid fa-building" aria-hidden="true" /> Launch for 3 NEAR + 10 USDC
            </TxButton>
          </div>
        )}
      </div>
    </Card>
  );
}

function FirmCard({ f, index }: { f: FirmState; index: number }) {
  const spec = specOf(f);
  const name = spec?.name ?? f.strategy?.name ?? `Firm #${f.id}`;
  return (
    <Link className="firm-card" to={`/app/firms/${f.id}`} style={{ ["--tint" as any]: firmColor(name, index) }}>
      <div className="firm-card-head">
        <span className="dot big" />
        <div>
          <h2>{name}</h2>
          <p>{spec?.description ?? STRATEGY_NOTES[name] ?? (f.strategy?.house ? "House strategy." : "Third-party strategy.")}</p>
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
  const [rate, setRate] = useState("8");
  const [cap, setCap] = useState("20");
  const [sellAmount, setSellAmount] = useState("30");
  const [sellPrice, setSellPrice] = useState("0.50");
  const config = useConfig();
  const tradeFee = (config?.tenderConfig?.trade_fee_bps ?? 0) / 100;

  const holdersKey = f ? f.holdings.map((h) => `${h.account}:${h.shares}`).join(",") : "";
  // Listing shares changes no balance: re-read the asks after every transaction of this page.
  const [txTick, setTxTick] = useState(0);
  useEffect(() => {
    const on = () => setTxTick((n) => n + 1);
    window.addEventListener("tontine:tx", on);
    return () => window.removeEventListener("tontine:tx", on);
  }, []);
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
  }, [id, holdersKey, f?.acc_per_share, bal?.tender, txTick]);

  if (!f) return <div className="page-app"><Empty>Loading firm #{id}…</Empty></div>;
  const spec = specOf(f);
  const name = spec?.name ?? f.strategy?.name ?? `Firm #${f.id}`;
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
          <p className="sub">{spec?.description ?? STRATEGY_NOTES[name] ?? "Third-party strategy."}</p>
          {spec && (
            <p className="spec-line">
              {spec.skills?.length ? <span>Skills: {spec.skills.join(", ")}</span> : null}
              {spec.model ? <span>Model: {spec.model}</span> : null}
              {spec.min_budget !== undefined || spec.max_budget !== undefined ? (
                <span>
                  Budgets: {spec.min_budget ?? 0} to {spec.max_budget ?? "any"} USDC
                </span>
              ) : null}
              <span>{f.strategy ? (f.strategy.house ? "Run by Tontine (house firm)" : "Agent run by this devnet") : "Agent run by its owner"}</span>
            </p>
          )}
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
                          <span>
                            shares = {usdc(cost)} USDC{tradeFee ? ` (${tradeFee}% of it goes to Tontine, paid by the seller)` : ""}
                          </span>
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
                <p>
                  {f.loan_terms
                    ? `${name} pays ${f.loan_terms.rate_bps / 100}% a year on new loans, up to ${usdc(f.loan_terms.cap)} USDC owed (${usdc(f.debts.reduce((a, d) => a + BigInt(d.principal), 0n))} now).`
                    : `${name} has set no loan terms: a loan earns no interest.`}{" "}
                  The loan goes to the treasury. In a liquidation, creditors are repaid with interest before shareholders; until then the owner can spend it: it is unsecured credit. At least 1 USDC, and a firm carries at most 20 open loans.
                </p>
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
              {wallet.accountId === f.owner && (
                <>
                  <div className="action">
                    <h3 className="mini">You own {name}: sell shares</h3>
                    <p>List shares at your price. Buyers receive 30% of every job the firm wins, pro rata.</p>
                    <div className="inline">
                      <input inputMode="numeric" value={sellAmount} onChange={(e) => setSellAmount(e.target.value)} aria-label="Shares to sell" />
                      <span>shares at</span>
                      <input inputMode="decimal" value={sellPrice} onChange={(e) => setSellPrice(e.target.value)} aria-label="USDC per share" />
                      <span>USDC each</span>
                    </div>
                    <TxButton className="btn" run={() => tenderCall(wallet, "list_shares", { firm_id: f.id, amount: Math.floor(Number(sellAmount)), price_per_share: toBase(sellPrice).toString() })}>
                      <i className="fa-solid fa-tag" aria-hidden="true" /> List shares
                    </TxButton>
                  </div>
                  <div className="action">
                    <h3 className="mini">Borrow: set your loan terms</h3>
                    <p>The yearly rate you pay on new loans and the most you accept to owe.</p>
                    <div className="inline">
                      <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} aria-label="Yearly rate in percent" />
                      <span>% a year, up to</span>
                      <input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} aria-label="Cap in USDC" />
                      <span>USDC</span>
                    </div>
                    <TxButton className="btn" run={() => tenderCall(wallet, "set_loan_terms", { firm_id: f.id, rate_bps: Math.round(Number(rate) * 100), cap: toBase(cap).toString() })}>
                      <i className="fa-solid fa-percent" aria-hidden="true" /> Set terms
                    </TxButton>
                  </div>
                  <div className="action">
                    <h3 className="mini">Close {name}</h3>
                    <p>
                      {f.open_jobs
                        ? `It still has ${f.open_jobs} open job${f.open_jobs === 1 ? "" : "s"}: deliver them first.`
                        : "The treasury pays the creditors with interest, then the shareholders pro rata. The firm stops bidding for good."}
                    </p>
                    <TxButton className="btn" disabled={f.open_jobs > 0 || f.status === "Closed" || f.status === "Liquidating"} run={() => tenderCall(wallet, "close_firm", { firm_id: f.id })}>
                      <i className="fa-solid fa-door-closed" aria-hidden="true" /> Close the firm
                    </TxButton>
                  </div>
                  <div className="action">
                    <h3 className="mini">Keep it running</h3>
                    <p>Bidding needs a 5 USDC owner bond; a treasury under 2 USDC for 3 epochs puts the firm up for sale.</p>
                    <TxButton
                      className="btn"
                      run={async () => {
                        await ensureLedger(wallet, toBase("5"));
                        return tenderCall(wallet, "transfer", { receiver_id: f.account, amount: toBase("5").toString() });
                      }}
                    >
                      <i className="fa-solid fa-sack-dollar" aria-hidden="true" /> Add 5 USDC to the treasury
                    </TxButton>
                  </div>
                </>
              )}
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
