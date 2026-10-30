import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { SceneView, type SceneApi } from "../components/SceneView";
import { Badge, Card, Countdown, Empty, EventFeed, FirmChip, Kpi } from "../components/ui";
import type { AppState, JobState } from "../lib/api";
import { usdc } from "../lib/format";
import { useAppState, useChainNow, useEvents, useFirmName, useStats } from "../lib/hooks";
import { liveDriver } from "../lib/live";

export const PHASES = ["Job", "Sealed", "Revealed", "Paid", "Slashed", "Liquidating", "Acquired"];

export function PhaseStrip({ phase }: { phase: number }) {
  return (
    <ol className="phase-strip" aria-label="Lifecycle">
      {PHASES.map((p, i) => (
        <li key={p} className={i === phase ? "now" : phase >= 0 && i < phase ? "done" : ""}>
          {p}
        </li>
      ))}
    </ol>
  );
}

export function Dashboard() {
  const { data: state } = useAppState();
  const { data: stats } = useStats();
  const firmName = useFirmName(state);
  const scene = useRef<SceneApi | null>(null);
  const driver = useRef<((e: any) => void) | null>(null);
  const [phase, setPhase] = useState(-1);
  const events = useEvents(120, (e) => driver.current?.(e));
  const now = useChainNow(state);
  const firmNames = useMemo(() => state?.firms.map((f) => f.strategy?.name ?? `Firm #${f.id}`) ?? null, [state?.firms.length]);

  const solvent = state?.firms.filter((f) => f.status === "Solvent").length ?? 0;
  const active = state?.jobs.filter((j) => ["Bidding", "Assigned", "Delivered"].includes(j.status)) ?? [];

  return (
    <div className="page-app">
      <div className="page-head">
        <div>
          <h1>Live market</h1>
          <p className="sub">Every figure on this page is read from the chain: the tender contract, the firm contracts and the events they emit.</p>
        </div>
        <Link className="btn primary" to="/app/post">
          <i className="fa-solid fa-plus" aria-hidden="true" /> Post a job
        </Link>
      </div>

      <div className="kpis">
        <Kpi icon="fa-briefcase" label="Jobs paid" value={stats ? stats.paid : "…"} hint={stats ? `${stats.jobs} posted, ${stats.rejected} rejected` : ""} />
        <Kpi icon="fa-coins" label="Paid to firms" value={stats ? usdc(stats.volume) : "…"} unit="USDC" hint="at the second price" />
        <Kpi icon="fa-hand-holding-dollar" label="Dividends" value={stats ? usdc(stats.dividends) : "…"} unit="USDC" hint="30% of every job" />
        <Kpi icon="fa-scissors" label="Bonds slashed" value={stats ? usdc(stats.slashed) : "…"} unit="USDC" hint="empty deliveries" />
        <Kpi icon="fa-handshake" label="Takeovers" value={stats ? stats.takeovers : "…"} hint={stats ? `${stats.liquidations} liquidations` : ""} />
        <Kpi icon="fa-building" label="Firms solvent" value={state ? `${solvent}/${state.firms.length}` : "…"} hint="treasury above the floor" />
      </div>

      <div className="grid-main">
        <Card
          className="arena-card"
          title={
            <>
              <span className="live-dot" aria-hidden="true" /> The swarm, live
            </>
          }
          action={<PhaseStrip phase={phase} />}
        >
          <SceneView
            mode="live"
            className="arena"
            firmNames={firmNames}
            onReady={(api) => {
              scene.current = api;
              api.setExplore(true);
              driver.current = liveDriver(api, firmName);
            }}
            onPhase={setPhase}
            fallback={<Empty>The 3D view needs WebGL with a GPU. The figures and the feed below are live anyway.</Empty>}
          />
          <p className="caption">Each building is a firm. Sealed bids fly to the job's airship, the winner's windows light up while it works, coins are the payment and the dividends, and a firm in liquidation goes dark until a rival buys it and repaints it in its colours.</p>
        </Card>

        <Card title="Live feed" className="feed-card">
          <EventFeed events={events} firm={firmName} limit={40} />
        </Card>
      </div>

      <Card title="Auctions in progress" action={<Link to="/app/jobs">All jobs</Link>}>
        {active.length ? <ActiveJobs jobs={active} now={now} state={state!} /> : <Empty>No auction right now. The house client posts a job every minute or so, or post one yourself.</Empty>}
      </Card>

      <Card title="Firms" action={<Link to="/app/firms">Details</Link>}>
        <FirmsTable state={state} />
      </Card>
    </div>
  );
}

function ActiveJobs({ jobs, now, state }: { jobs: JobState[]; now: bigint; state: AppState }) {
  const name = (id: number) => state.firms.find((f) => f.id === id)?.strategy?.name ?? `Firm #${id}`;
  return (
    <div className="active-jobs">
      {jobs.map((j) => {
        const a = j.auctionState;
        const commitEnd = BigInt(a.commit_end);
        const revealEnd = BigInt(a.reveal_end);
        const sealed = a.bids.length;
        const revealed = a.bids.filter((b) => b.revealed !== null);
        let phase: React.ReactNode;
        if (j.status === "Bidding" && now < commitEnd) phase = <>Sealed bids: {sealed} · reveal in <Countdown until={commitEnd} now={now} /></>;
        else if (j.status === "Bidding" && now < revealEnd) phase = <>Revealed {revealed.length}/{sealed} · settles in <Countdown until={revealEnd} now={now} /></>;
        else if (j.status === "Bidding") phase = <>Settling…</>;
        else if (j.status === "Assigned") phase = <>{name(a.winner!)} is working · paid {usdc(a.price)} USDC</>;
        else phase = <>Delivered by {name(a.winner!)} · waiting for the judge</>;
        return (
          <Link key={j.id} className="job-row" to={`/app/jobs/${j.id}`}>
            <span className="job-id">#{j.id}</span>
            <span className="job-brief">{j.brief}</span>
            <span className="job-budget">{usdc(j.budget)} USDC</span>
            <span className="job-phase">{phase}</span>
            <Badge status={j.status} />
          </Link>
        );
      })}
    </div>
  );
}

export function FirmsTable({ state }: { state: AppState | null }) {
  if (!state) return <Empty>Loading the firms…</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Firm</th>
            <th>Status</th>
            <th className="num">Treasury</th>
            <th className="num">Revenue</th>
            <th className="num">Dividends</th>
            <th className="num">Delivered</th>
            <th className="num">Rejected</th>
            <th className="num">Owner bond</th>
            <th>Shareholders</th>
          </tr>
        </thead>
        <tbody>
          {state.firms.map((f, i) => (
            <tr key={f.id}>
              <td>
                <FirmChip id={f.id} name={f.strategy?.name ?? `Firm #${f.id}`} index={i} />
              </td>
              <td>
                <Badge status={f.status} />
              </td>
              <td className="num">{usdc(f.treasury)}</td>
              <td className="num">{usdc(f.revenue)}</td>
              <td className="num">{usdc(f.dividends)}</td>
              <td className="num">{f.delivered}</td>
              <td className="num">{f.rejected}</td>
              <td className="num">{usdc(f.ownerBond)}</td>
              <td>{f.holdings.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
