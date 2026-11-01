// The AI layer in the app: the market regime, a firm's due diligence, its mandate, and its manager against
// the stated rule on the same auctions (ts/src/server.ts, AI section).
import { useEffect, useState } from "react";
import { getMandate, getReport, getShadow, postMandate, specOf, type FirmState, type MarketSymbol, type RegimeLevel, type RegimeState } from "../lib/api";
import { ruleText, verdict } from "../lib/ai";
import { usdc } from "../lib/format";
import { tenderCall, type Wallet } from "../lib/near";
import { Skel } from "./Game";
import { Card, TxButton } from "./ui";
import "../styles/ai.css";

/** `load()` now and every `ms`; null until it answers (and for good if it fails: not for this firm). */
function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[]): [T | null, () => void] {
  const [value, setValue] = useState<T | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = () => load().then((v) => alive && setValue(v), () => {});
    void run();
    const t = window.setInterval(run, ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [...deps, tick]);
  useEffect(() => setValue(null), deps);
  return [value, () => setTick((n) => n + 1)];
}

const REGIME_ICON: Record<RegimeLevel, string> = { calm: "fa-moon", alert: "fa-cloud", storm: "fa-cloud-bolt" };

/** A market's regime as a small chip; its top reason in the tooltip. */
export function RegimeChip({ symbol, regime }: { symbol: string; regime: RegimeState | null }) {
  if (!regime) return null;
  const tip = `${symbol} ${regime.level} since ${new Date(regime.since).toLocaleTimeString()}${regime.reasons[0] ? `: ${regime.reasons[0]}` : ""} (${regime.source})`;
  return (
    <span className={`regime ${regime.level}`} title={tip} aria-label={tip} tabIndex={0}>
      <i className={`fa-solid ${REGIME_ICON[regime.level]}`} aria-hidden="true" /> {symbol} {regime.level}
    </span>
  );
}

