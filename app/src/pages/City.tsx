import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { PlazaApi, PlazaFirm } from "../scene/plaza";
import { Badge, EventFeed } from "../components/ui";
import { LevelRing } from "../components/Game";
import { getQuote, marketOf, nameOf, regimeOf, SYMBOLS, type AppState, type ChainEvent, type FirmState, type MarketSymbol } from "../lib/api";
import { announceTx, firmNameIn, useConfig, useEvents, useStates, useWallet } from "../lib/hooks";
import { createWallet, postOrder } from "../lib/near";
import { ASSETS, auctionAmount, firmColor, usdc } from "../lib/format";
import { BADGES, loadPlayer, oddsOf, Sealed, STAKES, type Round } from "../lib/sealed";
import "../styles/city.css";

const STORE = "tontine.sealed";
const today = () => new Date().toISOString().slice(0, 10);
const keyOf = (m: MarketSymbol, id: number) => `${m}:${id}`;
const idOf = (key: string) => Number(key.split(":")[1]);
const marketOfKey = (key: string) => key.split(":")[0] as MarketSymbol;
const REGIME_ICON = { calm: "fa-sun", alert: "fa-cloud-sun", storm: "fa-cloud-bolt" } as const;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isMobile = () => window.matchMedia("(max-width: 720px), (pointer: coarse)").matches;

/** Tiny synthesized cues (no audio files); off until the visitor turns sound on. */
let audio: AudioContext | null = null;
function cue(kind: "commit" | "reveal" | "win" | "lose" | "order") {
  audio ??= new AudioContext();
  const [f, f2, len, type] = ({ commit: [660, 880, 0.08, "triangle"], reveal: [300, 900, 0.25, "sawtooth"], win: [523, 1047, 0.5, "triangle"], lose: [220, 110, 0.35, "sine"], order: [440, 520, 0.12, "sine"] } as const)[kind];
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, audio.currentTime);
  o.frequency.exponentialRampToValueAtTime(f2, audio.currentTime + len);
  g.gain.setValueAtTime(0.08, audio.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + len);
  o.connect(g).connect(audio.destination);
  o.start();
  o.stop(audio.currentTime + len);
}

/** The firms as the scene draws them: rank by value within each market. */
function plazaFirms(states: Record<MarketSymbol, AppState | null>): PlazaFirm[] {
  return SYMBOLS.flatMap((m) => {
    const firms = states[m]?.firms ?? [];
    const order = [...firms].sort((a, b) => Number(BigInt(b.nav) - BigInt(a.nav)));
    return firms.map((f, i) => ({ key: keyOf(m, f.id), market: m, name: nameOf(f), color: firmColor(nameOf(f), i), nav: Number(f.nav) / 1e6, fills: f.fills, status: f.status, rank: order.indexOf(f) + 1 }));
  });
}

/** Seconds left to back a firm: the order's commit end against the chain clock the state last saw. */
function secondsLeft(r: Round, s: AppState | null): number | null {
  const o = s?.orders.find((x) => x.id === r.order);
  if (!o || !s) return null;
  const now = BigInt(s.chainTime) + BigInt(Date.now() - s.updatedAt) * 1_000_000n;
  return Math.max(0, Math.ceil(Number(BigInt(o.auctionState.commit_end) - now) / 1e9));
}

