import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { SceneView, type SceneApi } from "../components/SceneView";
import { PixelDusk } from "../components/PixelDusk";
import { FailSection, HowSection } from "../components/LandingSections";
import { EventFeed } from "../components/ui";
import { getThesis } from "../lib/api";
import { bpText, regimeSplit, STORM_NOTE, usdc } from "../lib/format";
import { useEvents, useFirmNames, useStats } from "../lib/hooks";
import { PHASES } from "./Dashboard";


const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function CountUp({ to, decimals = 0, suffix = "", delay = 0 }: { to: number; decimals?: number; suffix?: string; delay?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [v, setV] = useState(reduced() ? to : 0);
  useEffect(() => {
    if (reduced()) return setV(to);
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const io = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        io.disconnect();
        const t0 = performance.now() + delay;
        const dur = 1500 + delay / 6;
        const tick = (now: number) => {
          const t = Math.min(1, Math.max(0, (now - t0) / dur));
          setV(to * (1 - Math.pow(1 - t, 3)));
          if (t < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [to, delay]);
  return (
    <span ref={ref}>
      {v.toFixed(decimals)}
      {suffix}
    </span>
  );
}

function SiteHeader() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    document.body.classList.toggle("menu-open", open);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const resize = () => window.innerWidth > 720 && setOpen(false);
    document.addEventListener("keydown", esc);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("keydown", esc);
      window.removeEventListener("resize", resize);
      document.body.classList.remove("menu-open");
    };
  }, [open]);
  const links = (
    <>
      <a href="#how" onClick={() => setOpen(false)}>
        How it works
      </a>
      <a href="#live" onClick={() => setOpen(false)}>
        Live
      </a>
      <a href="#firms" onClick={() => setOpen(false)}>
        Firms
      </a>
      <Link to="/thesis">Thesis</Link>
    </>
  );
  return (
    <>
      <header className="header">
        <Link className="logo" to="/" aria-label="Tontine, home">
          <img src="/assets/logo.svg" alt="" width="52" height="52" />
        </Link>
        <nav className="nav" aria-label="Primary">
          {links}
        </nav>
        <Link className="signin" to="/app">
          Launch app
        </Link>
        <button className="burger" type="button" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} aria-controls="mobile-menu" onClick={() => setOpen(!open)}>
          <span />
          <span />
          <span />
        </button>
      </header>
      {open && (
        <>
          <div className="menu-overlay" onClick={() => setOpen(false)} />
          <nav className="mobile-menu" id="mobile-menu" aria-label="Mobile">
            {links}
            <Link className="mobile-signin" to="/app">
              Launch app
            </Link>
          </nav>
        </>
      )}
    </>
  );
}

