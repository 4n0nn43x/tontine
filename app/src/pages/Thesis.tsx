import { useEffect, useState } from "react";
import { Card, Empty, Kpi } from "../components/ui";
import { getThesis } from "../lib/api";

const M = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : `$${(x / 1e6).toFixed(0)}M`);

export function Thesis() {
  const [t, setT] = useState<Awaited<ReturnType<typeof getThesis>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => void getThesis().then(setT, (e) => setErr((e as Error).message)), []);
  if (err) return <div className="page-app"><Empty>Thesis data unavailable: {err}</Empty></div>;
  if (!t?.result) return <div className="page-app"><Empty>Loading the thesis…</Empty></div>;
  const r = t.result;
  const p = t.predictions;
  const blocks: { from: string; to: string; bp: number }[] = r.blocks ?? [];
  const maxBp = Math.max(6, ...blocks.map((b) => b.bp));

  return (
    <div className="page-app">
      <div className="page-head">
        <div>
          <h1>NEAR captures agent value through Intents-funded buybacks, not gas</h1>
          <p className="sub">
            A thesis backed by public data (DefiLlama, NEARBlocks) and by predictions that can be wrong in public. Data through {r.data_through}; re-run with <code>make thesis</code>.
          </p>
        </div>
      </div>

      <div className="kpis">
        <Kpi label="Volume multiple needed" value={r.multiple_2_5.toFixed(1)} unit="x" hint="for buybacks to match NEAR emission (2.5%)" />
        <Kpi label="At 1.6% emission" value={r.multiple_1_6.toFixed(1)} unit="x" hint="if issuance is cut" />
        <Kpi label="Intents take rate" value={r.take_rate_30d_bp.toFixed(2)} unit="bp" hint="revenue / volume, last 30 days" />
        <Kpi label="NEAR price" value={`$${Number(r.near_price ?? 0).toFixed(2)}`} hint={`snapshot ${String(r.fetched_at).slice(0, 10)}`} />
      </div>

      <div className="grid-2">
        <Card title="Take rate by 12-day block">
          <svg className="bars" viewBox={`0 0 ${blocks.length * 40} 180`} role="img" aria-label="Intents take rate in basis points by 12-day block">
            {blocks.map((b, i) => {
              const h = (b.bp / maxBp) * 140;
              const above = b.bp >= 4;
              return (
                <g key={b.from}>
                  <rect x={i * 40 + 8} y={150 - h} width={24} height={h} rx={3} className={above ? "bar hi" : "bar"} />
                  <text x={i * 40 + 20} y={145 - h} textAnchor="middle" className="bar-label">
                    {b.bp.toFixed(1)}
                  </text>
                  <text x={i * 40 + 20} y={168} textAnchor="middle" className="bar-axis">
                    {b.from.slice(5)}
                  </text>
                </g>
              );
            })}
            <line x1={0} x2={blocks.length * 40} y1={150 - (4 / maxBp) * 140} y2={150 - (4 / maxBp) * 140} className="threshold" />
            <text x={4} y={146 - (4 / maxBp) * 140} className="bar-axis">
              4 bp (P3)
            </text>
          </svg>
          <p className="caption">The take rate jumped from 1.95-3.02 bp in July and August to about 4-5.6 bp since mid-September. P3 bets that the new regime holds.</p>
        </Card>

        <Card title="Pre-registered predictions, 2026-11-01 to 2026-11-12">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th />
                  <th>Predicted</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>P1 · daily Intents volume</td>
                  <td>{p ? `${M(p.P1.low)} to ${M(p.P1.high)}` : "computed when frozen"}</td>
                  <td>{r.P1.status}</td>
                </tr>
                <tr>
                  <td>P2 · Intents revenue / NEAR gas fees</td>
                  <td>{p ? `${p.P2.low.toFixed(1)} to ${p.P2.high.toFixed(1)}` : "computed when frozen"}</td>
                  <td>{r.P2.status}</td>
                </tr>
                <tr>
                  <td>P3 · take rate (tests the thesis)</td>
                  <td>at least 4.0 bp</td>
                  <td>{r.P3.status}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="caption">
            {t.predictionsSha256 ? (
              <>
                Frozen file <code>thesis/predictions.json</code>, sha256 <code className="hash">{t.predictionsSha256}</code>, published on NEAR mainnet in NEAR Social (<code>social.near</code>).
              </>
            ) : (
              <>The predictions are frozen and their sha256 published on mainnet on 2026-10-31, before the window opens.</>
            )}
          </p>
        </Card>
      </div>

      <Card title="How the multiple moves">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="num">Take rate</th>
                <th className="num">Emission</th>
                <th className="num">Intents volume needed per day</th>
                <th className="num">Multiple of today</th>
              </tr>
            </thead>
            <tbody>
              {(r.sensitivity ?? []).map((x: any, i: number) => (
                <tr key={i}>
                  <td className="num">{x.takeRateBp} bp</td>
                  <td className="num">{(x.emission * 100).toFixed(1)}%</td>
                  <td className="num">{M(x.requiredPerDay)}</td>
                  <td className="num">{x.multiple.toFixed(1)}x</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="caption">
          DefiLlama's Intents "revenue" is the fee share captured for NEAR buybacks, not confirmed purchases, and bought-back NEAR offsets emission only if it is burnt or locked. Both caveats are written into the frozen predictions.
        </p>
      </Card>
    </div>
  );
}