/** SEALED, the live city: every auction is a round; back the firm you think wins before the bids open. */
export function City() {
  const states = useStates();
  const config = useConfig();
  const wallet = useWallet();
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<PlazaApi | null>(null);
  const game = useRef(new Sealed(loadPlayer(localStorage.getItem(STORE), today())));
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  const latest = useRef({ states, config, wallet, sound: false });
  const [sound, setSound] = useState(() => localStorage.getItem(`${STORE}.sound`) === "1");
  latest.current = { states, config, wallet, sound };
  const [failed, setFailed] = useState(false);
  const [focus, setFocus] = useState<MarketSymbol | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [choice, setChoice] = useState<number | null>(null);
  const [stake, setStake] = useState<number>(25);
  const [note, setNote] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ icon: string; text: string } | null>(null);
  const [help, setHelp] = useState(false);
  const [quality, setQuality] = useState<"auto" | "low" | "high">("auto");
  const [posting, setPosting] = useState<string | null>(null);
  const firmName = (id: number, contract: string) => firmNameIn(latest.current.states, latest.current.config)(id, contract);
  const events = useEvents(40, (e) => onEvent(e));

  const g = game.current;
  const save = () => localStorage.setItem(STORE, JSON.stringify(g.player));
  const firmOf = (m: MarketSymbol, id: number): FirmState | undefined => latest.current.states[m]?.firms.find((f) => f.id === id);
  const name = (m: MarketSymbol, id: number) => nameOf(firmOf(m, id), id);
  // The same colour as its tower: by its place in its market's list.
  const colorOf = (m: MarketSymbol, f: FirmState | undefined) => firmColor(nameOf(f), Math.max(0, (latest.current.states[m]?.firms ?? []).indexOf(f!)));
  const flash = (icon: string, text: string) => {
    setBanner({ icon, text });
    setTimeout(() => setBanner((b) => (b?.text === text ? null : b)), 3500);
  };
  const play = (k: Parameters<typeof cue>[0]) => latest.current.sound && cue(k);

  // Chain events drive both the rounds and the world.
  function onEvent(e: ChainEvent) {
    if (e.standard !== "tontine") return;
    const m = marketOf(latest.current.config, e.contract)?.symbol as MarketSymbol | undefined;
    if (!m) return;
    const d = e.data ?? {};
    const s = scene.current;
    const r = g.apply({ event: e.event, market: m, data: d });
    const a = ASSETS[m];
    switch (e.event) {
      case "order_posted": {
        const mine = !!latest.current.wallet && d.client === latest.current.wallet.accountId;
        s?.order(m, { id: String(d.order_id), side: d.side, mine });
        s?.focus(m);
        play("order");
        break;
      }
      case "bid_committed":
        if (r) (s?.commit(m, keyOf(m, d.firm_id)), play("commit"));
        break;
      case "bid_revealed":
        if (r) {
          const best = Object.values(r.revealed).every((v) => BigInt(v) <= BigInt(d.amount));
          s?.reveal(m, keyOf(m, d.firm_id), auctionAmount(d.amount, r.side, a), best);
          play("reveal");
        }
        break;
      case "auction_settled":
        if (!r) break;
        if (d.winner === null) s?.refund(m);
        else s?.win(m, keyOf(m, d.winner), auctionAmount(d.price, r.side, a));
        if (r.bet) {
          const won = (r.paid ?? 0) > r.bet.stake;
          play(won ? "win" : "lose");
          if (won) flash("fa-trophy", `You called it: +${r.paid! - r.bet.stake} chips on ${name(m, r.bet.firm)}`);
        }
        save();
        break;
      case "order_refunded":
        if (r) {
          s?.refund(m);
          save();
        }
        break;
      case "order_filled":
        if (BigInt(d.edge ?? 0) > 0n) setTimeout(() => scene.current?.dividend(m, keyOf(m, d.firm_id)), 1200);
        break;
      case "slashed":
        s?.slash(m, keyOf(m, d.firm_id));
        break;
      case "liquidation_started":
        flash("fa-gavel", `${name(m, d.firm_id)} is up for sale (${m})`);
        break;
      case "liquidated":
        s?.takeover(m, keyOf(m, d.buyer_firm_id), keyOf(m, d.firm_id));
        s?.focusFirm(keyOf(m, d.buyer_firm_id));
        flash("fa-building-circle-arrow-right", `${name(m, d.buyer_firm_id)} bought ${name(m, d.firm_id)} for ${usdc(d.price)} USDC`);
        break;
      case "firm_closed":
        s?.close(m, keyOf(m, d.firm_id));
        flash("fa-house-crack", `${name(m, d.firm_id)} closed`);
        break;
    }
    if (r) bump();
  }

  // The scene: lazy (three.js only loads here), then fed the firms and regimes.
  useEffect(() => {
    let api: PlazaApi | null = null;
    let disposed = false;
    const onResize = () => api?.resize();
    import("../scene/plaza")
      .then(({ startPlaza }) => {
        if (disposed || !canvas.current) return;
        api = startPlaza({ canvas: canvas.current, reducedMotion: reducedMotion(), mobile: isMobile() });
        scene.current = api;
        if (import.meta.env.DEV) (window as any).__plaza = api;
        window.addEventListener("resize", onResize);
        api.setFirms(plazaFirms(latest.current.states));
      })
      .catch((e) => {
        console.warn("scene unavailable:", e);
        setFailed(true);
      });
    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      api?.dispose();
      scene.current = null;
    };
  }, []);
  useEffect(() => {
    scene.current?.setFirms(plazaFirms(states));
    for (const m of SYMBOLS) scene.current?.setRegime(m, regimeOf(states[m])?.level ?? "calm");
  }, [states.NEAR, states.ETH, states.SOL]);
  useEffect(() => scene.current?.setHighlight(hovered ?? picked ?? (current?.bet ? keyOf(current.market, current.bet.firm) : null)));
  useEffect(() => {
    document.title = "SEALED · Tontine City";
  }, []);
  // Name tags follow their towers every frame (the camera moves between React renders).
  const tagEls = useRef(new Map<string, HTMLSpanElement>());
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      for (const [k, el] of tagEls.current) {
        const pt = scene.current?.project(k);
        el.style.visibility = pt?.visible ? "visible" : "hidden";
        if (pt) el.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  // The countdown moves every second.
  useEffect(() => {
    const t = setInterval(bump, 1000);
    return () => clearInterval(t);
  }, []);

  // The round on the card: the one the player backed until it resolves, else the newest sealed one (the focused
  // market first), else the last one for a few seconds.
  const rounds = [...g.rounds.values()];
  const open = (r: Round) => r.phase === "sealed" || r.phase === "revealed";
  const current =
    rounds.filter((r) => r.bet && (open(r) || Date.now() - r.at < 30_000)).at(-1) ??
    rounds.filter((r) => open(r) && (!focus || r.market === focus)).at(-1) ??
    rounds.filter(open).at(-1) ??
    rounds.filter((r) => Date.now() - r.at < 25_000).at(-1) ??
    null;
  const odds = useMemo(() => (current ? oddsOf(current.bidders, (id) => firmOf(current.market, id)?.fills ?? 0) : new Map<number, number>()), [current?.key, current?.bidders.length, states[current?.market ?? "NEAR"]]);
  const left = current ? secondsLeft(current, states[current.market]) : null;
  useEffect(() => setChoice(null), [current?.key]);

  function back() {
    if (!current || choice === null) return;
    const err = g.back(current.key, choice, Math.min(stake, g.player.chips), odds);
    setNote(err);
    if (!err) {
      save();
      play("commit");
    }
    bump();
  }

  // "Be the client": a real 10 USDC buy on the market in view, from a demo account made on the spot.
  async function postReal() {
    const m = focus ?? current?.market ?? "NEAR";
    try {
      setPosting("Making your demo account…");
      const w = wallet ?? (await createWallet());
      setPosting(`Posting a 10 USDC ${m} order…`);
      const amount = 10_000_000n;
      const q = await getQuote("Buy", amount, m);
      await postOrder(w, "Buy", amount, BigInt(q.out), BigInt(q.out), 12, 6, m);
      announceTx();
      setPosting(null);
      flash("fa-box", "Your order is in: the gold parcel. Back a firm before the bids open.");
    } catch (e) {
      setPosting(null);
      setNote((e as Error).message.slice(0, 160));
    }
  }

  // Keyboard: 1 to 4 pick a bidder, Enter backs it, M sound, Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      const n = Number(e.key);
      if (current?.phase === "sealed" && n >= 1 && n <= current.bidders.length) setChoice(current.bidders[n - 1]);
      else if (e.key === "Enter") back();
      else if (e.key === "m" || e.key === "M") toggleSound();
      else if (e.key === "?") setHelp((h) => !h);
      else if (e.key === "Escape") (setPicked(null), setHelp(false));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function toggleSound() {
    setSound((s) => {
      localStorage.setItem(`${STORE}.sound`, s ? "0" : "1");
      if (!s) cue("order");
      return !s;
    });
  }

  // Name tags over the towers that matter now: the round's bidders, the hovered and the picked one.
  const tagged = [...new Set([...(current && open(current) ? current.bidders.map((id) => keyOf(current.market, id)) : []), hovered, picked].filter((k): k is string => !!k))];

  const p = g.player;
  const pickedFirm = picked ? firmOf(marketOfKey(picked), idOf(picked)) : undefined;
  const leaders = SYMBOLS.flatMap((m) => (states[m]?.firms ?? []).filter((f) => f.status !== "Closed").map((f) => ({ f, m })))
    .sort((a, b) => b.f.fills - a.f.fills)
    .slice(0, 5);

  return (
    <div
      className={`sealed ${hovered ? "pointer" : ""}`}
      onPointerMove={(e) => {
        if (e.target !== canvas.current) return;
        const k = scene.current?.pick(e.clientX, e.clientY) ?? null;
        if (k !== hovered) setHovered(k);
      }}
    >
      <canvas
        ref={canvas}
        className="sealed-canvas"
        onClick={(e) => {
          const k = scene.current?.pick(e.clientX, e.clientY) ?? null;
          setPicked(k);
          if (k) scene.current?.focusFirm(k);
        }}
      />
      {failed && <p className="sealed-empty">This game needs WebGL. <Link to="/app">Open the dashboard</Link>.</p>}

      <div className="sealed-tags" aria-hidden="true">
        {tagged.map((k) => {
          const f = firmOf(marketOfKey(k), idOf(k));
          const backed = current?.bet && keyOf(current.market, current.bet.firm) === k;
          return (
            <span
              key={k}
              ref={(el) => void (el ? tagEls.current.set(k, el) : tagEls.current.delete(k))}
              className={`sealed-tag ${backed ? "backed" : ""}`}
              style={{ visibility: "hidden" }}
            >
              {nameOf(f, idOf(k))}
              {current?.phase === "sealed" && current.market === marketOfKey(k) && odds.has(idOf(k)) && <b> ×{odds.get(idOf(k))!.toFixed(1)}</b>}
            </span>
          );
        })}
      </div>

      <header className="sealed-top">
        <Link className="sealed-brand" to="/app" aria-label="Tontine dashboard">
          <img src="/assets/logo.svg" alt="" width="26" height="26" />
          <span>
            <strong>SEALED</strong> <em>Tontine City</em>
          </span>
        </Link>
        <nav className="sealed-markets" aria-label="Markets">
          {SYMBOLS.map((m) => {
            const level = regimeOf(states[m])?.level ?? "calm";
            return (
              <button
                key={m}
                className={`sealed-mk ${focus === m ? "on" : ""} ${level}`}
                style={{ ["--mk" as any]: ASSETS[m].color }}
                onClick={() => {
                  const next = focus === m ? null : m;
                  setFocus(next);
                  scene.current?.focus(next, true);
                }}
                title={`${m}: ${level}`}
              >
                <i className={`fa-solid ${REGIME_ICON[level]}`} aria-hidden="true" /> {m}
              </button>
            );
          })}
        </nav>
        <div className="sealed-me" aria-label="Your chips">
          <span className="chips" title="Play chips: nothing on chain is spent">
            <i className="fa-solid fa-coins" aria-hidden="true" /> {p.chips}
          </span>
          {p.streak > 0 && (
            <span className="streak" title={`Best streak: ${p.best}`}>
              <i className="fa-solid fa-fire" aria-hidden="true" /> {p.streak}
            </span>
          )}
          <span className={`today ${p.today >= 0 ? "up" : "down"}`} title="Today">
            {p.today >= 0 ? "+" : ""}
            {p.today}
          </span>
          {p.badges.map((b) => (
            <i key={b} className={`fa-solid ${BADGES[b]?.icon ?? "fa-star"} badge`} title={`${BADGES[b]?.label}: ${BADGES[b]?.tip}`} aria-label={BADGES[b]?.label} />
          ))}
        </div>
      </header>

      <aside className="sealed-board" aria-label="Firms with the most fills">
        <h2>Top firms</h2>
        <ol>
          {leaders.map(({ f, m }) => (
            <li key={keyOf(m, f.id)}>
              <button onClick={() => (setPicked(keyOf(m, f.id)), scene.current?.focusFirm(keyOf(m, f.id)))}>
                <span className="dot" style={{ background: colorOf(m, f) }} />
                <span className="nm">{nameOf(f)}</span>
                <span className="mk">{m}</span>
                <span className="n">{f.fills}</span>
              </button>
            </li>
          ))}
        </ol>
      </aside>

      <aside className="sealed-feed" aria-label="Latest on-chain events">
        <EventFeed events={events} firm={firmName} limit={4} compact />
      </aside>

      {banner && (
        <div className="sealed-banner" role="status">
          <i className={`fa-solid ${banner.icon}`} aria-hidden="true" /> {banner.text}
        </div>
      )}

      <section className={`sealed-round is-${current?.phase ?? "idle"}`} aria-live="polite">
        {!current ? (
          <div className="idle">
            <p>
              <span className="live-dot" aria-hidden="true" /> The next sealed auction starts in a few seconds.
            </p>
            <button className="btn small" disabled={!!posting} onClick={postReal}>
              <i className="fa-solid fa-box" aria-hidden="true" /> {posting ?? "Be the client: post a real order"}
            </button>
          </div>
        ) : (
          <>
            <header>
              <span className="mk" style={{ ["--mk" as any]: ASSETS[current.market].color }}>
                {current.market}
              </span>
              <span className="what">
                Order #{current.order} · {current.side === "Buy" ? "buys" : "sells"} {current.market}
                {wallet && current.client === wallet.accountId && <b className="mine"> · yours</b>}
              </span>
              <span className="phase">
                {current.phase === "sealed" ? (
                  <>
                    <i className="fa-solid fa-lock" aria-hidden="true" /> {current.bidders.length} sealed{left !== null && <b className="timer"> {left}s</b>}
                  </>
                ) : current.phase === "revealed" ? (
                  <>
                    <i className="fa-solid fa-lock-open" aria-hidden="true" /> revealed
                  </>
                ) : current.phase === "settled" ? (
                  <>
                    <i className="fa-solid fa-gavel" aria-hidden="true" /> settled
                  </>
                ) : (
                  <>refunded</>
                )}
              </span>
            </header>
            <ul className="bidders">
              {current.bidders.map((id, i) => {
                const f = firmOf(current.market, id);
                const shown = current.revealed[id];
                const won = current.winner === id;
                const mine = current.bet?.firm === id;
                return (
                  <li key={id}>
                    <button
                      className={`bidder ${choice === id ? "on" : ""} ${won ? "won" : ""} ${mine ? "mine" : ""}`}
                      disabled={current.phase !== "sealed" || !!current.bet}
                      onClick={() => setChoice(id)}
                      aria-pressed={choice === id}
                    >
                      <LevelRing fills={f?.fills ?? 0} tint={colorOf(current.market, f)} size={22} />
                      <span className="nm">{nameOf(f, id)}</span>
                      <span className="odds">{shown ? auctionAmount(shown, current.side, ASSETS[current.market]) : `×${(odds.get(id) ?? 1.1).toFixed(1)}`}</span>
                      {won && <i className="fa-solid fa-crown" aria-label="winner" />}
                      {current.phase === "sealed" && <kbd>{i + 1}</kbd>}
                    </button>
                  </li>
                );
              })}
              {current.bidders.length === 0 && <li className="wait">Waiting for the firms' sealed bids…</li>}
            </ul>
            {current.phase === "sealed" && !current.bet && current.bidders.length > 0 && (
              <div className="stake">
                {STAKES.map((s) => (
                  <button key={s} className={`chip ${stake === s ? "on" : ""}`} disabled={s > p.chips} onClick={() => setStake(s)}>
                    {s}
                  </button>
                ))}
                <button className="btn small go" disabled={choice === null || p.chips <= 0} onClick={back}>
                  {choice === null ? "Pick a firm" : `Back ${name(current.market, choice)} · ${Math.min(stake, p.chips)}`}
                </button>
              </div>
            )}
            {current.bet && (
              <p className={`result ${current.paid === null ? "" : current.paid > current.bet.stake ? "won" : current.paid === current.bet.stake ? "even" : "lost"}`}>
                {current.paid === null
                  ? `You backed ${name(current.market, current.bet.firm)} for ${current.bet.stake} at ×${current.bet.odds.toFixed(1)}.`
                  : current.paid > current.bet.stake
                    ? `Won ${current.paid} chips.`
                    : current.paid === current.bet.stake
                      ? "Refunded: fewer than two bids, your chips are back."
                      : `Missed: ${name(current.market, current.winner ?? current.bet.firm)} won.`}
              </p>
            )}
            {current.phase === "settled" && !current.bet && current.winner !== null && (
              <p className="result">
                {name(current.market, current.winner)} won and delivers the second-best quote.{" "}
                <Link to={`/app/orders/${current.order}${current.market === "NEAR" ? "" : `?market=${current.market}`}`}>See the order</Link>
              </p>
            )}
            {current.phase === "refunded" && !current.bet && <p className="result">Fewer than two bids: the client was refunded.</p>}
            {note && <p className="note">{note}</p>}
            {!open(current) && (
              <button className="btn small ghost" disabled={!!posting} onClick={postReal}>
                <i className="fa-solid fa-box" aria-hidden="true" /> {posting ?? "Be the client: post a real order"}
              </button>
            )}
          </>
        )}
      </section>

      {pickedFirm && picked && (
        <aside className="sealed-firm" aria-live="polite">
          <header>
            <LevelRing fills={pickedFirm.fills} tint={colorOf(marketOfKey(picked), pickedFirm)} size={26} />
            <h2>
              {nameOf(pickedFirm)} <span className="mk">{marketOfKey(picked)}</span>
            </h2>
            <Badge status={pickedFirm.status} />
            <button className="sealed-x" aria-label="Close" onClick={() => setPicked(null)}>
              <i className="fa-solid fa-xmark" aria-hidden="true" />
            </button>
          </header>
          <dl>
            <dt>Value</dt>
            <dd>{usdc(pickedFirm.nav)} USDC</dd>
            <dt>Cash</dt>
            <dd>{usdc(pickedFirm.treasury)} USDC</dd>
            <dt>Fills</dt>
            <dd>{pickedFirm.fills}</dd>
            <dt>Dividends paid</dt>
            <dd>{usdc(pickedFirm.dividends, 4)} USDC</dd>
          </dl>
          <a className="btn small" href={`/app/firms/${pickedFirm.id}${marketOfKey(picked) === "NEAR" ? "" : `?market=${marketOfKey(picked)}`}`} target="_blank" rel="noopener">
            Own a share <i className="fa-solid fa-up-right-from-square" aria-hidden="true" />
          </a>
        </aside>
      )}

      <div className="sealed-ctl">
        <button onClick={toggleSound} aria-label={sound ? "Sound off" : "Sound on"} title="Sound (M)">
          <i className={`fa-solid ${sound ? "fa-volume-high" : "fa-volume-xmark"}`} aria-hidden="true" />
        </button>
        <button
          onClick={() => {
            const q = quality === "auto" ? "low" : quality === "low" ? "high" : "auto";
            setQuality(q);
            scene.current?.setQuality(q);
          }}
          title={`Quality: ${quality}`}
          aria-label={`Quality ${quality}`}
        >
          <i className="fa-solid fa-gauge-high" aria-hidden="true" /> <small>{quality}</small>
        </button>
        <button onClick={() => (setFocus(null), scene.current?.focus(null, true))} aria-label="Show every market" title="Recenter">
          <i className="fa-solid fa-expand" aria-hidden="true" />
        </button>
        <button onClick={() => setHelp(true)} aria-label="How to play" title="How to play (?)">
          <i className="fa-solid fa-circle-question" aria-hidden="true" />
        </button>
      </div>

      {help && (
        <div className="sealed-help" role="dialog" aria-label="How to play" onClick={() => setHelp(false)}>
          <div onClick={(e) => e.stopPropagation()}>
            <h2>How to play</h2>
            <p>Every order on Tontine is a sealed auction between AI firms. Back the firm you think wins before the bids open; the best quote wins.</p>
            <p>Chips are for play: nothing on chain is spent. Odds come from each firm's past fills. Win three in a row for a streak.</p>
            <p>"Be the client" posts a real 10 USDC order from a demo account on the devnet: your parcel is the gold one.</p>
            <p className="keys">
              <kbd>1</kbd>-<kbd>4</kbd> pick · <kbd>Enter</kbd> back · <kbd>M</kbd> sound · drag to look around · click a tower
            </p>
            <button className="btn small" onClick={() => setHelp(false)}>
              Play
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
