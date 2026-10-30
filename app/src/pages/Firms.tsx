import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { LineChart, type Series } from "../components/Chart";
import { Badge, Card, Empty, EventFeed, Kpi, TxButton } from "../components/ui";
import { getConfig, nameOf, requestAgent, specOf, type ChainEvent, type FirmState } from "../lib/api";
import { ago, firmColor, near, short, toBase, usdc } from "../lib/format";
import { useAppState, useBalances, useConfig, useDecisions, useEvents, useFirmName, useWallet } from "../lib/hooks";
import { KeyPair } from "near-api-js";
import { depositToTender, ensureLedger, tenderCall, tx, view } from "../lib/near";

export function Firms() {
  const { data: state } = useAppState();
  return (
    <div className="page-app">
      <div className="page-head">
        <div>
          <h1>Firms</h1>
          <p className="sub">
            A firm is an AI market maker: a NEAR account with a contract and no full access key, a USDC cash treasury and a NEAR inventory. Its agent quotes orders inside the limits its owner sets on chain, and 100 NEP-245 shares split its dividends.
          </p>
        </div>
      </div>
      <LaunchFirm />
      <div className="firm-grid">{state?.firms.map((f, i) => <FirmCard key={f.id} f={f} index={i} />) ?? <Empty>Loading…</Empty>}</div>
    </div>
  );
}

/** The firm contract's storage plus gas for its agent keys. */
const FIRM_NEAR = 3n * 10n ** 24n;
/** The NEAR inventory a launched firm starts with. */
const START_NEAR = 5n * 10n ** 24n;

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
  const { data: state } = useAppState();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [skills, setSkills] = useState("NEAR/USDC");
  const [runner, setRunner] = useState<"devnet" | "self">("devnet");
  const [template, setTemplate] = useState(1);
  const tc = config?.tenderConfig ?? {};
  const bond = BigInt(tc.min_bond ?? 0);
  const floor = BigInt(tc.treasury_floor ?? 0);
  // Start above the cash floor, or the firm is put up for sale after a few epochs.
  const cash = floor + toBase("5");
  const templates = (config?.templates ?? []).filter((t) => t.name !== "Gambler Inc");
  const pitch = (n: string) => specOf(state?.firms.find((f) => f.strategy?.name === n))?.description;
  return (
    <Card title="Launch your firm">
      <div className="launch">
        <div>
          <p>
            Your firm gets its own NEAR account with no full access key, a contract that caps its spending, and 100 shares that you own: sell some to raise money, keep the rest for the dividends. It quotes NEAR/USDC orders from its cash and its NEAR inventory,
            inside the price band and NEAR share you set as its owner. It costs 3 NEAR for the account and its agent's gas, a {usdc(bond)} USDC owner bond to quote, and a starting treasury of {usdc(cash)} USDC and {near(START_NEAR, 0)} NEAR (the cash floor
            is {usdc(floor)} USDC). Tontine takes {(tc.order_fee_bps ?? 0) / 100}% of what the firm receives on each fill.
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
            <input value={skills} onChange={(e) => setSkills(e.target.value)} placeholder="Markets, comma separated" aria-label="Markets" />
            <select value={runner} onChange={(e) => setRunner(e.target.value as "devnet" | "self")} aria-label="Who runs the agent">
              <option value="devnet">This devnet runs my agent</option>
              <option value="self">I run my agent myself (download its keys)</option>
            </select>
            {runner === "devnet" && (
              <>
                <select value={template} onChange={(e) => setTemplate(Number(e.target.value))} aria-label="Strategy">
                  {templates.map((t) => (
                    <option key={t.index} value={t.index}>
                      Strategy of {t.name}
                    </option>
                  ))}
                </select>
                {pitch(config?.templates[template]?.name ?? "") && <p className="fine">{pitch(config!.templates[template].name)}</p>}
              </>
            )}
            <TxButton
              className="btn primary"
              disabled={name.trim().length < 2 || !description.trim() || !config}
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
                await ensureLedger(wallet, bond + cash);
                await tenderCall(wallet, "deposit_bond", { amount: bond.toString() });
                await tenderCall(wallet, "transfer", { receiver_id: reg.account, amount: cash.toString() });
                await depositToTender(wallet, START_NEAR, { Credit: reg.account }, "wnear");
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
              <i className="fa-solid fa-building" aria-hidden="true" /> Launch for 3 NEAR, {usdc(bond + cash, 0)} USDC and {near(START_NEAR, 0)} wNEAR
            </TxButton>
          </div>
        )}
      </div>
    </Card>
  );
}

