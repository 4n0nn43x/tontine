// The playful layer: leaderboard, levels, badges, cash health, counters, toasts and skeletons.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { achievements, cheerFor, healthOf, levelOf, rankFirms, type Achievement, type Cheer } from "../lib/achievements";
import { marketOf, nameOf, subscribeEvents, type AppState, type ChainEvent, type FirmState } from "../lib/api";
import { ASSETS, firmColor, usdc } from "../lib/format";
import { inMarket, useConfig, useStates, useWallet } from "../lib/hooks";
import { Badge } from "./ui";

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** `digits` fixed decimals, en-US grouping. */
export const fixed = (digits: number) => (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** A number that counts up to its value; with reduced motion, the value at once. */
export function Count({ value, format }: { value: number; format: (n: number) => string }) {
  const [shown, setShown] = useState(() => (reduced() ? value : 0));
  const at = useRef(shown);
  useEffect(() => {
    if (reduced()) {
      at.current = value;
      setShown(value);
      return;
    }
    const from = at.current;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 800);
      at.current = from + (value - from) * (1 - (1 - k) ** 3);
      setShown(at.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format(shown)}</>;
}

export function Skel({ w = "100%", h = 14 }: { w?: number | string; h?: number }) {
  return <span className="skel" style={{ width: w, height: h }} aria-hidden="true" />;
}

/** The firm's level from its fills, with a ring filling up to the next one. */
export function LevelRing({ fills, tint, size = 34 }: { fills: number; tint: string; size?: number }) {
  const { level, into, span, progress } = levelOf(fills);
  const c = 2 * Math.PI * 15;
  const left = span - into;
  const label = `Level ${level}, ${left} more fill${left === 1 ? "" : "s"} to level ${level + 1}`;
  return (
    <span className="lvl" role="img" aria-label={label} title={label} style={{ width: size, height: size, fontSize: size * 0.42, ["--tint" as any]: tint }}>
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle cx="18" cy="18" r="15" className="lvl-track" />
        <circle cx="18" cy="18" r="15" className="lvl-bar" strokeDasharray={`${progress * c} ${c}`} />
      </svg>
      <b aria-hidden="true">{level}</b>
    </span>
  );
}

/** Cash against the floor (a third of the bar): green, amber under 125% of the floor, red under it. */
export function HealthBar({ cash, floor }: { cash: string; floor: bigint }) {
  const c = BigInt(cash);
  const h = healthOf(c, floor);
  const max = floor > 0n ? floor * 3n : c > 0n ? c : 1n;
  const pct = Number(((c > max ? max : c < 0n ? 0n : c) * 1000n) / max) / 10;
  const word = h === "bad" ? "under the floor" : h === "warn" ? "close to the floor" : "healthy";
  return (
    <span
      className={`health ${h}`}
      role="meter"
      aria-label="Cash against the floor"
      aria-valuemin={0}
      aria-valuemax={Number(max) / 1e6}
      aria-valuenow={Math.min(Number(c), Number(max)) / 1e6}
      aria-valuetext={`${usdc(c)} USDC, floor ${usdc(floor, 0)}: ${word}`}
      title={`Cash ${usdc(c)} USDC, floor ${usdc(floor, 0)} USDC: ${word}`}
    >
      <span className="health-fill" style={{ width: `${pct}%` }} />
      <span className="health-floor" />
    </span>
  );
}

/** Small pixel chips; `compact` shows icons only, with the label as a native tooltip. */
export function Achievements({ list, compact = false, focusable = false }: { list: Achievement[]; compact?: boolean; focusable?: boolean }) {
  if (!list.length) return null;
  return (
    <ul className={`achs ${compact ? "compact" : ""}`} aria-label="Badges">
      {list.map((a) => (
        <li
          key={a.id}
          className={`ach ach-${a.id.split("-")[0]}`}
          data-tip={compact ? undefined : a.tip}
          title={compact ? `${a.label}: ${a.tip}` : undefined}
          tabIndex={focusable ? 0 : undefined}
        >
          <i className={`fa-solid ${a.icon}`} aria-hidden="true" />
          {!compact && a.label}
          <span className="sr">{compact ? `${a.label}: ${a.tip}` : `: ${a.tip}`}</span>
        </li>
      ))}
    </ul>
  );
}

export type Ranked = { f: FirmState; rank: number; delta: number; badges: Achievement[] };

/** Each firm's rank when this page was opened, for the arrows (by account: ids repeat across markets). */
const firstRank = new Map<string, number>();

export function useLeaderboard(state: AppState | null, events: ChainEvent[]): Ranked[] | null {
  const last = events.at(-1)?.id;
  return useMemo(() => {
    if (!state) return null;
    const badges = achievements(state.firms, events);
    return rankFirms(state.firms).map((f, i) => {
      if (!firstRank.has(f.account)) firstRank.set(f.account, i + 1);
      return { f, rank: i + 1, delta: firstRank.get(f.account)! - (i + 1), badges: badges.get(f.id) ?? [] };
    });
  }, [state, last]);
}

const MEDALS = ["gold", "silver", "bronze"];
/** A firm that never filled stays off the podium. */
const played = (f: FirmState) => f.fills > 0;

export function Rank({ r }: { r: Ranked }) {
  const medal = played(r.f) && r.rank <= 3 ? MEDALS[r.rank - 1] : "";
  return (
    <span className={`rank ${medal}`}>
      {medal ? <i className="fa-solid fa-medal" aria-hidden="true" /> : null}
      <b>
        <span className="sr">Rank </span>
        {r.rank}
      </b>
      {r.delta !== 0 && (
        <small className={r.delta > 0 ? "up" : "down"} title="Since you opened the page">
          <i className={`fa-solid ${r.delta > 0 ? "fa-caret-up" : "fa-caret-down"}`} aria-hidden="true" />
          <span className="sr">{r.delta > 0 ? "up" : "down"} </span>
          {Math.abs(r.delta)}
        </small>
      )}
    </span>
  );
}

const sign = (v: string) => (BigInt(v) > 0n ? "pos" : BigInt(v) < 0n ? "neg" : "");

export function Leaderboard({ rows, market }: { rows: Ranked[] | null; market?: string }) {
  if (!rows)
    return (
      <div className="skel-rows">
        {Array.from({ length: 6 }, (_, i) => (
          <Skel key={i} h={22} />
        ))}
      </div>
    );
  return (
    <div className="table-wrap">
      <table className="table lb">
        <thead>
          <tr>
            <th>#</th>
            <th>Firm</th>
            <th className="num" title="Gained on its fills">
              Edge
            </th>
            <th className="num hide-m">Fills</th>
            <th className="num hide-m">Dividends</th>
            <th className="num hide-m">Value</th>
            <th className="hide-m">Badges</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const name = nameOf(r.f);
            return (
              <tr key={r.f.id}>
                <td>
                  <Rank r={r} />
                </td>
                <td>
                  <span className="lb-firm">
                    <LevelRing fills={r.f.fills} tint={firmColor(name, r.f.id)} size={26} />
                    <Link className="firm-chip" to={inMarket(`/app/firms/${r.f.id}`, market)}>
                      {name}
                    </Link>
                    {r.f.status !== "Solvent" && <Badge status={r.f.status} />}
                  </span>
                </td>
                <td className={`num ${sign(r.f.edge)}`}>{usdc(r.f.edge, 4)}</td>
                <td className="num hide-m">{r.f.fills}</td>
                <td className="num hide-m">{usdc(r.f.dividends, 4)}</td>
                <td className="num hide-m">{usdc(r.f.nav)}</td>
                <td className="hide-m">
                  <Achievements list={r.badges} compact />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Toasts for the visitor's own wins, from the live event stream. */
export function Toasts() {
  const me = useWallet()?.accountId;
  // Every market's firms and orders, polled only while a demo account is open.
  const states = useStates(!!me);
  const config = useConfig();
  const latest = useRef({ states, config });
  latest.current = { states, config };
  const [list, setList] = useState<(Cheer & { id: number })[]>([]);
  const drop = (id: number) => setList((l) => l.filter((t) => t.id !== id));
  useEffect(() => {
    if (!me) return;
    const clients = new Map<string, string>(); // tender:order id -> client
    const timers: number[] = [];
    const off = subscribeEvents((e) => {
      const key = (id: number) => `${e.contract}:${id}`;
      if (e.event === "order_posted") clients.set(key(e.data.order_id), e.data.client);
      const symbol = marketOf(latest.current.config, e.contract)?.symbol ?? "NEAR";
      const s = latest.current.states[symbol];
      const c = cheerFor(e, me, s?.firms ?? [], (id) => clients.get(key(id)) ?? s?.orders.find((o) => o.id === id)?.client, ASSETS[symbol]);
      if (!c) return;
      setList((l) => [...l.filter((t) => t.id !== e.id), { ...c, id: e.id }].slice(-3));
      timers.push(window.setTimeout(() => drop(e.id), 7000));
    });
    return () => {
      off();
      timers.forEach(clearTimeout);
    };
  }, [me]);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast">
          <span className="toast-icon">
            <i className={`fa-solid ${t.icon}`} aria-hidden="true" />
          </span>
          <div className="toast-text">
            <b>{t.title}</b>
            <span>{t.text}</span>
          </div>
          <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => drop(t.id)}>
            <i className="fa-solid fa-xmark" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
