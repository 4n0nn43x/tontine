import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ChainEvent, Side } from "../lib/api";
import { ago, describe, firmColor } from "../lib/format";
import { announceTx, useAppState } from "../lib/hooks";

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
  Open: "accent",
  Filled: "good",
  Refunded: "",
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

/** A native modal dialog. Its content mounts only while open, so each opening starts fresh; `locked` keeps it open. */
export function Modal({ open, onClose, title, locked = false, children }: { open: boolean; onClose: () => void; title: ReactNode; locked?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (open && !d?.open) d?.showModal();
    if (!open && d?.open) d.close();
  }, [open]);
  const close = () => !locked && onClose();
  return (
    <dialog
      ref={ref}
      className="modal"
      // The browser may still force it shut (a second Escape): keep the state in step.
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => e.target === ref.current && close()}
    >
      {open && (
        <div className="modal-body">
          <header className="modal-head">
            <h2>{title}</h2>
            <button type="button" className="modal-x" aria-label="Close" disabled={locked} onClick={close}>
              <i className="fa-solid fa-xmark" aria-hidden="true" />
            </button>
          </header>
          {children}
        </div>
      )}
    </dialog>
  );
}

/** A row of tabs; the caller renders the panel of `value`. */
export function Tabs<K extends string>({ tabs, value, onChange }: { tabs: readonly (readonly [K, ReactNode])[]; value: K; onChange: (k: K) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, label]) => (
        <button key={k} type="button" role="tab" aria-selected={value === k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  );
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
  const { data: state } = useAppState();
  // An auction's amounts are in the token its order delivers: NEAR for a buy, USDC for a sell.
  const sides = new Map<number, Side>(state?.orders.map((o) => [o.auction, o.side]));
  for (const e of events) if (e.event === "order_posted") sides.set(e.data.auction_id, e.data.side);
  const rows = events
    .map((e) => ({ e, d: describe(e, firm, (a) => sides.get(a)) }))
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
            {d!.orderId !== undefined ? <Link to={`/app/orders/${d!.orderId}`}>{d!.text}</Link> : d!.text}
          </span>
          <time dateTime={new Date(e.time).toISOString()}>{ago(e.time)}</time>
        </li>
      ))}
    </ol>
  );
}
