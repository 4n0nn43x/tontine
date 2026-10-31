import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { LineChart, type Series } from "../components/Chart";
import { Badge, Card, Empty, EventFeed, Kpi, Modal, Tabs, TxButton } from "../components/ui";
import { getConfig, nameOf, requestAgent, specOf, type ChainEvent, type FirmState } from "../lib/api";
import { ago, firmColor, near, short, toBase, usdc } from "../lib/format";
import { announceTx, useAppState, useBalances, useConfig, useDecisions, useEvents, useFirmName, useWallet } from "../lib/hooks";
import { KeyPair } from "near-api-js";
import { createWallet, depositToTender, ensureLedger, tenderCall, tx, view } from "../lib/near";

export function Firms() {
  const { data: state } = useAppState();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="page-app">
      <div className="page-head">
        <div>
          <h1>Firms</h1>
          <p className="sub">AI market makers quoting NEAR/USDC from their own cash and NEAR, within limits their owners set on chain.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setOpen(true)}>
          <i className="fa-solid fa-plus" aria-hidden="true" /> Launch a firm
        </button>
      </div>
      <div className="firm-grid">{state?.firms.map((f, i) => <FirmCard key={f.id} f={f} index={i} />) ?? <Empty>Loading…</Empty>}</div>
      <Modal open={open} onClose={() => setOpen(false)} title="Launch a firm" locked={busy}>
        <LaunchFirm onBusy={setBusy} onClose={() => setOpen(false)} />
      </Modal>
    </div>
  );
}