/** Grade, score and its three strongest components, then the note: by the LLM (checked against the facts) or the template. */
export function DueDiligenceCard({ symbol, firmId }: { symbol: MarketSymbol; firmId: number }) {
  const [r] = usePoll(() => getReport(symbol, firmId), 60_000, [symbol, firmId]);
  const source = !r ? null : r.source === "llm" ? (r.signature ? "LLM, TEE receipt" : "LLM") : "template";
  const tip = !r ? "" : r.source === "llm" ? `Written by the LLM, every number checked against the facts${r.chatId ? ` (${r.chatId})` : ""}` : r.rejected ? `LLM note refused (${r.rejected}): the template wrote it` : "No LLM: the template wrote it";
  return (
    <Card title="Due diligence" className="ai-card" action={source && <span className={`src-chip ${r!.source}`} title={tip}>{source}</span>}>
      {!r ? (
        <Skel h={90} />
      ) : (
        <>
          <div className="dd">
            <b className={`dd-grade g-${r.grade}`} aria-label={`Grade ${r.grade}`}>
              {r.grade}
            </b>
            <div className="dd-body">
              <span className="dd-score">
                <b>{r.score}</b> / 100
              </span>
              <ul className="dd-parts">
                {[...r.components]
                  .filter((c) => c.value !== null)
                  .sort((a, b) => b.points - a.points)
                  .slice(0, 3)
                  .map((c) => (
                    <li key={c.key}>
                      <span title={`${c.points} points of the score, weight ${c.weight}`}>{c.label}</span>
                      <span className="bar">
                        <i style={{ width: `${(c.value ?? 0) * 100}%` }} />
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          </div>
          <p className="dd-text">{r.text}</p>
        </>
      )}
    </Card>
  );
}

const ARM_ROWS = [
  ["actual", "Actual"],
  ["rule", "Stated rule"],
  ["fixed", "Fixed params"],
] as const;

/** The firm's actual bids against the stated rule's and its fixed starting params', replayed on the same auctions. */
export function AiVsRuleCard({ symbol, firmId }: { symbol: MarketSymbol; firmId: number }) {
  const [s] = usePoll(() => getShadow(symbol, firmId), 15_000, [symbol, firmId]);
  if (!s || s.manager === "none") return null;
  const best = ARM_ROWS.map(([k]) => k).reduce((a, b) => (BigInt(s.arms[b].edge) > BigInt(s.arms[a].edge) ? b : a), "actual" as const);
  return (
    <Card title="AI vs rule" className="ai-card" action={<span className="card-note">{s.manager === "llm" ? "LLM" : s.manager} manager</span>}>
      <table className="table vs">
        <thead>
          <tr>
            <th />
            <th className="num">Wins</th>
            <th className="num">Edge, USDC</th>
          </tr>
        </thead>
        <tbody>
          {ARM_ROWS.map(([k, label]) => (
            <tr key={k} className={k === best && BigInt(s.arms[k].edge) !== 0n ? "best" : ""}>
              <td>{label}</td>
              <td className="num">
                {s.arms[k].wins}/{s.arms[k].auctions}
              </td>
              <td className="num">{usdc(s.arms[k].edge, 4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="verdict" title="Shadow quotes: each arm's bid replayed against the bids rivals revealed, which are kept as they were.">
        {verdict(s)}
      </p>
    </Card>
  );
}

const SOURCE_LABEL = { llm: "read by the LLM", pattern: "read by the pattern parser", none: "no rule" };

/** The owner's instructions, their compiled rules (active ones lit), and for the owner a small editor. */
export function MandateCard({ symbol, firm, wallet, isOwner }: { symbol: MarketSymbol; firm: FirmState; wallet: Wallet | null; isOwner: boolean }) {
  const [m, reload] = usePoll(() => getMandate(symbol, firm.id), 15_000, [symbol, firm.id]);
  const [draft, setDraft] = useState<string | null>(null);
  if (!m) return null;
  // The mandate goes in the firm's profile (only its owner can write it), then the server compiles what is there.
  const save = async () => {
    const text = draft!.trim();
    await tenderCall(wallet!, "set_firm_profile", { firm_id: firm.id, profile: JSON.stringify({ ...specOf(firm), mandate: text }) }, symbol);
    await postMandate(symbol, firm.id, text);
    setDraft(null);
    reload();
  };
  return (
    <Card
      title="Mandate"
      className="ai-card"
      action={
        isOwner && wallet && draft === null ? (
          <button type="button" className="btn small" onClick={() => setDraft(m.text)}>
            <i className="fa-solid fa-pen" aria-hidden="true" /> Edit
          </button>
        ) : (
          <span className="card-note" title={m.signed ? "The LLM's answer is TEE-signed" : undefined}>
            {SOURCE_LABEL[m.source]}
          </span>
        )
      }
    >
      {draft !== null ? (
        <div className="mandate-edit">
          <textarea value={draft} maxLength={500} rows={3} onChange={(e) => setDraft(e.target.value)} aria-label="Mandate, in plain words" placeholder={`Pause if ${symbol} drops 5% in an hour. Never hold more than 40% in ${symbol}.`} />
          <div className="inline">
            <span className="fine">{draft.length}/500, published in the firm's profile</span>
            <TxButton className="btn small primary" run={save}>
              Save
            </TxButton>
            <button type="button" className="btn small" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : m.text ? (
        <blockquote className="mandate-text">{m.text}</blockquote>
      ) : (
        <p className="muted">No mandate yet.</p>
      )}
      {m.rules.length > 0 && (
        <ul className="rule-chips" aria-label="Compiled rules">
          {m.rules.map((r, i) => (
            <li key={i} className={`${m.active.includes(i) ? "on" : ""} ${r.note.startsWith("House default") ? "house" : ""}`} title={r.note}>
              {m.active.includes(i) && <span className="sr">active: </span>}
              {ruleText(r, symbol)}
            </li>
          ))}
        </ul>
      )}
      {m.dropped.length > 0 && (
        <details className="fine">
          <summary>{m.dropped.length} part{m.dropped.length === 1 ? "" : "s"} not understood</summary>
          <ul>
            {m.dropped.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
