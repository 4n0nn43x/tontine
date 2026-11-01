// Dev-only harness for scene/plaza.ts (served at /plaza-dev.html by `npm run dev`, not part of the build): fake
// firms on three markets and a fake auction loop. URL flags: q=auto|low|high, rm (reduced motion), mobile,
// loop=0 (no fake events, drive it from window.dev), clean (no HUD). Keys are listed in the HUD.
import { startPlaza, type MarketSym, type PlazaFirm, type Regime } from "./scene/plaza";

const q = new URLSearchParams(location.search);
const canvas = document.getElementById("c") as HTMLCanvasElement;
const hud = document.getElementById("hud")!;
const tagsEl = document.getElementById("tags")!;
if (q.has("clean")) document.body.classList.add("clean");
const mobile = q.has("mobile") || matchMedia("(max-width: 720px), (pointer: coarse)").matches;
const api = startPlaza({ canvas, reducedMotion: q.has("rm"), mobile, onUserInput: () => (inputs += 1) });
let inputs = 0;
const quality = (q.get("q") ?? "auto") as "auto" | "low" | "high";
api.setQuality(quality);
window.addEventListener("resize", () => api.resize());

const MARKETS: MarketSym[] = ["NEAR", "ETH", "SOL"];
const NAMES = ["Undercut & Co", "Cost Plus Ltd", "Gambler Inc", "Premium Partners", "Sniper Holdings", "Atlas AI", "Kestrel", "Aurora", "Lumen", "Halcyon"];
const COLORS = ["#9fd0ff", "#a9f2cb", "#ffb48c", "#d7bcff", "#ffe39d", "#5ee6c8", "#9ff0ff", "#ffc6e8", "#c8ff9f"];
const UNIT: Record<MarketSym, string> = { NEAR: "NEAR", ETH: "ETH", SOL: "SOL" };
const PRICE: Record<MarketSym, number> = { NEAR: 3.21, ETH: 3410, SOL: 182.4 };
const COUNT: Record<MarketSym, number> = { NEAR: 6, ETH: 5, SOL: 9 };
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
let serial = 0;

let firms: PlazaFirm[] = [];
function newFirm(m: MarketSym, status = "Solvent"): PlazaFirm {
  const i = serial++;
  return { key: `${m}:${i}`, market: m, name: NAMES[i % NAMES.length], color: COLORS[i % COLORS.length], nav: 655 + Math.random() * 8, fills: Math.floor(Math.random() * 40), status, rank: 0 };
}
for (const m of MARKETS) for (let i = 0; i < COUNT[m]; i++) firms.push(newFirm(m, m === "ETH" && i === 3 ? "Illiquid" : m === "SOL" && i === 4 ? "Liquidating" : "Solvent"));
function push() {
  for (const m of MARKETS) {
    const mine = firms.filter((f) => f.market === m).sort((a, b) => b.nav - a.nav);
    mine.forEach((f, i) => (f.rank = i + 1));
  }
  api.setFirms(firms.map((f) => ({ ...f })));
}
push();
setInterval(() => {
  for (const f of firms) if (f.status !== "Closed") f.nav += (Math.random() - 0.5) * 0.4;
  push();
}, 3000);

const live = (m: MarketSym) => firms.filter((f) => f.market === m && f.status !== "Closed");
const regimes: Record<MarketSym, Regime> = { NEAR: "calm", ETH: "calm", SOL: "calm" };
function regime(m: MarketSym, r?: Regime) {
  regimes[m] = r ?? (regimes[m] === "calm" ? "alert" : regimes[m] === "alert" ? "storm" : "calm");
  api.setRegime(m, regimes[m]);
}