function FirmCard({ f, index }: { f: FirmState; index: number }) {
  const spec = specOf(f);
  const name = nameOf(f);
  return (
    <Link className="firm-card" to={`/app/firms/${f.id}`} style={{ ["--tint" as any]: firmColor(name, index) }}>
      <div className="firm-card-head">
        <span className="dot big" />
        <div>
          <h2>{name}</h2>
          <p>{spec?.description ?? (f.strategy?.house ? "House strategy." : "Third-party strategy.")}</p>
        </div>
        <Badge status={f.status} />
      </div>
      <dl className="firm-figures">
        <dt>Cash</dt>
        <dd>{usdc(f.treasury)} USDC</dd>
        <dt>NEAR</dt>
        <dd>{near(f.inventory)}</dd>
        <dt>NAV</dt>
        <dd>{usdc(f.nav)} USDC</dd>
        <dt>Fills / edge</dt>
        <dd>
          {f.fills} / {usdc(f.edge, 4)}
        </dd>
        <dt>Dividends</dt>
        <dd>{usdc(f.dividends, 4)} USDC</dd>
      </dl>
    </Link>
  );
}

/** Cumulative edge after each of the firm's fills, anchored on its on-chain total. */
function edgeSeries(events: ChainEvent[], f: FirmState): Series[] {
  const fills = events.filter((e) => e.event === "order_filled" && e.data?.firm_id === f.id);
  let acc = BigInt(f.edge) - fills.reduce((s, e) => s + BigInt(e.data.edge), 0n);
  const points = fills.map((e) => {
    acc += BigInt(e.data.edge);
    return { time: e.time / 1000, value: Number(acc) / 1e6 };
  });
  return [{ name: "Edge, USDC", color: "#8ef0b3", points, precision: 4 }];
}

const pct = (bps: number) => `${bps / 100}%`;

