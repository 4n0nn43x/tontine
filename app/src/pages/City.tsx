import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { SceneView, type SceneApi } from "../components/SceneView";
import { Badge, EventFeed } from "../components/ui";
import { nameOf } from "../lib/api";
import { near, usdc } from "../lib/format";
import { useAppState, useEvents } from "../lib/hooks";
import { cityFirms, cityMarket, liveDriver } from "../lib/live";

/** The live city full screen (opened from the dashboard in its own tab): click a tower to see its firm. */
export function City() {
  const { data: state, error } = useAppState();
  const scene = useRef<SceneApi | null>(null);
  const driver = useRef<((e: any) => void) | null>(null);
  const latest = useRef(state);
  latest.current = state;
  const firmName = (id: number) => nameOf(latest.current?.firms.find((x) => x.id === id), id);
  const events = useEvents(60, (e) => driver.current?.(e));
  const firmNames = useMemo(() => state?.firms.map((f) => nameOf(f)) ?? null, [state === null]);
  const [picked, setPicked] = useState<number | null>(null);
  const [pointer, setPointer] = useState(false);
  const firm = state?.firms.find((f) => f.id === picked) ?? null;

  useEffect(() => {
    document.title = "Tontine City";
  }, []);
  useEffect(() => {
    if (state) scene.current?.setFirms(cityFirms(state), cityMarket(state));
  }, [state]);

  return (
    <div
      className={`city-page ${pointer ? "pointer" : ""}`}
      onClick={(e) => setPicked(scene.current?.pick(e.clientX, e.clientY)?.id ?? null)}
      onMouseMove={(e) => {
        scene.current?.setParallax((e.clientX / window.innerWidth) * 2 - 1);
        setPointer(!!scene.current?.pick(e.clientX, e.clientY));
      }}
    >
      <SceneView
        mode="live"
        className="city-scene"
        firmNames={firmNames}
        onReady={(api) => {
          scene.current = api;
          if (import.meta.env.DEV) (window as any).__city = api; // QA from the console with `make app-dev`
          api.setExplore(true);
          driver.current = liveDriver(api, firmName);
          if (latest.current) api.setFirms(cityFirms(latest.current), cityMarket(latest.current));
        }}
        fallback={<p className="city-empty">The city needs a canvas. <Link to="/app">Open the dashboard</Link>.</p>}
      />

      <header className="city-head" onClick={(e) => e.stopPropagation()}>
        <Link className="logo small" to="/app" aria-label="Tontine dashboard">
          <img src="/assets/logo.svg" alt="" width="28" height="28" />
        </Link>
        <h1>Tontine City</h1>
        <span className={`netbadge ${error ? "down" : state ? "up" : ""}`}>
          <span className="live-dot" aria-hidden="true" /> {error ? "offline" : "live devnet"}
        </span>
      </header>

      <aside className="city-feed" aria-label="Latest on-chain events" onClick={(e) => e.stopPropagation()}>
        <EventFeed events={events} firm={firmName} limit={5} compact />
      </aside>

      {firm ? (
        <aside className="city-firm" aria-live="polite" onClick={(e) => e.stopPropagation()}>
          <header>
            <h2>{nameOf(firm)}</h2>
            <Badge status={firm.status} />
            <button className="city-close" aria-label="Close" onClick={() => setPicked(null)}>
              <i className="fa-solid fa-xmark" aria-hidden="true" />
            </button>
          </header>
          <dl>
            <dt>Share</dt>
            <dd>{usdc(BigInt(firm.nav) / 100n, 4)} USDC</dd>
            <dt>Value</dt>
            <dd>{usdc(firm.nav)} USDC</dd>
            <dt>Cash</dt>
            <dd>{usdc(firm.treasury)} USDC</dd>
            <dt>NEAR</dt>
            <dd>{near(firm.inventory)}</dd>
            <dt>Fills</dt>
            <dd>{firm.fills}</dd>
            <dt>Edge</dt>
            <dd>{usdc(firm.edge, 4)} USDC</dd>
            <dt>Dividends</dt>
            <dd>{usdc(firm.dividends, 4)} USDC</dd>
            <dt>Takeovers</dt>
            <dd>{firm.takeovers}</dd>
          </dl>
          <a className="btn small" href={`/app/firms/${firm.id}`} target="_blank" rel="noopener">
            Open the firm <i className="fa-solid fa-up-right-from-square" aria-hidden="true" />
          </a>
        </aside>
      ) : (
        <p className="city-hint">Click a tower to see its firm.</p>
      )}
    </div>
  );
}
