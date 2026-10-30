import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ChainEvent } from "../lib/api";
import { ago, describe, firmColor } from "../lib/format";
import { announceTx } from "../lib/hooks";

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, unit, hint, icon }: { label: string; value: ReactNode; unit?: string; hint?: ReactNode; icon?: string }) {
  return (
    <div className="kpi">
      <span className="kpi-label">
        {icon && <i className={`fa-solid ${icon}`} aria-hidden="true" />} {label}
      </span>
      <span className="kpi-value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
      {hint && <span className="kpi-hint">{hint}</span>}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  Solvent: "good",
  Illiquid: "warn",
  Liquidating: "bad",
  Bidding: "accent",
  Assigned: "accent",
  Delivered: "accent",
  Paid: "good",
  Rejected: "bad",
  Cancelled: "",
  Disputed: "warn",
  Closed: "",
};

export function Badge({ status, children }: { status?: string; children?: ReactNode }) {
  return <span className={`badge ${STATUS_TONE[status ?? ""] ?? ""}`}>{children ?? status}</span>;
}

export function FirmChip({ id, name, index = 0 }: { id: number; name: string; index?: number }) {
  return (
    <Link className="firm-chip" to={`/app/firms/${id}`}>
      <span className="dot" style={{ background: firmColor(name, index) }} />
      {name}
    </Link>
  );
}

export function Countdown({ until, now }: { until: bigint; now: bigint }) {
  const s = Number((until - now) / 1_000_000_000n);
  if (s <= 0) return <span className="countdown done">0s</span>;
  return <span className="countdown">{s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/** A button that runs one or more transactions and shows their state. */
export function TxButton({ run, children, className = "btn", disabled, onDone }: { run: () => Promise<unknown>; children: ReactNode; className?: string; disabled?: boolean; onDone?: (r: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  return (
    <span className="tx">
      <button
        type="button"
        className={className}
        disabled={disabled || busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          setOk(false);
          try {
            const r = await run();
            setOk(true);
            announceTx();
            onDone?.(r);
            setTimeout(() => setOk(false), 2500);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <i className="fa-solid fa-circle-notch fa-spin" aria-hidden="true" /> : ok ? <i className="fa-solid fa-check" aria-hidden="true" /> : null} {children}
      </button>
      {error && (
        <span className="tx-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

export function EventFeed({ events, firm, limit = 30, compact = false }: { events: ChainEvent[]; firm: (id: number) => string; limit?: number; compact?: boolean }) {
  const rows = events
    .map((e) => ({ e, d: describe(e, firm) }))
    .filter((x) => x.d)
    .slice(-limit)
    .reverse();
  if (!rows.length) return <Empty>Waiting for the next on-chain event…</Empty>;
  return (
    <ol className={`feed ${compact ? "compact" : ""}`}>
      {rows.map(({ e, d }) => (
        <li key={e.id} className={d!.tone}>
          <i className={`fa-solid ${d!.icon}`} aria-hidden="true" />
          <span className="feed-text">
            {d!.jobId !== undefined ? <Link to={`/app/jobs/${d!.jobId}`}>{d!.text}</Link> : d!.text}
          </span>
          <time dateTime={new Date(e.time).toISOString()}>{ago(e.time)}</time>
        </li>
      ))}
    </ol>
  );
}