function Hero() {
  const scene = useRef<SceneApi | null>(null);
  const [lines, setLines] = useState<{ text: string; kind: string; id: number }[]>([]);
  const [phase, setPhase] = useState(-1);
  const [exploring, setExploring] = useState(false);
  const [paused, setPaused] = useState(false);
  const [multiple, setMultiple] = useState(5.4);
  const copy = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => void getThesis().then((t) => t.result?.multiple_2_5 && setMultiple(Number(t.result.multiple_2_5.toFixed(1))), () => {}), []);

  const measure = useCallback(() => {
    const api = scene.current;
    const root = copy.current;
    if (!api || !root) return;
    const q = (s: string) => root.querySelector(s)!.getBoundingClientRect();
    const hero = root.closest(".hero-section")!.getBoundingClientRect();
    const parts = [".headline", ".subhead", ".hero-ctas"].map(q);
    const rel = (v: number, o: number) => v - o;
    api.setHorizon((rel(q(".headline").top, hero.top) - 16) / hero.height);
    api.setCalmRect({
      left: Math.min(...parts.map((r) => r.left)) - hero.left,
      right: Math.max(...parts.map((r) => r.right)) - hero.left,
      top: Math.min(...parts.map((r) => r.top)) - hero.top,
      bottom: Math.max(...parts.map((r) => r.bottom)) - hero.top,
    });
  }, []);

  useEffect(() => {
    const t = setTimeout(measure, 1200);
    window.addEventListener("resize", measure);
    document.fonts?.ready.then(measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  useEffect(() => {
    scene.current?.setExplore(exploring);
    document.body.classList.toggle("exploring", exploring);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setExploring(false);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("keydown", esc);
      document.body.classList.remove("exploring");
    };
  }, [exploring]);

  useEffect(() => scene.current?.setPaused(paused), [paused]);

  return (
    <section className="hero-section">
      <SceneView
        mode="replay"
        className="hero-scene"
        onReady={(api) => {
          scene.current = api;
          measure();
        }}
        onLedger={(e) => setLines((cur) => [...cur, { ...e, id: ++seq.current }].slice(-12))}
        onPhase={setPhase}
        fallback={<PixelDusk className="bg-video" />}
      />
      <div className="bg-scrim" />

      <div className="page">
        <SiteHeader />
        <div className="hero" ref={copy}>
          <h1 className="headline">
            <span>The Firm Layer</span>
            <span>Of The Agent Economy</span>
          </h1>
          <p className="subhead anim" style={{ ["--d" as any]: "0.28s" }}>
            AI agents make markets. Tontine lets you own them: AI market-making firms with shares and dividends that quote NEAR swaps by sealed bid, go bankrupt and get bought by their rivals, all settled on NEAR.
          </p>
          <div className="hero-ctas anim" style={{ ["--d" as any]: "0.4s" }}>
            <Link className="cta" to="/app">
              Launch the app
            </Link>
            <button className="cta ghost" type="button" onClick={() => setExploring(true)}>
              Watch the swarm
            </button>
          </div>
        </div>

        <section className="stats" aria-label="Key figures">
          <div className="stat anim" style={{ ["--d" as any]: "0.5s" }}>
            <span className="stat-icon" aria-hidden="true">
              #
            </span>
            <span className="stat-value">
              <CountUp to={100} delay={480} />
            </span>
            <span className="stat-label">Shares in every AI firm, tradable</span>
          </div>
          <div className="stat anim" style={{ ["--d" as any]: "0.58s" }}>
            <span className="stat-icon" aria-hidden="true">
              %
            </span>
            <span className="stat-value">
              <CountUp to={30} suffix="%" delay={570} />
            </span>
            <span className="stat-label">Of each fill's edge paid as dividends</span>
          </div>
          <div className="stat anim" style={{ ["--d" as any]: "0.66s" }}>
            <span className="stat-icon" aria-hidden="true">
              *
            </span>
            <span className="stat-value">
              <CountUp to={2} suffix="nd" delay={660} />
            </span>
            <span className="stat-label">Best quote wins, delivers the second best</span>
          </div>
          <div className="stat anim" style={{ ["--d" as any]: "0.74s" }}>
            <span className="stat-icon" aria-hidden="true">
              $
            </span>
            <span className="stat-value">
              <CountUp to={multiple} decimals={1} suffix="x" delay={740} />
            </span>
            <span className="stat-label">Intents volume to offset NEAR emission</span>
          </div>
        </section>
      </div>

      <aside className="ledger" aria-label="Replay of make demo">
        <div className="ledger-head">
          <span className="ledger-dot" aria-hidden="true" />
          <span>
            Replay of <code>make demo</code> · <Link to="/app">watch it live</Link>
          </span>
        </div>
        <ol className="phases" aria-label="Lifecycle">
          {PHASES.map((p, i) => (
            <li key={p} className={i === phase ? "now" : phase >= 0 && i < phase ? "done" : ""}>
              {p}
            </li>
          ))}
        </ol>
        <ol className="ledger-lines" aria-live={exploring ? "polite" : "off"}>
          {lines.map((l) => (
            <li key={l.id} className={l.kind} dangerouslySetInnerHTML={{ __html: l.text }} />
          ))}
        </ol>
      </aside>

      {exploring && (
        <button className="explore-exit" type="button" onClick={() => setExploring(false)} autoFocus>
          <i className="fa-solid fa-arrow-left" aria-hidden="true" /> Back
        </button>
      )}
      <button className="motion-toggle" type="button" aria-pressed={paused} aria-label={paused ? "Play the animation" : "Pause the animation"} onClick={() => setPaused(!paused)}>
        <i className={`fa-solid ${paused ? "fa-play" : "fa-pause"}`} aria-hidden="true" />
      </button>
      <a className="scroll-cue" href="#how" aria-label="Scroll to how it works">
        <i className="fa-solid fa-chevron-down" aria-hidden="true" />
      </a>
    </section>
  );
}

export function Landing() {
  // The feed spans every market: names are resolved on the tender of each event.
  const { data: stats } = useStats();
  const firmName = useFirmNames();
  const events = useEvents(40);

  return (
    <div className="landing">
      <Hero />

      <HowSection />
      <FailSection />

      <PixelDusk sun={false} className="band" />

      <section id="live" className="section">
        <p className="eyebrow">
          <span className="live-dot" aria-hidden="true" /> Market activity
        </p>
        <h2 className="section-title">
          The market, as it happens
        </h2>
        {stats ? (
          <div className="live-grid">
            <div className="live-kpis">
              <div>
                <span className="big-num">{stats.fills}</span>
                <span>orders filled</span>
              </div>
              <div>
                <span className="big-num">{usdc(stats.volume)}</span>
                <span>USDC of volume</span>
              </div>
              <div>
                <span className="big-num">{stats.fills ? bpText(stats.improvementBps / stats.fills) : "–"}</span>
                <span>over the market reference, on average</span>
                {regimeSplit(stats.byRegime) && (
                  <small className="regime-split" title={STORM_NOTE}>
                    {regimeSplit(stats.byRegime)}
                  </small>
                )}
              </div>
              <div>
                <span className="big-num">{stats.takeovers}</span>
                <span>takeovers</span>
              </div>
            </div>
            <div className="live-feed">
              <EventFeed events={events} firm={firmName} limit={7} compact />
            </div>
          </div>
        ) : (
          <p className="muted">The live market runs on the Tontine server (<code>make serve</code>). This page also works without it: the hero above replays a recorded run.</p>
        )}
        <div className="section-ctas">
          <Link className="cta" to="/app">
            Open the dashboard
          </Link>
          <Link className="cta ghost" to="/app/trade">
            Trade NEAR, ETH, SOL
          </Link>
        </div>
      </section>

      <section id="firms" className="section">
        <p className="eyebrow">Own a firm</p>
        <h2 className="section-title">Own the firm, not the trade</h2>
        <div className="anatomy">
          <article>
            <i className="fa-solid fa-chart-pie" aria-hidden="true" />
            <h3>100 shares per firm</h3>
            <p>Every firm is split into 100 NEP-245 shares. Anyone can launch a firm for 3 NEAR, list its shares at a chosen price, and buy, sell or transfer them.</p>
          </article>
          <article>
            <i className="fa-solid fa-coins" aria-hidden="true" />
            <h3>30% of each fill's edge</h3>
            <p>A fill's edge is what the firm gained on it, valued at the previous clearing price. 30% of it goes to the shareholders at once, per share, claimable at any time.</p>
          </article>
          <article>
            <i className="fa-solid fa-building-columns" aria-hidden="true" />
            <h3>Lend at the owner's rate</h3>
            <p>A firm borrows at the yearly rate its owner sets. Lenders earn the interest and are repaid before shareholders in a liquidation.</p>
          </article>
          <article>
            <i className="fa-solid fa-lock" aria-hidden="true" />
            <h3>Locked down by contract</h3>
            <p>A firm account has no full access key. Its agent can only quote and settle, its owner's price band and NEAR limit are checked on every quote, and every spend is capped by its on-chain budget.</p>
          </article>
        </div>
      </section>

      <section id="thesis" className="section split">
        <div>
          <p className="eyebrow">The thesis</p>
          <h2 className="section-title">NEAR captures agent value through Intents, not gas</h2>
          <p className="lead">
            Intents fees fund NEAR buybacks. We compute the volume needed for them to match NEAR's emission, and we publish predictions that can be wrong before the data comes in.
          </p>
          <Link className="cta ghost" to="/thesis">
            Read the thesis
          </Link>
        </div>
        <ThesisTeaser />
      </section>

      <section id="security" className="section">
        <p className="eyebrow">Verified, not claimed</p>
        <h2 className="section-title">Every claim has a test, a command or a transaction</h2>
        <ul className="proofs">
          <li>
            <i className="fa-solid fa-bug" aria-hidden="true" />
            <span>A self-audit and an independent review found two Highs, seven Mediums and four Lows; all fixed, each with a proof of concept run before and after.</span>
          </li>
          <li>
            <i className="fa-solid fa-cubes" aria-hidden="true" />
            <span>Payments run through the exact <code>intents.near</code> code deployed on mainnet, in every test run.</span>
          </li>
          <li>
            <i className="fa-solid fa-fingerprint" aria-hidden="true" />
            <span>Contracts are built reproducibly in a pinned image, so their code hash can be checked against the source.</span>
          </li>
          <li>
            <i className="fa-solid fa-list-check" aria-hidden="true" />
            <span><code>make demo</code> replays the whole economy on a local chain: 27 on-chain checks, no keys, no funds.</span>
          </li>
        </ul>
      </section>

      <section id="build" className="section split">
        <div>
          <p className="eyebrow">Open market</p>
          <h2 className="section-title">Run your own firm</h2>
          <p className="lead">A firm's strategy is one file: its spread from the mid, the NEAR share it aims for, and optionally its own quote. Plug it in and it joins the swarm against the house firms.</p>
          <Link className="cta ghost" to="/app/firms">
            Meet the firms
          </Link>
        </div>
        <pre className="code">{`export default defineFirm({
  spec: { name: "My Maker", description: "...",
          skills: ["NEAR/USDC"] },
  // quote 9 bp from the market mid, keep 40% in NEAR
  params: { spreadBps: 9, targetAssetShare: 0.4,
            skewBps: 25 },
  // what it delivers for an order, or null to pass
  quote: (order, me, market, params) =>
    defaultQuote(order, me, market, params),
});`}</pre>
      </section>

      <footer className="landing-foot">
        <PixelDusk />
        <div className="foot-inner">
          <div className="foot-cta">
            <h2 className="section-title">Trade against the firms</h2>
            <p className="lead">Post a NEAR, ETH or SOL order, watch the firms quote for it, and own a share of the winners.</p>
            <div className="section-ctas">
              <Link className="cta" to="/app/trade">
                Trade NEAR, ETH, SOL
              </Link>
              <Link className="cta ghost" to="/app">
                Open the dashboard
              </Link>
            </div>
          </div>
          <nav className="foot-cols" aria-label="Footer">
            <div>
              <h3>Market</h3>
              <Link to="/app">Dashboard</Link>
              <Link to="/app/orders">Orders</Link>
              <Link to="/app/firms">Firms</Link>
              <Link to="/app/portfolio">Portfolio</Link>
            </div>
            <div>
              <h3>Learn</h3>
              <a href="#how">How it works</a>
              <a href="#firms">Own a firm</a>
              <a href="#security">Proofs</a>
              <Link to="/thesis">Thesis</Link>
            </div>
          </nav>
          <div className="foot-base">
            <span className="foot-brand">
              <img src="/assets/logo.svg" alt="" width="22" height="22" /> Tontine
            </span>
            <span>AI market-making firms, settled on NEAR</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function ThesisTeaser() {
  const [r, setR] = useState<any>(null);
  useEffect(() => void getThesis().then((t) => setR(t.result), () => {}), []);
  if (!r) return <div className="teaser" />;
  return (
    <div className="teaser">
      <div className="teaser-num">
        <span className="big-num">{r.multiple_2_5.toFixed(1)}x</span>
        <span>the current Intents volume for buybacks to match NEAR emission</span>
      </div>
      <dl className="teaser-list">
        <dt>Take rate, last 30 days</dt>
        <dd>{r.take_rate_30d_bp.toFixed(2)} bp</dd>
        <dt>P3, the prediction that tests it</dt>
        <dd>at least 4 bp from Nov 1 to 12</dd>
        <dt>Status</dt>
        <dd>{r.P3.status}</dd>
      </dl>
    </div>
  );
}
