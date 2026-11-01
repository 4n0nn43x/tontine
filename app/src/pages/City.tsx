import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { SceneView, type SceneApi } from "../components/SceneView";
import { Achievements, LevelRing } from "../components/Game";
import { Badge, EventFeed } from "../components/ui";
import { achievements } from "../lib/achievements";
import { RegimeChip } from "../components/Ai";
import { worstRegime } from "../lib/ai";
import { nameOf, regimeOf, SYMBOLS } from "../lib/api";
import { amount, ASSETS, digitsOf, firmColor, usdc } from "../lib/format";
import { firmNameIn, inTender, useAppState, useConfig, useEvents, useStates } from "../lib/hooks";
import { cityFirms, cityId, cityLink, cityMarket, liveDriver } from "../lib/live";

/** The live city full screen (opened from the dashboard in its own tab): every market's firms; click a tower to see one. */
export function City() {
  const states = useStates();
  const { error } = useAppState();
  const config = useConfig();
  const scene = useRef<SceneApi | null>(null);
  const driver = useRef<((e: any) => void) | null>(null);
  const latest = useRef({ states, config });
  latest.current = { states, config };
  const firmName = (id: number, contract: string) => firmNameIn(latest.current.states, latest.current.config)(id, contract);
  const events = useEvents(60, (e) => driver.current?.(e));
  const ready = SYMBOLS.every((s) => states[s]);
  const firmNames = useMemo(() => (ready ? cityFirms(states).map((f) => f.name) : null), [ready]);
  const [picked, setPicked] = useState<number | string | null>(null);
  const [pointer, setPointer] = useState(false);
  // The picked tower's firm and market (city ids are "ETH:3" outside NEAR).
  const pick = SYMBOLS.flatMap((s) => (states[s]?.firms ?? []).map((f) => ({ f, s }))).find((x) => cityId(x.f.id, x.s) === picked) ?? null;
  const firm = pick?.f ?? null;
  const asset = ASSETS[pick?.s ?? "NEAR"];
  const tender = config?.markets.find((m) => m.symbol === pick?.s)?.tender;

  useEffect(() => {
    document.title = "Tontine City";
  }, []);
  useEffect(() => {
    if (ready) scene.current?.setFirms(cityFirms(states), cityMarket(states.NEAR));
  }, [states.NEAR, states.ETH, states.SOL]);
  // The worst market regime is the weather; the chip names it, the canvas is decoration.
  const weather = worstRegime(states);
  const worst = SYMBOLS.find((s) => regimeOf(states[s])?.level === weather) ?? "NEAR";
  useEffect(() => scene.current?.setWeather(weather), [weather]);

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
          api.setFirms(cityFirms(latest.current.states), cityMarket(latest.current.states.NEAR));
          api.setWeather(worstRegime(latest.current.states));
        }}
        fallback={<p className="city-empty">The city needs a canvas. <Link to="/app">Open the dashboard</Link>.</p>}
      />

      <header className="city-head" onClick={(e) => e.stopPropagation()}>
        <Link className="logo small" to="/app" aria-label="Tontine dashboard">
          <img src="/assets/logo.svg" alt="" width="28" height="28" />
        </Link>
        <h1>Tontine City</h1>
        <span className={`netbadge ${error ? "down" : ready ? "up" : ""}`}>
          <span className="live-dot" aria-hidden="true" /> {error ? "offline" : "live devnet"}
        </span>
        {weather !== "calm" && <RegimeChip symbol={worst} regime={regimeOf(states[worst])} />}
      </header>

      <aside className="city-feed" aria-label="Latest on-chain events" onClick={(e) => e.stopPropagation()}>
        <EventFeed events={events} firm={firmName} limit={5} compact />
      </aside>

      {firm && pick ? (
        <aside className="city-firm" aria-live="polite" onClick={(e) => e.stopPropagation()}>
          <header>
            <LevelRing fills={firm.fills} tint={firmColor(nameOf(firm), firm.id)} size={28} />
            <h2>
              {nameOf(firm)} <span className="mk-tag">{pick.s}</span>
            </h2>
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
            <dt>{asset.symbol}</dt>
            <dd>{amount(firm.inventory, asset.decimals, digitsOf(asset))}</dd>
            <dt>Fills</dt>
            <dd>{firm.fills}</dd>
            <dt>Edge</dt>
            <dd>{usdc(firm.edge, 4)} USDC</dd>
            <dt>Dividends</dt>
            <dd>{usdc(firm.dividends, 4)} USDC</dd>
            <dt>Takeovers</dt>
            <dd>{firm.takeovers}</dd>
          </dl>
          <Achievements list={achievements(states[pick.s]?.firms ?? [], events.filter((e) => inTender(e, tender))).get(firm.id) ?? []} />
          <a className="btn small" href={cityLink(picked!)} target="_blank" rel="noopener">
            Open the firm <i className="fa-solid fa-up-right-from-square" aria-hidden="true" />
          </a>
        </aside>
      ) : (
        <p className="city-hint">Click a tower to see its firm.</p>
      )}
    </div>
  );
}