export function FirmDetail() {
  const id = Number(useParams().id);
  const { data: state } = useAppState();
  const firmName = useFirmName(state);
  const wallet = useWallet();
  const bal = useBalances(wallet?.accountId);
  const events = useEvents(500);
  const config = useConfig();
  const { data: decisions } = useDecisions();
  const f = state?.firms.find((x) => x.id === id);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [asks, setAsks] = useState<Record<string, { amount: number; price_per_share: string; takeover: number } | null>>({});
  const [buyAmount, setBuyAmount] = useState("5");
  const [lendAmount, setLendAmount] = useState("5");
  const [rate, setRate] = useState("8");
  const [cap, setCap] = useState("20");
  const [sellAmount, setSellAmount] = useState("30");
  const [sellPrice, setSellPrice] = useState("0.50");
  const [band, setBand] = useState<string | null>(null);
  const [maxNear, setMaxNear] = useState<string | null>(null);
  const [paused, setPaused] = useState<boolean | null>(null);
  const tc = config?.tenderConfig ?? {};
  const tradeFee = (tc.trade_fee_bps ?? 0) / 100;

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
  }, [id, holdersKey, f?.acc_per_share, bal?.usdc.tender, txTick]);

  const lastFill = events.reduce((k, e) => (e.event === "order_filled" && e.data?.firm_id === id ? e.id : k), 0);
  const series = useMemo(() => (f ? edgeSeries(events, f) : []), [lastFill, !!f]);

  if (!f) return <div className="page-app"><Empty>Loading firm #{id}…</Empty></div>;
  const spec = specOf(f);
  const name = nameOf(f);
  const mine = f.holdings.find((h) => h.account === wallet?.accountId);
  const history = events.filter((e) => e.data?.firm_id === id || e.data?.winner === id || e.data?.buyer_firm_id === id || e.contract === f.account);
  const openAsks = f.holdings.filter((h) => asks[h.account] && asks[h.account]!.takeover === f.takeovers && asks[h.account]!.amount > 0);
  const floor = BigInt(tc.treasury_floor ?? 0);
  const nearValue = BigInt(f.nav) - BigInt(f.treasury);
  const nearShare = BigInt(f.nav) > 0n ? Number((nearValue * 10_000n) / BigInt(f.nav)) / 100 : 0;
  const params = state?.params[String(id)];
  const own = (decisions ?? []).filter((d) => d.firm === f.strategy?.name);
  const managed = !!config?.firms.find((x) => x.id === id)?.managed || own.length > 0;
  const isOwner = wallet?.accountId === f.owner;
  const p = f.policy;

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
          <p className="sub">{spec?.description ?? "Third-party strategy."}</p>
          <p className="spec-line">
            {spec?.skills?.length ? <span>Markets: {spec.skills.join(", ")}</span> : null}
            {spec?.model ? <span>Model: {spec.model}</span> : null}
            {spec?.min_budget !== undefined || spec?.max_budget !== undefined ? (
              <span>
                Order sizes: {spec?.min_budget ?? 0} to {spec?.max_budget ?? "any"} USDC
              </span>
            ) : null}
            <span>{f.strategy ? (f.strategy.house ? "Run by Tontine (house firm)" : "Agent run by this devnet") : "Agent run by its owner"}</span>
          </p>
        </div>
      </div>

      <div className="kpis">
        <Kpi
          label="Cash"
          value={usdc(f.treasury)}
          unit="USDC"
          hint={f.status === "Solvent" ? `above the ${usdc(floor, 0)} USDC floor` : f.status === "Illiquid" ? `${f.epochs_below_floor}/${tc.epochs_before_liquidation ?? "?"} epochs under the ${usdc(floor, 0)} USDC floor` : f.status.toLowerCase()}
        />
        <Kpi label="NEAR inventory" value={near(f.inventory)} unit="NEAR" hint={`${nearShare.toFixed(1)}% of its NAV`} />
        <Kpi label="NAV" value={usdc(f.nav)} unit="USDC" hint={`NEAR at the last clearing price, ${state ? (Number(state.lastPrice) / 1e6).toFixed(4) : "…"} USD`} />
        <Kpi label="Fills" value={f.fills} hint={`${usdc(f.volume)} USDC of volume`} />
        <Kpi label="Edge" value={usdc(f.edge, 4)} unit="USDC" hint="what it gained on its fills, at the previous clearing price" />
        <Kpi label="Dividends paid" value={usdc(f.dividends, 4)} unit="USDC" hint={`${(tc.dividend_bps ?? 0) / 100}% of each positive edge`} />
      </div>

      <div className="grid-2">
        <Card title="Edge after each fill">
          <LineChart series={series} height={220} empty="No fill by this firm in the recent events." />
          <dl className="facts">
            <dt>Owner bond</dt>
            <dd>
              {usdc(f.ownerBond)} USDC (quoting needs {usdc(tc.min_bond ?? 0)}), {usdc(f.slashed)} USDC slashed so far
            </dd>
            <dt>Takeovers</dt>
            <dd>{f.takeovers ? `${f.takeovers}: this firm changed hands` : "never sold"}</dd>
            <dt>In open bids</dt>
            <dd>
              {usdc(f.escrow)} USDC and {near(f.escrow_asset)} NEAR escrowed
            </dd>
          </dl>
        </Card>

        <Card title="Owner policy and quotes">
          <dl className="facts">
            <dt>Price band</dt>
            <dd>{p.band_bps ? `±${pct(p.band_bps)} around tender's last clearing price when the order was posted` : "none"}</dd>
            <dt>Most in NEAR</dt>
            <dd>{pct(p.max_asset_bps)} of its NAV after a fill</dd>
            <dt>Quoting</dt>
            <dd>{p.paused ? "paused by its owner (kill switch)" : "on"}</dd>
            <dt>Spread</dt>
            <dd>{params ? `${params.spreadBps} bp from the mid` : "not published (its owner runs the agent)"}</dd>
            <dt>Target NEAR share</dt>
            <dd>{params ? `${Math.round(params.targetAssetShare * 100)}% of its value, leaning its quotes by up to ${params.skewBps} bp` : "–"}</dd>
          </dl>
          <p className="fine">The contract checks the policy on every revealed quote: whatever its agent is told, a quote outside the band or over the NEAR limit is refused, and a refused quote costs the owner's bond.</p>
          {isOwner && (
            <div className="action">
              <h3 className="mini">You own {name}: set its policy</h3>
              <div className="inline wrap">
                <span>Band ±</span>
                <input inputMode="decimal" value={band ?? String(p.band_bps / 100)} onChange={(e) => setBand(e.target.value)} aria-label="Price band in percent" />
                <span>%, at most</span>
                <input inputMode="decimal" value={maxNear ?? String(p.max_asset_bps / 100)} onChange={(e) => setMaxNear(e.target.value)} aria-label="Most of the NAV in NEAR, percent" />
                <span>% in NEAR</span>
                <label className="check">
                  <input type="checkbox" checked={paused ?? p.paused} onChange={(e) => setPaused(e.target.checked)} /> Paused
                </label>
              </div>
              <TxButton
                className="btn"
                run={() =>
                  tenderCall(wallet!, "set_policy", {
                    firm_id: f.id,
                    policy: { band_bps: Math.round(Number(band ?? p.band_bps / 100) * 100), max_asset_bps: Math.round(Number(maxNear ?? p.max_asset_bps / 100) * 100), paused: paused ?? p.paused },
                  })
                }
              >
                <i className="fa-solid fa-sliders" aria-hidden="true" /> Set policy
              </TxButton>
            </div>
          )}
        </Card>
      </div>

      {managed && (
        <Card title="Manager decisions">
          <p className="fine">
            {name}'s manager reviews its results every few minutes and retunes its spread, NEAR target and lean. With a NEAR AI Cloud key an LLM decides and the firm pays the inference from its treasury; without one, a stated rule decides, labelled as such. The owner's policy bounds both.
          </p>
          {own.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Decided by</th>
                    <th className="num">Spread</th>
                    <th className="num">NEAR target</th>
                    <th className="num">Lean</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {own.map((d) => (
                    <tr key={d.at}>
                      <td>{ago(d.at)}</td>
                      <td>
                        <Badge status={d.source === "near-ai-cloud" ? "Filled" : undefined}>{d.source === "near-ai-cloud" ? "AI on NEAR AI Cloud" : "rule, no key"}</Badge>
                        {d.model ? <span className="fine"> {d.model}</span> : null}
                      </td>
                      <td className="num">
                        {d.before.spreadBps} → {d.after.spreadBps} bp
                      </td>
                      <td className="num">
                        {Math.round(d.before.targetAssetShare * 100)} → {Math.round(d.after.targetAssetShare * 100)}%
                      </td>
                      <td className="num">
                        {d.before.skewBps} → {d.after.skewBps} bp
                      </td>
                      <td>{d.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No decision yet.</Empty>
          )}
        </Card>
      )}

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
                    <td className="num">{pending[h.account] !== undefined ? usdc(pending[h.account], 4) : "…"}</td>
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
                  <p>Unclaimed dividends: {pending[wallet.accountId] !== undefined ? usdc(pending[wallet.accountId], 4) : "…"} USDC.</p>
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
                    const n = Math.max(0, Math.min(ask.amount, Math.floor(Number(buyAmount) || 0)));
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
                  The loan goes to its cash, and the firm must keep that cash: it cannot turn what it owes into NEAR. In a liquidation, creditors are repaid with interest before shareholders. At least 1 USDC, and a firm carries at most 20 open loans.
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
              {isOwner && (
                <>
                  <div className="action">
                    <h3 className="mini">You own {name}: sell shares</h3>
                    <p>List shares at your price. Holders receive {(tc.dividend_bps ?? 0) / 100}% of each positive edge the firm makes on a fill, pro rata.</p>
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
                    <h3 className="mini">Keep it running</h3>
                    <p>
                      Quoting needs a {usdc(tc.min_bond ?? 0)} USDC owner bond; cash under the {usdc(floor)} USDC floor for {tc.epochs_before_liquidation ?? "a few"} epochs puts the firm up for sale.
                    </p>
                    <div className="actions-row">
                      <TxButton
                        className="btn"
                        run={async () => {
                          await ensureLedger(wallet, toBase("10"));
                          return tenderCall(wallet, "transfer", { receiver_id: f.account, amount: toBase("10").toString() });
                        }}
                      >
                        <i className="fa-solid fa-sack-dollar" aria-hidden="true" /> Add 10 USDC to its cash
                      </TxButton>
                      <TxButton className="btn" run={() => depositToTender(wallet, toBase("2", 24), { Credit: f.account }, "wnear")}>
                        <i className="fa-solid fa-coins" aria-hidden="true" /> Add 2 wNEAR to its inventory
                      </TxButton>
                    </div>
                  </div>
                  <div className="action">
                    <h3 className="mini">Close {name}</h3>
                    <p>Its cash pays the creditors with interest, then the shareholders pro rata; its NEAR goes to the shareholders in kind. The firm stops quoting for good. Settle its open bids first.</p>
                    <TxButton className="btn" disabled={f.status === "Closed" || f.status === "Liquidating"} run={() => tenderCall(wallet, "close_firm", { firm_id: f.id })}>
                      <i className="fa-solid fa-door-closed" aria-hidden="true" /> Close the firm
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
