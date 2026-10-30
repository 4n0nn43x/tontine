import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Card, Countdown, Empty, EventFeed, FirmChip } from "../components/ui";
import { getConfig, type JobState } from "../lib/api";
import { short, usdc } from "../lib/format";
import { useAppState, useChainNow, useEvents, useFirmName, useWallet } from "../lib/hooks";
import { view } from "../lib/near";

function clientLabel(client: string, house: string | undefined, me: string | undefined) {
  if (me && client === me) return "you";
  if (house && client === house) return "house client";
  return short(client);
}

export function Jobs() {
  const { data: state } = useAppState();
  const wallet = useWallet();
  const [house, setHouse] = useState<string>();
  useEffect(() => void getConfig().then((c) => setHouse(c.houseClient), () => {}), []);
  const name = useFirmName(state);
  return (
    <div className="page-app">
      <div className="page-head">
        <div>
          <h1>Jobs</h1>
          <p className="sub">Each job is a sealed-bid reverse auction. The lowest bid wins and is paid the second-lowest price.</p>
        </div>
        <Link className="btn primary" to="/app/post">
          <i className="fa-solid fa-plus" aria-hidden="true" /> Post a job
        </Link>
      </div>
      <Card>
        {!state ? (
          <Empty>Loading…</Empty>
        ) : !state.jobs.length ? (
          <Empty>No job yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Job</th>
                  <th>Client</th>
                  <th className="num">Budget</th>
                  <th>Status</th>
                  <th>Winner</th>
                  <th className="num">Price</th>
                </tr>
              </thead>
              <tbody>
                {state.jobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <Link to={`/app/jobs/${j.id}`}>#{j.id}</Link>
                    </td>
                    <td className="ellipsis">
                      <Link to={`/app/jobs/${j.id}`}>{j.brief}</Link>
                    </td>
                    <td>{clientLabel(j.client, house, wallet?.accountId)}</td>
                    <td className="num">{usdc(j.budget)}</td>
                    <td>
                      <Badge status={j.status} />
                    </td>
                    <td>{j.auctionState.winner !== null ? <FirmChip id={j.auctionState.winner} name={name(j.auctionState.winner)} index={j.auctionState.winner} /> : "–"}</td>
                    <td className="num">{j.auctionState.price ? usdc(j.auctionState.price) : "–"}</td>
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

export function JobDetail() {
  const id = Number(useParams().id);
  const { data: state } = useAppState();
  const name = useFirmName(state);
  const now = useChainNow(state);
  const events = useEvents(400);
  const [fetched, setFetched] = useState<JobState | null>(null);
  const fromState = state?.jobs.find((j) => j.id === id) ?? null;

  useEffect(() => {
    if (fromState || !Number.isFinite(id)) return;
    let alive = true;
    (async () => {
      const c = await getConfig();
      const job = await view(c.tender, "get_job", { job_id: id });
      const auctionState = await view(c.tender, "get_auction", { auction_id: job.auction });
      if (alive) setFetched({ ...job, auctionState });
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, !!fromState]);

  const job = fromState ?? fetched;
  if (!job) return <div className="page-app"><Empty>Loading job #{id}…</Empty></div>;
  const a = job.auctionState;
  const mine = events.filter((e) => e.data?.job_id === id || e.data?.auction_id === job.auction);
  const paid = mine.find((e) => e.event === "paid")?.data;
  const slashed = mine.find((e) => e.event === "slashed")?.data;
  let attestation: any = null;
  try {
    attestation = job.attestation ? JSON.parse(job.attestation) : null;
  } catch {
    attestation = job.attestation;
  }

  return (
    <div className="page-app">
      <div className="page-head">
        <div>
          <p className="crumbs">
            <Link to="/app/jobs">Jobs</Link> / #{job.id}
          </p>
          <h1>
            Job #{job.id} <Badge status={job.status} />
          </h1>
          <p className="sub">{job.brief}</p>
        </div>
      </div>

      <div className="grid-2">
        <Card title="Auction">
          <dl className="facts">
            <dt>Budget in escrow</dt>
            <dd>{usdc(job.budget)} USDC</dd>
            <dt>Client</dt>
            <dd>{short(job.client, 30)}</dd>
            <dt>Commit phase</dt>
            <dd>{now < BigInt(a.commit_end) ? <>ends in <Countdown until={BigInt(a.commit_end)} now={now} /></> : "closed"}</dd>
            <dt>Reveal phase</dt>
            <dd>{now < BigInt(a.reveal_end) ? <>ends in <Countdown until={BigInt(a.reveal_end)} now={now} /></> : "closed"}</dd>
            <dt>Winner</dt>
            <dd>{a.winner !== null ? <FirmChip id={a.winner} name={name(a.winner)} index={a.winner} /> : "–"}</dd>
            <dt>Price paid</dt>
            <dd>{a.price ? `${usdc(a.price)} USDC (the second-lowest bid)` : "–"}</dd>
          </dl>
          <table className="table bids">
            <thead>
              <tr>
                <th>Firm</th>
                <th>Bid</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {a.bids.length ? (
                a.bids.map((b) => (
                  <tr key={b.firm_id} className={a.winner === b.firm_id ? "winner" : ""}>
                    <td>
                      <FirmChip id={b.firm_id} name={name(b.firm_id)} index={b.firm_id} />
                    </td>
                    <td>{b.revealed !== null ? "revealed" : a.settled ? "never revealed" : "sealed"}</td>
                    <td className="num">{b.revealed !== null ? usdc(b.revealed) : <span className="sealed">{b.hash.slice(0, 10)}…</span>}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3}>No bid yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>

        <Card title="Delivery and settlement">
          {job.result !== null ? (
            <>
              <h3 className="mini">Deliverable</h3>
              <pre className="deliverable">{job.result || "(empty)"}</pre>
            </>
          ) : (
            <Empty>{job.status === "Assigned" ? "The winning firm is working on it." : "Nothing delivered yet."}</Empty>
          )}
          {paid && (
            <dl className="facts">
              <dt>Paid</dt>
              <dd>{usdc(paid.price)} USDC</dd>
              <dt>To the firm treasury</dt>
              <dd>{usdc(paid.to_firm)} USDC (70%)</dd>
              <dt>To the shareholders</dt>
              <dd>{usdc(paid.dividends)} USDC (30%)</dd>
            </dl>
          )}
          {slashed && (
            <dl className="facts bad">
              <dt>Rejected</dt>
              <dd>the client got {usdc(slashed.refund)} USDC back</dd>
              <dt>Owner bond slashed</dt>
              <dd>{usdc(slashed.amount)} USDC to the client</dd>
            </dl>
          )}
          {attestation && (
            <>
              <h3 className="mini">Judge attestation (stored on chain)</h3>
              <pre className="attestation">{typeof attestation === "string" ? attestation : JSON.stringify(attestation, null, 2)}</pre>
              {attestation?.source === "replay" && <p className="fine">This server has no NEAR AI Cloud key: work and verdicts come from the replay mode, labelled as such.</p>}
            </>
          )}
        </Card>
      </div>

      <Card title="On-chain events for this job">
        <EventFeed events={mine} firm={name} limit={40} />
      </Card>
    </div>
  );
}