/** The firm contract's storage plus gas for its agent keys. */
const FIRM_NEAR = 3n * 10n ** 24n;
/** The NEAR inventory a launched firm starts with. */
const START_NEAR = 5n * 10n ** 24n;
/** What /api/agent accepts as a firm name. */
const NAME_RE = /^[A-Za-z0-9 &.'-]{2,32}$/;

/** Save a JSON file in the browser. */
function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Mark = "todo" | "run" | "done" | "fail";
const STEP_NAMES = ["Name", "Agent", "Funding"];

/** Anyone launches a firm: its own account and contract, 100 shares to the creator, its spec on chain, and
 * an agent either run by this devnet or by the creator itself with keys that never leave the browser. */
function LaunchFirm({ onBusy, onClose }: { onBusy: (b: boolean) => void; onClose: () => void }) {
  const wallet = useWallet();
  const bal = useBalances(wallet?.accountId);
  const config = useConfig();
  const { data: state } = useAppState();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [runner, setRunner] = useState<"devnet" | "self">("devnet");
  const [template, setTemplate] = useState(1);
  const [marks, setMarks] = useState<Mark[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ id: number; name: string } | null>(null);
  const tc = config?.tenderConfig ?? {};
  const bond = BigInt(tc.min_bond ?? 0);
  const floor = BigInt(tc.treasury_floor ?? 0);
  // Start above the cash floor, or the firm is put up for sale after a few epochs.
  const cash = floor + toBase("5");
  const templates = (config?.templates ?? []).filter((t) => t.name !== "Gambler Inc");
  const pitch = (n: string) => specOf(state?.firms.find((f) => f.strategy?.name === n))?.description;

  if (!wallet) {
    return (
      <div className="stepper">
        <p className="muted">A firm is paid for by a demo account: 5 NEAR, 100 test USDC and 20 test wNEAR, its key kept in this browser.</p>
        <TxButton className="btn primary big go" run={() => createWallet()}>
          <i className="fa-solid fa-wallet" aria-hidden="true" /> Create demo account
        </TxButton>
      </div>
    );
  }

  const nameOk = NAME_RE.test(name.trim()) && !!description.trim();
  const labels = [
    runner === "devnet" ? "Reserve a devnet agent" : "Make agent keys in this browser",
    "Create the firm account (3 NEAR)",
    "Publish its name and description",
    "Move USDC to your trading balance, if short",
    `Post the ${usdc(bond, 0)} USDC owner bond`,
    `Fund its cash: ${usdc(cash, 0)} USDC`,
    `Fund its NEAR: ${near(START_NEAR, 0)} wNEAR`,
    ...(runner === "self" ? ["Download firm.json"] : []),
  ];
  // The launch spends 3 NEAR plus gas, USDC from the trading balance then the wallet, wNEAR from the wallet.
  const lack = !bal
    ? null
    : BigInt(bal.near) <= FIRM_NEAR + toBase("0.2", 24)
      ? `Not enough NEAR for gas: ${near(bal.near, 2)} NEAR, 3 NEAR plus gas needed.`
      : BigInt(bal.usdc.tender) + BigInt(bal.usdc.wallet) < bond + cash
        ? `Not enough USDC: ${usdc(bond + cash)} needed. Use the faucet in the account menu.`
        : BigInt(bal.wnear.wallet) < START_NEAR
          ? `Not enough wNEAR in your wallet: ${near(START_NEAR, 0)} needed.`
          : null;

  const launch = async () => {
    setMarks(labels.map(() => "todo"));
    setError(null);
    onBusy(true);
    let i = -1;
    const run = async <T,>(fn: () => Promise<T>): Promise<T> => {
      const k = ++i;
      setMarks((m) => m!.map((s, j) => (j === k ? "run" : s)));
      const r = await fn();
      setMarks((m) => m!.map((s, j) => (j === k ? "done" : s)));
      return r;
    };
    try {
      const c = await getConfig();
      const spec = { name: name.trim(), description: description.trim(), skills: ["NEAR/USDC"] };
      // Self-run: the agent keys are made here and only saved to your disk.
      const own = runner === "self" ? [KeyPair.fromRandom("ed25519"), KeyPair.fromRandom("ed25519")] : null;
      const agentKeys = await run(async () => (own ? own.map((k) => k.getPublicKey().toString()) : requestAgent(spec.name, template)));
      const r = await run(() => tx(wallet, c.tender, "create_firm", { agent_keys: agentKeys, budget: toBase("5").toString(), max_per_call: toBase("1").toString(), epoch_secs: 3600 }, FIRM_NEAR, 250));
      const reg = r.events.find((e) => e.event === "firm_registered")?.data[0];
      if (!reg) throw new Error("the firm was not registered");
      await run(() => tenderCall(wallet, "set_firm_profile", { firm_id: reg.firm_id, profile: JSON.stringify(spec) }));
      await run(() => ensureLedger(wallet, bond + cash));
      await run(() => tenderCall(wallet, "deposit_bond", { amount: bond.toString() }));
      await run(() => tenderCall(wallet, "transfer", { receiver_id: reg.account, amount: cash.toString() }));
      await run(() => depositToTender(wallet, START_NEAR, { Credit: reg.account }, "wnear"));
      if (own) {
        await run(async () =>
          download(`firm-${reg.firm_id}.json`, {
            rpc: `${location.origin}/rpc`,
            tender: c.tender,
            firm_id: reg.firm_id,
            account: reg.account,
            keys: { tender: own[0].toString(), firm: own[1].toString() },
            strategy: "firms/example.ts",
          }),
        );
      }
      setMade({ id: reg.firm_id, name: spec.name });
    } catch (e) {
      setMarks((m) => m!.map((s) => (s === "run" ? "fail" : s)));
      setError((e as Error).message);
    } finally {
      announceTx();
      onBusy(false);
    }
  };

  if (marks) {
    return (
      <div className="stepper">
        <ol className="progress">
          {labels.map((l, j) => (
            <li key={l} className={marks[j]}>
              <i
                className={`fa-solid ${marks[j] === "done" ? "fa-check" : marks[j] === "run" ? "fa-circle-notch fa-spin" : marks[j] === "fail" ? "fa-xmark" : "fa-circle"}`}
                aria-hidden="true"
              />
              {l}
            </li>
          ))}
        </ol>
        {error && (
          <p className="tx-error" role="alert">
            {error}
          </p>
        )}
        {made && (
          <div className="launched">
            <p>
              <b>{made.name}</b> is live as firm #{made.id}.
            </p>
            {runner === "self" && (
              <p className="fine">
                Run it: <code>npx tsx src/agent.ts firm-{made.id}.json</code>
              </p>
            )}
            <Link className="btn primary" to={`/app/firms/${made.id}`} onClick={onClose}>
              Open {made.name}
            </Link>
          </div>
        )}
        {error && (
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="stepper">
      <ol className="step-dots" aria-label="Steps">
        {STEP_NAMES.map((s, j) => (
          <li key={s} className={j === step ? "on" : j < step ? "done" : ""} aria-current={j === step ? "step" : undefined}>
            <span>{j + 1}</span> {s}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Firm name" maxLength={32} autoFocus />
          </label>
          <label className="field">
            <span>One-line description</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it does" maxLength={280} />
          </label>
          {name.trim() && !NAME_RE.test(name.trim()) && <p className="tx-error">2 to 32 letters, digits, spaces or &amp; . ' -</p>}
        </>
      )}

      {step === 1 && (
        <>
          <div className="choice-row" role="radiogroup" aria-label="Who runs the agent">
            {(
              [
                ["devnet", "This devnet runs my agent", "Pick a strategy below."],
                ["self", "I run my agent myself", "With the SDK, on your machine."],
              ] as const
            ).map(([k, title, line]) => (
              <button key={k} type="button" role="radio" aria-checked={runner === k} className={`choice ${runner === k ? "on" : ""}`} onClick={() => setRunner(k)}>
                <b>{title}</b>
                <span>{line}</span>
              </button>
            ))}
          </div>
          {runner === "devnet" ? (
            <div className="choice-grid" role="radiogroup" aria-label="Strategy">
              {templates.map((t) => (
                <button key={t.index} type="button" role="radio" aria-checked={template === t.index} className={`choice ${template === t.index ? "on" : ""}`} onClick={() => setTemplate(t.index)}>
                  <b>{t.name}</b>
                  <span>{pitch(t.name) ?? "House strategy."}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">
              You download <code>firm.json</code> with its agent keys at launch, then run it with the SDK: see <code>SDK.md</code>.
            </p>
          )}
        </>
      )}

      {step === 2 && (
        <>
          <table className="table cost">
            <tbody>
              <tr>
                <td>Firm account and agent gas</td>
                <td className="num">3 NEAR</td>
              </tr>
              <tr>
                <td>Owner bond</td>
                <td className="num">{usdc(bond)} USDC</td>
              </tr>
              <tr>
                <td>Starting cash</td>
                <td className="num">{usdc(cash)} USDC</td>
              </tr>
              <tr>
                <td>Starting NEAR</td>
                <td className="num">{near(START_NEAR, 0)} wNEAR</td>
              </tr>
              <tr className="muted">
                <td>Cash floor, keep cash above it</td>
                <td className="num">{usdc(floor)} USDC</td>
              </tr>
              <tr className="total">
                <td>Total</td>
                <td className="num">
                  3 NEAR, {usdc(bond + cash)} USDC, {near(START_NEAR, 0)} wNEAR
                </td>
              </tr>
            </tbody>
          </table>
          <p className="fine">USDC comes from your trading balance first, then your wallet; wNEAR from your wallet.</p>
          {lack && <p className="tx-error">{lack}</p>}
        </>
      )}

      <div className="stepper-nav">
        {step > 0 && (
          <button type="button" className="btn" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        {step < 2 ? (
          <button type="button" className="btn primary" disabled={step === 0 && !nameOk} onClick={() => setStep(step + 1)}>
            Next
          </button>
        ) : (
          <button type="button" className="btn primary" disabled={!config || !bal || !!lack} onClick={launch}>
            <i className="fa-solid fa-building" aria-hidden="true" /> Launch {name.trim()}
          </button>
        )}
      </div>
    </div>
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
        <div>
          <dt>Cash</dt>
          <dd>{usdc(f.treasury)}</dd>
        </div>
        <div>
          <dt>NEAR</dt>
          <dd>{near(f.inventory, 2)}</dd>
        </div>
        <div>
          <dt>NAV</dt>
          <dd>{usdc(f.nav)}</dd>
        </div>
        <div>
          <dt>Fills</dt>
          <dd>{f.fills}</dd>
        </div>
        <div>
          <dt>Edge</dt>
          <dd>{usdc(f.edge, 4)}</dd>
        </div>
        <div>
          <dt>Dividends</dt>
          <dd>{usdc(f.dividends, 4)}</dd>
        </div>
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

type ActTab = "shares" | "lend" | "policy" | "owner";
type InfoTab = "holders" | "manager" | "history";

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
  const [actTab, setActTab] = useState<ActTab>("shares");
  const [infoTab, setInfoTab] = useState<InfoTab>("holders");
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

  if (!f)
    return (
      <div className="page-app">
        <Empty>Loading firm #{id}…</Empty>
      </div>
    );
  const spec = specOf(f);
  const name = nameOf(f);
  const mine = f.holdings.find((h) => h.account === wallet?.accountId);
  const history = events.filter((e) => e.data?.firm_id === id || e.data?.winner === id || e.data?.buyer_firm_id === id || e.contract === f.account);
  const openAsks = f.holdings.filter((h) => h.account !== wallet?.accountId && asks[h.account] && asks[h.account]!.takeover === f.takeovers && asks[h.account]!.amount > 0);
  const floor = BigInt(tc.treasury_floor ?? 0);
  const nearValue = BigInt(f.nav) - BigInt(f.treasury);
  const nearShare = BigInt(f.nav) > 0n ? Number((nearValue * 10_000n) / BigInt(f.nav)) / 100 : 0;
  const params = state?.params[String(id)];
  const own = (decisions ?? []).filter((d) => d.firm === f.strategy?.name);
  const managed = !!config?.firms.find((x) => x.id === id)?.managed || own.length > 0;
  const isOwner = wallet?.accountId === f.owner;
  const p = f.policy;
  const owed = f.debts.reduce((a, d) => a + BigInt(d.principal), 0n);

  const actTabs = [["shares", "Shares"], ["lend", "Lend"], ["policy", "Policy"], ...(isOwner ? [["owner", "Owner"] as const] : [])] as const;
  const act: ActTab = actTabs.some(([k]) => k === actTab) ? actTab : "shares";
  const infoTabs = [["holders", "Shareholders"], ...(managed ? [["manager", "Manager"] as const] : []), ["history", "History"]] as const;
  const info: InfoTab = infoTabs.some(([k]) => k === infoTab) ? infoTab : "holders";
  const noWallet = <Empty>Create a demo account (top right) to buy shares or lend.</Empty>;

  return (
    <div className="page-app">
      <div className="page-head">
        <div>
          <p className="crumbs">
            <Link to="/app/firms">Firms</Link> / {name}
          </p>
          <h1 className="firm-title" style={{ ["--tint" as any]: firmColor(name, id) }}>
            <span className="dot big" /> {name} <Badge status={f.status} />
            {p.paused && <Badge status="Illiquid">paused</Badge>}
            {isOwner && <Badge status="Open">you own it</Badge>}
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
        <Kpi label="NAV" value={usdc(f.nav)} unit="USDC" hint={`NEAR at ${state ? (Number(state.lastPrice) / 1e6).toFixed(4) : "…"} USD, the last clearing price`} />
        <Kpi label="Fills" value={f.fills} hint={`${usdc(f.volume)} USDC of volume`} />
        <Kpi label="Edge" value={usdc(f.edge, 4)} unit="USDC" hint="gained on its fills" />
        <Kpi label="Dividends paid" value={usdc(f.dividends, 4)} unit="USDC" hint={`${(tc.dividend_bps ?? 0) / 100}% of each positive edge`} />
      </div>

      <Card title="Edge after each fill">
        <LineChart series={series} height={220} empty="No fill by this firm in the recent events." />
        <dl className="facts inline-facts">
          <dt>Owner bond</dt>
          <dd>
            {usdc(f.ownerBond)} USDC, {usdc(f.slashed)} slashed
          </dd>
          <dt>Takeovers</dt>
          <dd>{f.takeovers || "never sold"}</dd>
          <dt>In open bids</dt>
          <dd>
            {usdc(f.escrow)} USDC, {near(f.escrow_asset)} NEAR
          </dd>
        </dl>
      </Card>

      <div className="grid-2">
        <Card className="tab-card">
          <Tabs tabs={actTabs} value={act} onChange={setActTab} />

          {act === "shares" &&
            (!wallet ? (
              noWallet
            ) : (
              <div className="actions">
                {mine && (
                  <div className="action">
                    <p>
                      You hold <b>{mine.shares}</b> shares, {pending[wallet.accountId] !== undefined ? usdc(pending[wallet.accountId], 4) : "…"} USDC unclaimed.
                    </p>
                    <TxButton className="btn primary" disabled={!pending[wallet.accountId] || pending[wallet.accountId] === "0"} run={() => tenderCall(wallet, "claim_dividends", { firm_id: f.id })}>
                      <i className="fa-solid fa-hand-holding-dollar" aria-hidden="true" /> Claim dividends
                    </TxButton>
                  </div>
                )}
                <div className="action">
                  {openAsks.length ? (
                    <>
                      <div className="inline">
                        <span>Buy</span>
                        <input inputMode="numeric" value={buyAmount} onChange={(e) => setBuyAmount(e.target.value)} aria-label="Shares to buy" />
                        <span>shares from</span>
                      </div>
                      {openAsks.map((h) => {
                        const ask = asks[h.account]!;
                        const n = Math.max(0, Math.min(ask.amount, Math.floor(Number(buyAmount) || 0)));
                        const cost = BigInt(ask.price_per_share) * BigInt(n);
                        return (
                          <div className="ask-row" key={h.account}>
                            <span>
                              {short(h.account)}: {ask.amount} at {usdc(ask.price_per_share)} USDC
                            </span>
                            <TxButton
                              className="btn small primary"
                              disabled={n < 1 || f.status === "Liquidating"}
                              run={async () => {
                                await ensureLedger(wallet, cost);
                                return tenderCall(wallet, "buy_shares", { firm_id: f.id, seller: h.account, amount: n });
                              }}
                            >
                              Buy {n} for {usdc(cost)} USDC
                            </TxButton>
                          </div>
                        );
                      })}
                      {tradeFee ? <p className="fine">The seller pays {tradeFee}% to Tontine.</p> : null}
                    </>
                  ) : (
                    <p>No other holder is selling {name} shares right now.</p>
                  )}
                </div>
                {isOwner && (
                  <div className="action">
                    <h3 className="mini">Sell your shares</h3>
                    <div className="inline">
                      <input inputMode="numeric" value={sellAmount} onChange={(e) => setSellAmount(e.target.value)} aria-label="Shares to sell" />
                      <span>at</span>
                      <input inputMode="decimal" value={sellPrice} onChange={(e) => setSellPrice(e.target.value)} aria-label="USDC per share" />
                      <span>USDC each</span>
                    </div>
                    <TxButton className="btn" run={() => tenderCall(wallet, "list_shares", { firm_id: f.id, amount: Math.floor(Number(sellAmount)), price_per_share: toBase(sellPrice).toString() })}>
                      <i className="fa-solid fa-tag" aria-hidden="true" /> List shares
                    </TxButton>
                  </div>
                )}
                <p className="fine">Holders get {(tc.dividend_bps ?? 0) / 100}% of each positive edge, pro rata.</p>
              </div>
            ))}

          {act === "lend" &&
            (!wallet ? (
              noWallet
            ) : (
              <div className="actions">
                <div className="action">
                  <p>
                    {f.loan_terms ? `${pct(f.loan_terms.rate_bps)} a year, up to ${usdc(f.loan_terms.cap)} USDC owed (${usdc(owed)} now).` : "No loan terms set: a loan earns no interest."}
                  </p>
                  <div className="inline">
                    <input inputMode="decimal" value={lendAmount} onChange={(e) => setLendAmount(e.target.value)} aria-label="USDC to lend" />
                    <span>USDC</span>
                    <TxButton
                      className="btn primary"
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
                  <p className="fine">Creditors are repaid with interest before shareholders. At least 1 USDC, 20 open loans at most.</p>
                </div>
                {isOwner && (
                  <div className="action">
                    <h3 className="mini">Your loan terms</h3>
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
                )}
              </div>
            ))}

          {act === "policy" && (
            <>
              <dl className="facts">
                <dt>Price band</dt>
                <dd>{p.band_bps ? `±${pct(p.band_bps)} around the last clearing price` : "none"}</dd>
                <dt>Most in NEAR</dt>
                <dd>{pct(p.max_asset_bps)} of its NAV</dd>
                <dt>Quoting</dt>
                <dd>{p.paused ? "paused by its owner" : "on"}</dd>
                <dt>Spread</dt>
                <dd>{params ? `${params.spreadBps} bp from the mid` : "not published"}</dd>
                <dt>NEAR target</dt>
                <dd>{params ? `${Math.round(params.targetAssetShare * 100)}%, lean up to ${params.skewBps} bp` : "–"}</dd>
              </dl>
              <p className="fine">The contract refuses any revealed quote outside the policy, and a refused quote costs the owner's bond.</p>
              {isOwner && (
                <div className="action">
                  <h3 className="mini">Set the policy</h3>
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
            </>
          )}

          {act === "owner" && wallet && (
            <div className="actions">
              <div className="action">
                <h3 className="mini">Top up</h3>
                <div className="actions-row">
                  <TxButton
                    className="btn"
                    run={async () => {
                      await ensureLedger(wallet, toBase("10"));
                      return tenderCall(wallet, "transfer", { receiver_id: f.account, amount: toBase("10").toString() });
                    }}
                  >
                    <i className="fa-solid fa-sack-dollar" aria-hidden="true" /> 10 USDC to its cash
                  </TxButton>
                  <TxButton className="btn" run={() => depositToTender(wallet, toBase("2", 24), { Credit: f.account }, "wnear")}>
                    <i className="fa-solid fa-coins" aria-hidden="true" /> 2 wNEAR to its inventory
                  </TxButton>
                </div>
                <p className="fine">
                  Quoting needs a {usdc(tc.min_bond ?? 0)} USDC bond. Cash under {usdc(floor)} USDC for {tc.epochs_before_liquidation ?? "a few"} epochs puts the firm up for sale.
                </p>
              </div>
              <details className="action danger">
                <summary>Close {name}</summary>
                <p>Its cash pays creditors with interest, then shareholders pro rata; its NEAR goes to shareholders in kind. It stops quoting for good. Settle its open bids first.</p>
                <TxButton className="btn" disabled={f.status === "Closed" || f.status === "Liquidating"} run={() => tenderCall(wallet, "close_firm", { firm_id: f.id })}>
                  <i className="fa-solid fa-door-closed" aria-hidden="true" /> Close the firm
                </TxButton>
              </details>
            </div>
          )}
        </Card>

        <Card className="tab-card">
          <Tabs tabs={infoTabs} value={info} onChange={setInfoTab} />

          {info === "holders" && (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Holder</th>
                      <th className="num">Shares</th>
                      <th className="num">Unclaimed</th>
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
            </>
          )}

          {info === "manager" && (
            <>
              <p className="fine">
                Reviews its results every few minutes and retunes its spread, NEAR target and lean, within the owner's policy. Each decision shows its source: an LLM (NEAR AI Cloud or Claude, paid by the firm) or the stated rule.
              </p>
              {own.length ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Source</th>
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
                            <Badge status={d.source === "rule" ? undefined : "Filled"}>{d.source === "near-ai-cloud" ? "LLM, NEAR AI Cloud" : d.source === "anthropic" ? "LLM, Claude" : "stated rule"}</Badge>
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
            </>
          )}

          {info === "history" && <EventFeed events={history} firm={firmName} limit={50} />}
        </Card>
      </div>
    </div>
  );
}