/** One auction: order, 2 to 4 sealed commits, reveal after 3 s, then a win (or sometimes a refund). */
function auction(m: MarketSym = pick(MARKETS), o: { mine?: boolean; refund?: boolean; revealAt?: number; settleAt?: number } = {}) {
  const side = Math.random() < 0.5 ? "Buy" : "Sell";
  api.order(m, { id: `o${serial++}`, side, mine: o.mine ?? Math.random() < 0.2 });
  const bidders = live(m).sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 3));
  bidders.forEach((f, i) => setTimeout(() => api.commit(m, f.key), 900 + i * 450));
  const bids = bidders.map((f) => ({ f, p: PRICE[m] * (1 + (Math.random() - 0.5) * 0.004) }));
  bids.sort((a, b) => b.p - a.p);
  const fmt = (p: number) => `${p.toFixed(m === "NEAR" ? 4 : 2)} ${UNIT[m]}`;
  const revealAt = o.revealAt ?? 3000 + bidders.length * 450;
  setTimeout(() => bids.forEach((b, i) => setTimeout(() => api.reveal(m, b.f.key, fmt(b.p), i === 0), i * 120)), revealAt);
  setTimeout(() => {
    if (o.refund ?? Math.random() < 0.12) api.refund(m);
    else {
      api.win(m, bids[0].f.key, `won at ${fmt(bids[1]?.p ?? bids[0].p)}`);
      bids[0].f.fills += 1;
    }
  }, o.settleAt ?? revealAt + 1600);
  return bids.map((b) => b.f.key);
}
function slash(m: MarketSym = pick(MARKETS)) {
  const f = pick(live(m));
  if (f) api.slash(m, f.key);
}
function dividend(m: MarketSym = pick(MARKETS)) {
  const f = pick(live(m));
  if (f) api.dividend(m, f.key);
}
function takeover(m: MarketSym = pick(MARKETS)) {
  const l = live(m).sort((a, b) => a.rank - b.rank);
  if (l.length < 3) return;
  const buyer = l[0];
  const target = l[l.length - 1];
  api.takeover(m, buyer.key, target.key);
  setTimeout(() => {
    target.status = "Closed";
    push();
  }, 3500);
  setTimeout(() => {
    firms = firms.filter((f) => f !== target);
    firms.push(newFirm(m));
    push();
  }, 25000);
  return [buyer.key, target.key];
}
function close(m: MarketSym = pick(MARKETS)) {
  const l = live(m).sort((a, b) => b.rank - a.rank);
  const f = l[0];
  if (!f || l.length < 3) return;
  api.close(m, f.key);
  f.status = "Closed";
  push();
  setTimeout(() => {
    firms = firms.filter((x) => x !== f);
    firms.push(newFirm(m));
    push();
  }, 25000);
  return f.key;
}

// The fake event loop.
if (q.get("loop") !== "0") {
  const next = () => setTimeout(() => (auction(), next()), 6000 + Math.random() * 4000);
  next();
  setInterval(() => Math.random() < 0.5 && slash(), 9000);
  setInterval(() => Math.random() < 0.6 && dividend(), 7000);
  setInterval(() => regime(pick(MARKETS), pick(["calm", "calm", "alert", "storm"] as Regime[])), 15000);
  setInterval(() => takeover(), 60000);
  setTimeout(() => setInterval(() => close(), 60000), 30000);
}

let hl: string | null = null;
canvas.addEventListener("pointermove", (e) => {
  const k = api.pick(e.clientX, e.clientY);
  if (k !== hl) api.setHighlight((hl = k));
  canvas.style.cursor = k ? "pointer" : "";
});
canvas.addEventListener("click", (e) => {
  const k = api.pick(e.clientX, e.clientY);
  if (k) api.focusFirm(k);
});
let autoOn = true;
const QUAL = ["auto", "low", "high"] as const;
let qi = QUAL.indexOf(quality);
window.addEventListener("keydown", (e) => {
  const m = MARKETS[Math.floor(Math.random() * 3)];
  ({
    o: () => auction(),
    m: () => auction(undefined, { mine: true }),
    f: () => auction(undefined, { refund: true }),
    s: () => slash(),
    d: () => dividend(),
    t: () => takeover(),
    x: () => close(),
    "1": () => regime("NEAR"),
    "2": () => regime("ETH"),
    "3": () => regime("SOL"),
    "4": () => api.focus("NEAR", true),
    "5": () => api.focus("ETH", true),
    "6": () => api.focus("SOL", true),
    "0": () => api.focus(null, true),
    h: () => api.setHighlight((hl = hl ? null : pick(live(m)).key)),
    a: () => api.setAuto((autoOn = !autoOn)),
    q: () => api.setQuality(QUAL[(qi = (qi + 1) % 3)]),
  } as Record<string, () => void>)[e.key]?.();
});

// HUD: stats and one HTML tag on the highlighted tower (exercises project()).
let frames = 0;
let fps = 0;
let t0 = performance.now();
(function tick() {
  requestAnimationFrame(tick);
  frames++;
  const now = performance.now();
  if (now - t0 > 1000) {
    fps = (frames * 1000) / (now - t0);
    frames = 0;
    t0 = now;
    const s = api.stats?.();
    hud.textContent =
      `${fps.toFixed(0)} fps  ${s?.frameMs.toFixed(1)} ms  calls ${s?.calls}  tris ${s?.triangles}  dpr ${s?.dpr}  bloom ${s?.bloom}  shadows ${s?.shadows}  inputs ${inputs}\n` +
      `o auction  m mine  f refund  s slash  d dividend  t takeover  x close  1-3 regime  4-6 focus  0 overview  h highlight  a auto  q quality`;
  }
  const f = hl ? firms.find((x) => x.key === hl) : undefined;
  const p = hl ? api.project(hl) : null;
  tagsEl.innerHTML = f && p?.visible ? `<div style="left:${p.x}px;top:${p.y}px">${f.name} · #${f.rank}</div>` : "";
})();

Object.assign(window, { dev: { api, firms: () => firms, push, auction, slash, dividend, takeover, close, regime } });
