// A pixel-art city at dusk where every building is a firm. Same interface as the old WebGL scene:
// mode "replay" plays STORY (the recorded `make demo`) in a loop, mode "live" is driven with act(step),
// one call per chain event. Drawn in Canvas 2D at a quarter of the resolution and scaled up with crisp
// pixels; labels are drawn at full resolution in the pixel font.
import { EXTRA_SLOTS, FIRMS, STORY, STORY_LENGTH } from "./story.js";

const SKY = ["#120c19", "#150d1f", "#1a0f27", "#22122f", "#2e1838", "#3a2140", "#55294d", "#7c3a5f", "#a8506f", "#d4747f", "#ec8f97"];
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const AMBER = "#f6d7a7";
const RED = "#ff8f8f";
const GREEN = "#8ef0b3";
const FONT = '"Geist Pixel Circle", ui-monospace, monospace';

// Tower slots: x and width as fractions of the width, height as a fraction of the ground height.
// House firms first (story order), then extra slots for third-party firms in live mode.
const SLOTS = [
  { x: 0.035, w: 0.075, h: 0.7 },
  { x: 0.185, w: 0.06, h: 0.42 },
  { x: 0.775, w: 0.06, h: 0.4 },
  { x: 0.9, w: 0.08, h: 0.74 },
  { x: 0.125, w: 0.045, h: 0.56 },
  { x: 0.29, w: 0.05, h: 0.3 },
  { x: 0.66, w: 0.05, h: 0.32 },
  { x: 0.845, w: 0.045, h: 0.5 },
];

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function rgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function mix(a, b, t) {
  const x = rgb(a);
  const y = rgb(b);
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(",")})`;
}

export function startScene({ canvas, tagsLayer, onEvent, onPhase, reducedMotion = false, isMobile = false, mode = "replay", firmNames = null, debugQuery = true }) {
  const ctx = canvas.getContext("2d");
  const art = document.createElement("canvas");
  const a = art.getContext("2d");
  const back = document.createElement("canvas"); // sky, sun and far skyline: redrawn only on resize
  const b = back.getContext("2d");
  if (tagsLayer) tagsLayer.innerHTML = "";

  let W = 0; // art pixels
  let H = 0;
  let G = 0; // ground line
  let S = 1; // device pixels per art pixel
  let dpr = 1;
  let clock = 0;
  let explore = 0;
  let exploreTarget = 0;
  let calm = null; // copy box in CSS pixels, towers stay below it

  const live = mode === "live";
  const names = firmNames ?? FIRMS.map((f) => f.name);
  function makeFirm(name, i) {
    const def = FIRMS.find((f) => f.name === name) ?? EXTRA_SLOTS[i % EXTRA_SLOTS.length];
    const r = rng(i * 7919 + name.length * 31);
    const look = rng(i * 104729 + name.length * 17); // live-only shape, so the replay's seed stays as it was
    return {
      name,
      index: i,
      color: def.color,
      sign: def.color,
      slot: SLOTS[i % SLOTS.length],
      seed: r,
      lights: [],
      lit: 0.45, // target share of lit windows
      tint: AMBER,
      state: "idle",
      status: "idle",
      pulse: 0,
      flash: 0,
      flashColor: RED,
      forSale: false,
      owner: null,
      box: null,
      roofStyle: Math.floor(r() * 3),
      // Live city only: chain id, lot on the street, floors grown from value and fills, life stage.
      id: null,
      lot: i,
      x: null,
      tx: 0,
      w: 10,
      cols: 2,
      hFrac: 0.3 + 0.35 * look(),
      wFrac: 0.62 + 0.25 * look(),
      floors: 0,
      floorsTarget: 0,
      growT: 0,
      nav: null,
      nav0: null,
      fills: 0,
      bonus: 0, // floors gained by absorbing a rival
      phase: "standing", // standing | collapsing | rubble | gone
      sink: 0,
      sinkV: 0,
      brand: null, // the buyer's name after a takeover
      exName: null,
      closeDue: null,
      building: false, // a new firm: built from the ground with a crane
    };
  }
  const firms = names.map(makeFirm);
  const byName = new Map(firms.map((f) => [f.name, f]));

  const job = { on: 0, target: 0, x: -0.2, tx: 0.5, label: "", id: null };
  const flyers = []; // packets, coins, keys: { kind, from, to, t, dur, color, arc, then }
  const labels = []; // { text, x, y, color, until, size, rise }
  const cars = Array.from({ length: isMobile ? 4 : 9 }, (_, i) => ({ x: Math.random(), v: (0.012 + Math.random() * 0.02) * (i % 2 ? 1 : -1) }));
  const stars = Array.from({ length: 90 }, () => ({ x: Math.random(), y: Math.random() * 0.5, p: Math.random() * 6 }));
  let skyline = [];

  // ------------------------------------------------------------------ layout

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = canvas.clientWidth || 1;
    const ch = canvas.clientHeight || 1;
    const px = cw < 720 ? 3 : 4; // CSS pixels per art pixel
    W = Math.ceil(cw / px);
    H = Math.ceil(ch / px);
    S = px * dpr;
    G = Math.round(H * (cw < 720 ? 0.9 : 0.87));
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    art.width = W;
    art.height = H;
    back.width = W;
    back.height = H;
    if (live) liveLayout();
    else for (const f of firms) placeTower(f, px);
    buildSkyline();
    drawBack();
  }

  function placeTower(f, px) {
    const narrow = W * px < 720;
    const s = f.slot;
    const w = Math.max(10, Math.round(W * s.w * (narrow ? 1.5 : 1)));
    let x = Math.round(W * s.x);
    if (narrow) x = Math.round(W * (s.x < 0.5 ? s.x * 0.6 : 1 - (1 - s.x) * 0.6) - (s.x < 0.5 ? 0 : w * 0.4));
    let h = Math.round(G * s.h);
    // Keep roofs (and their signs) under the copy when the tower stands beneath it.
    if (calm) {
      const l = calm.left / px;
      const r = calm.right / px;
      if (x + w > l - 6 && x < r + 6) h = Math.min(h, Math.max(14, G - Math.round(calm.bottom / px) - 14));
    }
    const cols = Math.max(2, Math.floor((w - 3) / 3));
    const rows = Math.max(3, Math.floor((h - 8) / 4));
    if (f.lights.length !== cols * rows) {
      f.lights = Array.from({ length: cols * rows }, () => ({ v: f.seed() < f.lit ? 1 : 0, on: 0, warm: f.seed() }));
    }
    f.box = { x, w, h, top: G - h, cols, rows };
  }

  // ------------------------------------------------------------------ live city: lots, floors, life stages

  // The street is cut into lots on both sides of the exchange; a firm stands on its lot, grows a floor at a
  // time from its value and its fills, slides next to its buyer after a takeover, and falls down when wound up.
  const MAX_FLOORS = 48;
  let lots = [];
  let maxFloors = 12;

  let lotsAssigned = false;
  function liveLayout() {
    liveLayoutLots();
    maxFloors = Math.max(4, Math.min(MAX_FLOORS, Math.floor((G - Math.round(H * 0.3) - 6) / 4)));
    if (!lotsAssigned) {
      // Alternate sides of the exchange, so the first firms spread out and leave lots free between them.
      const left = Math.ceil(lots.length / 2);
      firms.forEach((f, i) => (f.lot = i % 2 ? left + (i - 1) / 2 : i / 2));
      lotsAssigned = true;
    }
    for (const f of firms) {
      if (f.lot < 0) continue;
      fitLot(f);
      f.x = f.tx;
      f.moving = false;
      if (!f.building && f.phase === "standing") f.floors = f.floorsTarget;
      liveBox(f);
    }
  }

  function fitLot(f) {
    const lot = lots[f.lot] ?? lots[lots.length - 1];
    f.w = Math.max(8, Math.round(lot.w * f.wFrac));
    f.tx = Math.round(lot.x + (lot.w - f.w) / 2);
    f.cols = Math.max(2, Math.floor((f.w - 3) / 3));
    if (f.lights.length < f.cols * MAX_FLOORS) {
      // Lit from the start: with reduced motion the windows never fade in.
      f.lights = Array.from({ length: f.cols * MAX_FLOORS }, () => {
        const v = Math.random() < f.lit ? 1 : 0;
        return { v, on: v, warm: Math.random() };
      });
    }
    retarget(f);
  }

  // Height: a base per firm, times its value against the value it had when the page opened (cubed, so a few
  // percent shows), plus a floor every few fills, plus the floors of the rivals it absorbed.
  function retarget(f) {
    const base = f.hFrac * maxFloors;
    const value = f.nav0 ? Math.pow(Math.max(0, f.nav) / f.nav0, 3) : 1;
    const work = 1 + 0.04 * Math.min(f.fills, 30);
    f.floorsTarget = Math.max(2, Math.min(maxFloors, Math.round(base * value * work) + f.bonus));
  }

  function liveBox(f) {
    const rows = Math.max(0, Math.round(f.floors));
    const h = 6 + rows * 4;
    f.box = { x: Math.round(f.x), w: f.w, h, top: G - h + Math.round(f.sink), cols: f.cols, rows };
  }


  function buildSkyline() {
    skyline = [];
    const r = rng(42);
    for (let layer = 0; layer < 2; layer++) {
      let x = -4;
      while (x < W + 4) {
        const w = 6 + Math.floor(r() * (layer ? 10 : 14));
        const edge = Math.abs(x / W - 0.5) * 2; // 0 at the centre, 1 at the edges
        const maxH = G * (layer ? 0.16 + 0.22 * edge : 0.1 + 0.32 * edge);
        const h = Math.max(4, Math.round(maxH * (0.45 + 0.55 * r())));
        skyline.push({ layer, x, w, h, seed: Math.floor(r() * 1e6) });
        x += w + (r() < 0.3 ? 1 : 0);
      }
    }
  }

  // Sky, sun and the far skyline do not move with the story: draw them once per size.
  function drawBack() {
    const img = b.createImageData(W, H);
    const pal = SKY.map(rgb);
    const horizon = G - Math.round(H * 0.05);
    for (let y = 0; y < H; y++) {
      const t = Math.min(1, Math.pow(Math.max(0, y) / horizon, 1.5)) * (pal.length - 1);
      for (let x = 0; x < W; x++) {
        const k = Math.min(pal.length - 1, Math.floor(t) + (t % 1 > BAYER[(y % 4) * 4 + (x % 4)] ? 1 : 0));
        const o = (y * W + x) * 4;
        img.data[o] = pal[k][0];
        img.data[o + 1] = pal[k][1];
        img.data[o + 2] = pal[k][2];
        img.data[o + 3] = 255;
      }
    }
    b.putImageData(img, 0, 0);
    // A striped sun sinking behind the city.
    const cx = W / 2;
    const cy = horizon;
    const r = Math.min(W * 0.075, H * 0.16);
    for (let y = Math.floor(cy - r); y < cy; y++) {
      const dy = cy - y;
      const gap = Math.floor((1 - dy / r) * 4);
      if (gap > 0 && y % 5 < gap) continue;
      const half = Math.sqrt(r * r - dy * dy);
      b.fillStyle = dy > r * 0.55 ? "#f6d7a7" : dy > r * 0.25 ? "#f6c6a0" : "#ec8f97";
      b.fillRect(Math.round(cx - half), y, Math.round(half * 2), 1);
    }
  }

  // ------------------------------------------------------------------ helpers

  function roof(f) {
    return { x: f.box.x + f.box.w / 2, y: f.box.top - 2 };
  }

  function jobPos() {
    return { x: W * job.x, y: Math.round(H * (W < 240 ? 0.14 : 0.17)) + Math.sin(clock * 0.9) * 1.5 };
  }

  function say(f, text, color = "#fff", seconds = 2.6) {
    labels.push({ text, f, color, born: clock, until: clock + seconds });
  }

  function fly(kind, from, to, opts = {}) {
    flyers.push({ kind, from, to, t: 0, dur: opts.dur ?? 1.2, color: opts.color ?? AMBER, arc: opts.arc ?? 18, delay: opts.delay ?? 0, then: opts.then });
  }

  function log(text, kind = "") {
    onEvent?.({ text, kind });
  }

  function setStatus(f, s) {
    f.status = s;
  }

  // ------------------------------------------------------------------ story actions

  const ACTIONS = {
    reset() {
      onPhase?.(-1);
      job.target = 0;
      flyers.length = 0;
      labels.length = 0;
      for (const f of firms) {
        f.lit = 0.45;
        f.tint = AMBER;
        f.sign = FIRMS.find((d) => d.name === f.name)?.color ?? f.color;
        f.forSale = false;
        f.owner = null;
        f.state = "idle";
        setStatus(f, "idle");
      }
    },
    order({ id, side, amount, min, asset = "NEAR" }) {
      job.id = id;
      job.label = `ORDER #${id} · ${side === "Buy" ? "BUY" : "SELL"} ${asset} · ${amount}`;
      job.target = 1;
      job.x = -0.15;
      job.tx = 0.5;
      onPhase?.(0);
      log(`<b>order #${id}</b> · ${side === "Buy" ? "buy" : "sell"} ${asset} · ${amount}`);
      if (min) log(`min ${min}, the market reference`);
    },
    commit({ firm, target }) {
      const f = byName.get(firm);
      if (!f) return;
      const t = target ? byName.get(target) : null;
      f.pulse = 1;
      setStatus(f, "sealed bid");
      fly("packet", () => roof(f), () => (t ? roof(t) : jobPos()), { color: f.color, dur: 1.1, arc: 22 });
      onPhase?.(target === undefined ? 1 : 5);
      log(`${firm} · <b>sealed bid</b>`);
    },
    reveal({ firm, price }) {
      const f = byName.get(firm);
      if (!f) return;
      say(f, price, "#fff", 3);
      setStatus(f, `bid ${price}`);
      if (job.target) onPhase?.(2);
      log(`${firm} reveals <b>${price}</b>`);
    },
    win({ firm, price, note }) {
      const f = byName.get(firm);
      if (!f) return;
      f.pulse = 1.6;
      f.flash = 1;
      f.flashColor = GREEN;
      // The winner's windows light up, floor by floor, until the fill lands.
      f.state = "working";
      f.lit = 0.95;
      say(f, `wins · delivers ${price}`, GREEN, 3);
      setStatus(f, "won the order");
      fly("beam", () => jobPos(), () => roof(f), { color: GREEN, dur: 0.9, arc: 0 });
      log(`<b>${firm}</b> wins · 2nd best ${price}`);
      if (note) log(note);
    },
    fill({ firm, price, edge, dividends }) {
      const f = byName.get(firm);
      if (!f) return;
      // What the client paid comes down from the order to the firm, then 30% of the edge spills out to the holders.
      for (let i = 0; i < 9; i++) fly("coin", () => jobPos(), () => roof(f), { delay: i * 0.08, dur: 1, arc: 14 });
      for (let i = 0; i < 12; i++) {
        const dx = (i - 6) * 3.5;
        fly("coin", () => roof(f), () => ({ x: roof(f).x + dx * 2.2, y: G + 3 }), { delay: 1.1 + i * 0.05, dur: 1.1, arc: 16 });
      }
      f.lit = 0.6;
      f.state = "idle";
      setStatus(f, `filled ${price}`);
      onPhase?.(3);
      setTimeout(() => say(f, `+${dividends} to holders`, AMBER, 2.6), reducedMotion ? 0 : 1100);
      log(`edge ${edge} USDC · <b>${dividends} to holders</b>`);
    },
    slash({ firm, bond }) {
      const f = byName.get(firm);
      if (!f) return;
      f.flash = 1.4;
      f.flashColor = RED;
      f.lit = 0.25;
      for (let i = 0; i < 6; i++) fly("coin", () => roof(f), () => jobPos(), { delay: i * 0.1, color: RED, dur: 1.1 });
      say(f, `bond −${bond}`, RED, 2.6);
      setStatus(f, "bond slashed");
      onPhase?.(4);
      log(`owner bond <b>−${bond}</b> to the client`, "bad");
    },
    orderEnd() {
      job.target = 0;
      job.tx = 1.2;
      for (const f of firms) if (f.state === "working") f.state = "idle";
    },
    epoch({ firm, n, of = 3, liquidating }) {
      const f = byName.get(firm);
      if (!f) return;
      f.lit = liquidating ? 0.04 : 0.12;
      if (liquidating) {
        f.forSale = true;
        onPhase?.(5);
      }
      setStatus(f, liquidating ? "for sale" : `cash under the floor ${n}/${of}`);
      log(liquidating ? `${firm} · <b>liquidating</b>` : `${firm} · cash under the floor ${n}/${of}`, "bad");
    },
    takeover({ buyer, target, price, fee, holders, near, asset = "NEAR" }) {
      const t = byName.get(target);
      const bu = byName.get(buyer);
      if (!t) return;
      if (bu) {
        for (let i = 0; i < 7; i++) fly("coin", () => roof(bu), () => roof(t), { delay: i * 0.09, dur: 1.2, arc: 26 });
        t.sign = bu.color;
        t.tint = bu.color;
        t.owner = bu.name;
      }
      t.forSale = false;
      t.lit = 0.55;
      t.flash = 1.2;
      t.flashColor = bu?.color ?? AMBER;
      say(t, `bought by ${buyer}`, bu?.color ?? AMBER, 3.2);
      setStatus(t, `owned by ${buyer}`);
      onPhase?.(6);
      log(`<b>${buyer}</b> buys ${target} · ${price}`);
      log(`fee ${fee} · old holders <b>+${holders}</b>`);
      if (near) log(`old holders <b>+${near} ${asset}</b>, in kind`);
    },
    close({ firm }) {
      const f = byName.get(firm);
      if (!f) return;
      f.lit = 0;
      f.forSale = false;
      f.sign = "#3a2a46";
      f.state = "closed";
      setStatus(f, "closed");
      say(f, "closed", "rgba(255,255,255,0.7)", 3);
      log(`${firm} · <b>closed</b>`);
    },
    keys({ target }) {
      const t = byName.get(target);
      if (!t) return;
      fly("key", () => roof(t), () => ({ x: roof(t).x + 14, y: roof(t).y - 26 }), { color: RED, dur: 1.6, arc: 4 });
      log(`${target} · old agent keys deleted`);
    },
    refused({ firm, label, line }) {
      const f = byName.get(firm);
      if (!f) return;
      f.flash = 1;
      f.flashColor = RED;
      say(f, label, RED, 3);
      log(line, "bad");
    },
    done({ checks }) {
      log(`<b>${checks}</b> checks pass · replay restarts`);
    },
  };

  let storyClock = 0;
  let storyIndex = 0;
  function runStory(dt) {
    storyClock += dt;
    while (storyIndex < STORY.length && STORY[storyIndex].at <= storyClock) {
      const step = STORY[storyIndex++];
      ACTIONS[step.do]?.(step);
    }
    if (storyClock > STORY_LENGTH) {
      storyClock = 0;
      storyIndex = 0;
    }
  }

  // ------------------------------------------------------------------ agents (dashboard only)

  // In live mode each firm sends a small agent down to the market hall in the street. Its bubble only
  // says what the chain says: a sealed bid, the revealed quote, the fill, a slash, a takeover.
  const agents = mode === "live" ? firms.map((f) => ({ f, x: null, tx: null, color: f.color, bubble: "", bubbleColor: "#fff", until: 0, carry: false, walking: false })) : [];
  const hall = { flash: 0 };
  const agentOf = (name) => agents.find((g) => g.f.name === name);
  const door = (f) => f.box.x + f.box.w / 2;
  const hallX = () => W / 2;
  function speak(g, text, color = "#fff", seconds = 4) {
    g.bubble = text;
    g.bubbleColor = color;
    g.until = clock + seconds;
  }
  const goHall = (g) => (g.tx = hallX() + (g.f.index - (agents.length - 1) / 2) * 7);
  const goHome = (g) => (g.tx = door(g.f));

  function agentAct(s) {
    const g = s.firm ? agentOf(s.firm) : null;
    switch (s.do) {
      case "order":
        hall.flash = 1.5;
        break;
      case "commit":
        if (!g) break;
        if (s.target && byName.get(s.target)) g.tx = door(byName.get(s.target)) - 5;
        else goHall(g);
        speak(g, s.target ? `sealed bid for ${s.target}` : "sealed bid", g.f.color);
        break;
      case "reveal":
        if (g) speak(g, s.note ? `${s.price} · ${s.note}` : s.price);
        break;
      case "win":
        for (const o of agents) {
          if (o === g || o.tx === null || Math.abs(o.tx - hallX()) > 40) continue;
          goHome(o);
          speak(o, "lost", "rgba(255,255,255,0.6)", 2);
        }
        if (g) {
          g.carry = true;
          goHome(g);
          speak(g, `won · delivers the 2nd best ${s.price}`, GREEN);
        }
        break;
      case "fill":
        if (!g) break;
        g.carry = false;
        speak(g, `edge ${s.edge} · +${s.dividends} to holders`, AMBER, 5);
        break;
      case "refused":
        if (g) speak(g, s.label, RED);
        break;
      case "slash":
        if (!g) break;
        g.carry = false;
        speak(g, `bond −${s.bond}`, RED);
        break;
      case "epoch":
        if (g) speak(g, s.liquidating ? "for sale" : "cash under the floor", RED, 5);
        break;
      case "takeover": {
        const t = agentOf(s.target);
        const bu = agentOf(s.buyer);
        if (t) {
          if (bu) t.color = bu.f.color;
          speak(t, `now owned by ${s.buyer}`, t.color, 5);
        }
        if (bu && byName.get(s.target)) {
          bu.tx = door(byName.get(s.target)) + 6;
          speak(bu, `bought ${s.target} · ${s.price}`, bu.f.color, 5);
          setTimeout(() => goHome(bu), 6000);
        }
        break;
      }
      case "keys": {
        const t = agentOf(s.target);
        if (t) speak(t, "old keys deleted", RED);
        break;
      }
      case "orderEnd":
        for (const o of agents) goHome(o);
        break;
    }
  }

  // Chain events come from final blocks, often a whole auction at once. Play them back at a pace the
  // eye can follow: bids leave together, then the agents get time to reach the hall before the reveal.
  const queue = [];
  let lastDo = "";
  let lastAt = -9;
  function pump() {
    while (queue.length) {
      const next = queue[0];
      const gap = next.do === "commit" ? (lastDo === "commit" ? 0.35 : 1) : lastDo === "commit" ? 3 : 1.2;
      if (clock < lastAt + gap) return;
      queue.shift();
      ACTIONS[next.do]?.(next);
      agentAct(next);
      gameAct(next);
      lastDo = next.do;
      lastAt = clock;
    }
  }

  function moveAgents(dt) {
    if (queue.length) pump();
    hall.flash = Math.max(0, hall.flash - dt);
    for (const g of agents) {
      if (g.x === null) g.x = g.tx = door(g.f);
      const d = g.tx - g.x;
      const step = 40 * dt;
      g.walking = Math.abs(d) > 0.5;
      g.x += Math.abs(d) <= step ? d : Math.sign(d) * step;
    }
  }

  function drawExchange() {
    // The exchange where the agents meet to bid: steps, columns and a pediment; it glows while an order is open.
    const hx = Math.round(hallX());
    const glow = Math.min(1, hall.flash + (job.target ? 0.35 : 0));
    a.fillStyle = "#f6d7a7";
    a.globalAlpha = 0.18 + 0.55 * glow;
    a.fillRect(hx - 10, G - 12, 20, 9);
    a.globalAlpha = 1;
    a.fillStyle = "#2a1a36";
    a.fillRect(hx - 14, G - 2, 28, 2);
    a.fillRect(hx - 12, G - 3, 24, 1);
    a.fillStyle = mix("#4a2c52", AMBER, glow * 0.5);
    for (let c = 0; c < 4; c++) a.fillRect(hx - 10 + c * 6, G - 12, 2, 9);
    a.fillStyle = "#3a2346";
    a.fillRect(hx - 13, G - 14, 26, 2);
    a.fillStyle = mix("#7c3a5f", AMBER, glow);
    for (let k = 0; k < 4; k++) a.fillRect(hx - 12 + k * 3, G - 15 - k, 24 - k * 6, 1);
  }

  function drawPerson(px0, feet, color, walking, phaseOffset = 0) {
    const x = Math.round(px0) - 2;
    const step = walking ? Math.floor(clock * 8 + phaseOffset) % 2 : -1;
    // 5 x 11 pixels: hair, face, torso in its colour with arms, dark trousers, shoes.
    a.fillStyle = "#3a2a1e";
    a.fillRect(x + 1, feet - 11, 3, 1);
    a.fillStyle = "#f2d3b8";
    a.fillRect(x + 1, feet - 10, 3, 3);
    a.fillStyle = color;
    a.fillRect(x, feet - 7, 5, 4);
    a.fillStyle = "#f2d3b8";
    a.fillRect(x, feet - 4 + (step === 0 ? -1 : 0), 1, 1);
    a.fillRect(x + 4, feet - 4 + (step === 1 ? -1 : 0), 1, 1);
    a.fillStyle = "#2b2140";
    a.fillRect(x + 1, feet - 3, 3, 1);
    a.fillRect(x + 1, feet - 2, 1, step === 0 ? 1 : 2);
    a.fillRect(x + 3, feet - 2, 1, step === 1 ? 1 : 2);
    a.fillStyle = "#0b0710";
    a.fillRect(x + (step === 0 ? 0 : 1), feet - 1, 1, 1);
    a.fillRect(x + (step === 1 ? 4 : 3), feet - 1, 1, 1);
  }

  function drawAgents() {
    drawExchange();
    const feet = G + Math.min(12, H - G - 1);
    // Passers-by walk a row behind the traders.
    walkers.forEach((p, i) => {
      drawPerson(p.x, feet - 2, p.color, p.walking, i * 0.5);
      drawEmote(p.emote, p.x - 2, feet - 2);
    });
    for (const g of agents) {
      if (g.hidden) continue;
      const x = Math.round(g.x) - 2;
      const step = g.walking ? Math.floor(clock * 8) % 2 : -1;
      // 5 x 11 pixels: hair, face, torso in the firm colour with arms, dark trousers, shoes.
      a.fillStyle = "#3a2a1e";
      a.fillRect(x + 1, feet - 11, 3, 1);
      a.fillStyle = "#f2d3b8";
      a.fillRect(x + 1, feet - 10, 3, 3);
      a.fillStyle = g.color;
      a.fillRect(x, feet - 7, 5, 4);
      a.fillStyle = "#f2d3b8";
      a.fillRect(x, feet - 4 + (step === 0 ? -1 : 0), 1, 1);
      a.fillRect(x + 4, feet - 4 + (step === 1 ? -1 : 0), 1, 1);
      a.fillStyle = "#2b2140";
      a.fillRect(x + 1, feet - 3, 3, 1);
      a.fillRect(x + 1, feet - 2, 1, step === 0 ? 1 : 2);
      a.fillRect(x + 3, feet - 2, 1, step === 1 ? 1 : 2);
      a.fillStyle = "#0b0710";
      a.fillRect(x + (step === 0 ? 0 : 1), feet - 1, 1, 1);
      a.fillRect(x + (step === 1 ? 4 : 3), feet - 1, 1, 1);
      if (g.carry) {
        a.fillStyle = AMBER;
        a.fillRect(x + 5, feet - 4, 2, 2);
        a.fillStyle = "#8a6a3a";
        a.fillRect(x + 5, feet - 5, 2, 1);
      }
      drawEmote(g.emote, x, feet);
    }
  }

  function drawBubbles() {
    const feet = G + Math.min(12, H - G - 1);
    // The exchange's board: the last NEAR price, amber on black.
    const board = market.price ? `NEAR ${market.price.toFixed(4)}` : "EXCHANGE";
    ctx.font = `${Math.round(10 * dpr)}px ${FONT}`;
    const bw = ctx.measureText(board).width + 10 * dpr;
    const bh = 14 * dpr;
    const bx0 = hallX() * S - bw / 2;
    const by0 = (G - 19) * S - bh;
    ctx.fillStyle = "rgba(8,5,12,0.9)";
    ctx.fillRect(bx0, by0, bw, bh);
    ctx.fillStyle = "rgba(246,215,167,0.35)";
    ctx.fillRect(bx0, by0 + bh - dpr, bw, dpr);
    ctx.fillStyle = AMBER;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(board, hallX() * S, by0 + bh / 2 + dpr);
    ctx.font = `${Math.round(11 * dpr)}px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const shown = agents.filter((g) => g.until > clock && g.bubble && !g.hidden);
    shown.forEach((g, i) => {
      const alpha = Math.min(1, (g.until - clock) * 2);
      const tw = ctx.measureText(g.bubble).width;
      const pad = 6 * dpr;
      const bw = tw + pad * 2;
      const bh = 18 * dpr;
      // Agents at the hall stand close together: alternate bubble heights so they do not cover each other.
      const lift = (i % 3) * 20 * dpr;
      let bx = (g.x) * S - bw / 2;
      bx = Math.max(4 * dpr, Math.min(canvas.width - bw - 4 * dpr, bx));
      const by = (feet - 12) * S - bh - 6 * dpr - lift;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "rgba(16,10,24,0.88)";
      ctx.strokeStyle = g.bubbleColor;
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 6 * dpr);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = g.bubbleColor;
      ctx.fillText(g.bubble, bx + pad, by + bh / 2 + dpr);
      ctx.globalAlpha = 1;
    });
    ctx.textBaseline = "alphabetic";
  }

  // ------------------------------------------------------------------ live city: what happens to the firms

  const parts = []; // dust, debris, sparks: { x, y, vx, vy, life, max, color, g, s }
  const market = { price: null };
  let shake = 0;
  let tickerX = 0;
  let started = false; // the first setFirms() places everything at once, later ones animate
  let parallax = 0;
  let parallaxTarget = 0;

  function burst(x, y, n, { color = "#8a6a7e", spread = 6, up = 10, g = 30, life = 1.2, s = 1 } = {}) {
    if (still || parts.length > 600) return;
    for (let i = 0; i < n; i++) {
      parts.push({ x: x + (Math.random() - 0.5) * spread, y, vx: (Math.random() - 0.5) * spread * 2, vy: -Math.random() * up, life: life * (0.6 + Math.random() * 0.6), max: life, color, g, s });
    }
  }

  // Passers-by: they only react (emotes), they never speak for the chain.
  const CROWD = ["#6b5a8a", "#8a5a6e", "#4f6f8a", "#7a6a4a", "#5a7a6a", "#8a7aa0", "#a06a5a"];
  const walkers = live ? Array.from({ length: isMobile ? 4 : 7 }, (_, i) => ({ x: null, tx: null, color: CROWD[i % CROWD.length], speed: 9 + Math.random() * 6, wait: Math.random() * 4, run: 0, emote: null, walking: false })) : [];

  // 3 x 5 glyphs for the emote bubbles.
  const GLYPHS = {
    "!": [".X.", ".X.", ".X.", "...", ".X."],
    "?": ["XX.", "..X", ".X.", "...", ".X."],
    $: [".X.", "XXX", "XXX", "XXX", ".X."],
    "<3": ["...", "X.X", "XXX", "XXX", ".X."],
    x: ["...", "X.X", ".X.", "X.X", "..."],
    "^": [".X.", "XXX", ".X.", ".X.", "..."],
  };
  function emote(p, glyph, color = "#fff", seconds = 2.5) {
    if (p) p.emote = { glyph, color, until: clock + seconds };
  }

  const freeLot = (except) => {
    const used = new Set(firms.filter((f) => f !== except && f.phase !== "gone" && f.lot >= 0).map((f) => f.lot));
    for (let l = 0; l < lots.length; l++) if (!used.has(l)) return l;
    return -1;
  };

  function relot() {
    const before = lots.length;
    liveLayoutLots();
    for (const f of firms) if (f.lot >= 0) fitLot(f);
    return lots.length !== before;
  }

  function liveLayoutLots() {
    const n = Math.max(8, firms.filter((f) => f.phase !== "gone").length + 2, ...firms.map((f) => f.lot + 1));
    const gap = Math.max(17, Math.round(W * 0.09));
    const left = Math.ceil(n / 2);
    const span = (from, to, k) => Array.from({ length: k }, (_, j) => ({ x: from + ((to - from) * j) / k, w: (to - from) / k }));
    lots = [...span(2, W / 2 - gap, left), ...span(W / 2 + gap, W - 2, n - left)];
  }

  // A firm launched on chain: an empty lot gets a crane and the tower goes up a floor at a time.
  function addFirm(name) {
    const f = makeFirm(name, firms.length);
    f.building = true;
    f.floors = 0;
    firms.push(f);
    byName.set(name, f);
    let lot = freeLot(f);
    if (lot < 0) {
      relot();
      lot = freeLot(f);
    }
    // A wound-up firm's rubble is cleared for the newcomer.
    const old = firms.find((o) => o !== f && o.lot === lot);
    if (old) old.lot = -1;
    f.lot = Math.max(0, lot);
    fitLot(f);
    f.x = f.tx;
    liveBox(f);
    if (live) agents.push({ f, x: null, tx: null, color: f.color, bubble: "", bubbleColor: "#fff", until: 0, carry: false, walking: false });
    for (const p of walkers) if (Math.abs(p.x - f.x) < 40) emote(p, "^", GREEN, 3);
    log(`${name} · <b>new firm</b>, building`);
    return f;
  }

  function rename(f, name) {
    if (byName.get(f.name) === f) byName.delete(f.name);
    f.name = name;
    byName.set(name, f);
  }

  // After a takeover the bought tower slides onto a lot next to its buyer (an empty one if there is one).
  function migrate(t, bu) {
    if (t.phase !== "standing" || bu.phase !== "standing" || t.lot < 0 || bu.lot < 0) return;
    const half = Math.ceil(lots.length / 2);
    const near = [bu.lot - 1, bu.lot + 1, bu.lot - 2, bu.lot + 2].filter((l) => l >= 0 && l < lots.length && l < half === bu.lot < half);
    if (near.includes(t.lot)) return;
    const holder = (l) => firms.find((o) => o !== t && o.lot === l && o.phase !== "gone");
    const dest = near.find((l) => !holder(l) || holder(l).phase === "rubble") ?? near[0];
    if (dest === undefined) return;
    const other = holder(dest);
    if (other) {
      other.lot = other.phase === "rubble" ? -1 : t.lot;
      if (other.lot >= 0) fitLot(other);
    }
    t.lot = dest;
    fitLot(t);
    t.moving = !still;
    if (still) for (const f of [t, other]) if (f && f.lot >= 0) {
      f.x = f.tx;
      liveBox(f);
    }
  }

  function collapse(f) {
    if (f.phase !== "standing") return;
    if (still) {
      // Reduced motion: the outcome without the fall.
      Object.assign(f, { phase: "rubble", floors: 0, sink: 0, forSale: false, closeDue: null });
      liveBox(f);
      makeRubble(f);
      const g = agents.find((x) => x.f === f);
      if (g) g.hidden = true;
      return;
    }
    f.phase = "collapsing";
    f.forSale = false;
    f.closeDue = null;
    f.sinkV = 3;
    shake = 0.9;
    const g = agentOf(f.name);
    if (g) emote(g, "!", RED, 4);
    for (const p of walkers) {
      emote(p, "!", RED, 3);
      if (Math.abs(p.x - (f.x + f.w / 2)) < 30) {
        p.tx = p.x < f.x + f.w / 2 ? Math.max(2, p.x - 30) : Math.min(W - 2, p.x + 30);
        p.run = 3;
      }
    }
    log(`${f.name} · <b>wound up</b>, the tower comes down`, "bad");
  }

  function absorb(f, buyer) {
    if (f.phase !== "standing") return;
    if (still) {
      Object.assign(f, { phase: "gone", forSale: false, closeDue: null });
      const g = agents.find((x) => x.f === f);
      if (g) Object.assign(g, { f: buyer, color: buyer.color, x: door(buyer), tx: door(buyer) });
      buyer.bonus += Math.min(4, Math.max(1, Math.ceil(f.floors / 3)));
      retarget(buyer);
      buyer.floors = buyer.floorsTarget;
      liveBox(buyer);
      return;
    }
    f.phase = "absorbing";
    f.forSale = false;
    f.closeDue = null;
    f.into = buyer;
    f.absorbAt = clock + 2; // let the repaint show first; the floors leave once it has reached its buyer
    buyer.bonus += Math.min(4, Math.max(1, Math.ceil(f.floors / 3)));
    retarget(buyer);
    const g = agents.find((x) => x.f === f);
    if (g) {
      g.f = buyer;
      g.color = buyer.color;
      g.tx = door(buyer);
    }
    log(`${buyer.name} <b>absorbs</b> ${f.name}`);
  }

  function closeFirm(f, reason) {
    if (!f || f.phase !== "standing") return;
    const buyer = f.owner ? byName.get(f.owner) : null;
    if (buyer && buyer.phase === "standing" && (!reason || /owner/.test(reason))) absorb(f, buyer);
    else collapse(f);
  }

  function makeRubble(f) {
    const r = rng(f.index * 31 + 7);
    f.rubble = Array.from({ length: f.w }, (_, i) => Math.max(1, Math.round(Math.sin((Math.PI * (i + 0.5)) / f.w) * 4 + r() * 2 - 0.5)));
  }

  // Reactions to the chain events, on top of what the towers and the traders already do.
  function gameAct(s) {
    const f = s.firm ? byName.get(s.firm) : null;
    const g = s.firm ? agentOf(s.firm) : null;
    switch (s.do) {
      case "order":
        for (const p of walkers) if (Math.random() < 0.4) emote(p, "?", "#fff", 2);
        break;
      case "win":
        if (g) emote(g, "$", AMBER, 3);
        for (const o of agents) if (o !== g && o.tx !== null && Math.abs(o.tx - hallX()) < 40) emote(o, "x", "#b9a7c9", 2);
        break;
      case "fill":
        if (f) burst(f.x + f.w / 2, f.box.top - 1, 10, { color: AMBER, spread: f.w / 2, up: 18, g: 40, life: 1 });
        for (const p of walkers) if (f && Math.abs(p.x - (f.x + f.w / 2)) < 26) emote(p, "<3", "#ff9fc4", 2.5);
        break;
      case "slash":
        if (g) emote(g, "!", RED, 3);
        shake = Math.max(shake, 0.3);
        break;
      case "epoch":
        if (!s.liquidating) break;
        if (g) emote(g, "!", RED, 4);
        for (const o of agents) if (o !== g) emote(o, "$", AMBER, 3);
        break;
      case "takeover": {
        const t = byName.get(s.target);
        const bu = byName.get(s.buyer);
        if (!t) break;
        t.brand = s.buyer;
        t.exName = t.exName ?? t.name;
        if (bu) migrate(t, bu);
        const tb = agentOf(s.buyer);
        if (tb) emote(tb, "$", GREEN, 4);
        break;
      }
      case "close":
        closeFirm(f, s.reason);
        break;
    }
  }

  function simulateLive(dt) {
    simulateWeather(dt);
    shake = Math.max(0, shake - dt * 1.5);
    parallax += (parallaxTarget - parallax) * Math.min(1, dt * 3);
    tickerX += dt * 26;
    for (const f of firms) {
      if (f.phase === "gone" || f.lot < 0) continue;
      if (f.closeDue !== null && clock > f.closeDue) closeFirm(f, null);
      // Slide to its lot after a takeover, kicking up dust.
      if (f.x !== f.tx) {
        const d = f.tx - f.x;
        const v = (f.moving ? 44 : 30) * dt;
        f.x = Math.abs(d) <= v ? f.tx : f.x + Math.sign(d) * v;
        if (Math.random() < dt * 20) burst(f.x + (d > 0 ? 0 : f.w), G, 2, { spread: 3, up: 4, g: 8, life: 0.8 });
        if (f.x === f.tx) f.moving = false;
      }
      if (f.phase === "collapsing") {
        f.sinkV += dt * 26;
        f.sink += f.sinkV * dt;
        if (Math.random() < dt * 40) burst(f.x + Math.random() * f.w, G, 3, { spread: f.w / 3, up: 7, g: 6, life: 1.6, s: 2 });
        if (Math.random() < dt * 14) burst(f.x + Math.random() * f.w, f.box.top, 1, { color: "#3a2a46", spread: 2, up: 6, g: 60, life: 1.2, s: 2 });
        liveBox(f);
        if (f.sink >= f.box.h) {
          f.phase = "rubble";
          f.sink = 0;
          f.floors = 0;
          liveBox(f);
          makeRubble(f);
          burst(f.x + f.w / 2, G, 30, { spread: f.w, up: 10, g: 5, life: 2.2, s: 2 });
          const g = agents.find((x) => x.f === f);
          if (g) g.hidden = true;
        }
        continue;
      }
      if (f.phase === "rubble") continue;
      // A floor at a time toward its target: up under a crane, down with debris (or into its buyer).
      f.growT += dt;
      const waiting = f.phase === "absorbing" && (f.moving || clock < f.absorbAt);
      const target = f.phase === "absorbing" ? (waiting ? f.floors : 0) : f.floorsTarget;
      if (f.floors < target && f.growT > (f.building ? 0.3 : 0.5)) {
        f.floors++;
        f.growT = 0;
        burst(f.x + f.w / 2, G - 6 - f.floors * 4, 3, { color: AMBER, spread: f.w / 2, up: 5, g: 20, life: 0.5 });
      } else if (f.floors > target && f.growT > (f.phase === "absorbing" ? 0.28 : 0.35)) {
        f.floors--;
        f.growT = 0;
        if (f.phase === "absorbing") fly("block", () => roof(f), () => roof(f.into), { color: f.sign, dur: 0.9, arc: 20 });
        else burst(f.x + f.w / 2, f.box.top, 4, { color: "#3a2a46", spread: f.w / 2, up: 4, g: 50, life: 0.9 });
      }
      if (f.building && f.floors >= target) f.building = false;
      if (f.phase === "absorbing" && f.floors <= 0) f.phase = "gone";
      liveBox(f);
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y = Math.min(G + 1, p.y + p.vy * dt);
      p.life -= dt;
      if (p.life <= 0) parts.splice(i, 1);
    }
    for (const p of walkers) {
      if (p.x === null) p.x = p.tx = 4 + Math.random() * (W - 8);
      const d = p.tx - p.x;
      const v = (p.run > 0 ? 34 : p.speed) * dt;
      p.run = Math.max(0, p.run - dt);
      p.walking = Math.abs(d) > 0.5;
      p.x += Math.abs(d) <= v ? d : Math.sign(d) * v;
      if (!p.walking) {
        p.wait -= dt;
        if (p.wait <= 0) {
          p.tx = Math.max(3, Math.min(W - 3, p.x + (Math.random() - 0.5) * W * 0.5));
          p.wait = 2 + Math.random() * 5;
        }
      }
    }
  }

  function drawCrane(f) {
    // A tower crane on the roof while the firm grows: mast, jib, a block on its cable.
    const { x, w, top } = f.box;
    const mx = Math.round(x + w - 3);
    const mt = top - 13;
    a.fillStyle = "#e8b04a";
    for (let y = mt; y < top; y += 2) a.fillRect(mx, y, 1, 1);
    a.fillRect(mx + 1, mt, 1, top - mt);
    const jib = Math.max(8, Math.round(w * 0.9));
    a.fillRect(mx - jib, mt, jib + 5, 1);
    a.fillStyle = "#6b4b2a";
    a.fillRect(mx + 3, mt + 1, 3, 2); // counterweight
    const hx = Math.round(mx - jib * (0.45 + 0.35 * Math.sin(clock * 0.8 + f.index)));
    const drop = 3 + Math.round(4 + 3 * Math.sin(clock * 1.7 + f.index));
    a.fillStyle = "rgba(232,176,74,0.7)";
    a.fillRect(hx, mt + 1, 1, drop);
    a.fillStyle = f.sign;
    a.fillRect(hx - 1, mt + 1 + drop, 3, 2);
    // Scaffolding on the floor being built.
    a.fillStyle = "rgba(232,176,74,0.55)";
    for (let i = 0; i <= w; i += 2) a.fillRect(Math.round(x + i), top + ((i / 2) % 2), 1, 1);
    a.fillRect(Math.round(x - 1), top, 1, 6);
    a.fillRect(Math.round(x + w), top, 1, 6);
  }

  function drawRubble(f) {
    if (!f.rubble) makeRubble(f);
    const x0 = Math.round(f.x);
    f.rubble.forEach((h, i) => {
      a.fillStyle = "#24182f";
      a.fillRect(x0 + i, G - h, 1, h);
      if ((i * 7 + h) % 5 === 0) {
        a.fillStyle = "#4a2c48";
        a.fillRect(x0 + i, G - h, 1, 1);
      }
    });
  }

  // ------------------------------------------------------------------ live city: weather, from the market regime

  // calm keeps the dusk; alert darkens the sky under drifting clouds; storm adds pixel rain and lightning that
  // lights the towers. Live only: the replay draws exactly what it drew. Without frames (reduced motion) the
  // sky and the rain stand still and no lightning strikes.
  let weather = "calm";
  let bolt = 0; // seconds left of the current flash
  let boltX = 0.5;
  let nextBolt = 3;
  let rain = null; // drops, made on the first storm

  function simulateWeather(dt) {
    bolt = Math.max(0, bolt - dt);
    if (weather !== "storm" || dt <= 0) return;
    if ((nextBolt -= dt) <= 0) {
      bolt = 0.4;
      boltX = 0.1 + Math.random() * 0.8;
      nextBolt = 4 + Math.random() * 8;
    }
  }

  function drawWeatherSky() {
    if (weather === "calm") return;
    const storm = weather === "storm";
    a.globalAlpha = storm ? 0.6 : 0.4;
    a.fillStyle = "#06040b";
    a.fillRect(0, 0, W, G);
    a.globalAlpha = 1;
    // Flat pixel clouds drifting right, wrapping round.
    a.fillStyle = storm ? "#1f1828" : "#2b2135";
    for (let i = 0; i < (storm ? 8 : 5); i++) {
      const w = 18 + ((i * 37) % 26);
      const x = (((i * 0.29 + clock * (0.006 + (i % 3) * 0.003)) % 1.25) - 0.15) * W;
      const y = 3 + ((i * 11) % Math.max(6, Math.round(G * 0.3)));
      a.fillRect(Math.round(x), y, w, 3);
      a.fillRect(Math.round(x + 3), y - 2, w - 8, 2);
      a.fillRect(Math.round(x + 1), y + 3, w - 3, 1);
    }
  }

  function drawStorm() {
    if (weather !== "storm") return;
    // Rain: thin slanted streaks at three speeds, from a seeded list so a still frame stays put.
    rain ??= ((r) => Array.from({ length: 240 }, (_, i) => ({ x: r(), y: r(), v: 90 + (i % 3) * 25 })))(rng(97));
    a.fillStyle = "#9fb4ff";
    a.globalAlpha = 0.35;
    for (let i = 0, n = Math.min(rain.length, Math.round(W / 3)); i < n; i++) {
      const d = rain[i];
      const y = ((d.y * (H + 8) + clock * d.v) % (H + 8)) - 4;
      a.fillRect(Math.round(d.x * (W + 20) - 10 - y * 0.12), Math.round(y), 1, 3);
    }
    a.globalAlpha = 1;
    if (bolt <= 0) return;
    // Lightning: the sky flashes, a bolt drops and every standing tower lights up.
    const k = Math.min(1, bolt / 0.4);
    a.globalAlpha = 0.18 * k;
    a.fillStyle = "#e9e4ff";
    a.fillRect(0, 0, W, H);
    a.globalAlpha = 0.45 * k;
    for (const f of firms) if (f.phase === "standing" && f.lot >= 0 && f.box) a.fillRect(Math.round(f.box.x), f.box.top, f.box.w, f.box.h);
    a.globalAlpha = k;
    const r = rng(Math.round(boltX * 1e6));
    let x = boltX * W;
    for (let y = 0; y < G * 0.55; y += 3) {
      x += Math.round((r() - 0.5) * 4);
      a.fillRect(Math.round(x), y, 1, 3);
    }
    a.globalAlpha = 1;
  }

  function drawParts() {
    for (const p of parts) {
      a.globalAlpha = Math.max(0, Math.min(1, p.life / p.max)) * 0.85;
      a.fillStyle = p.color;
      a.fillRect(Math.round(p.x), Math.round(p.y), p.s, p.s);
    }
    a.globalAlpha = 1;
  }

  function drawEmote(e, x, feet) {
    if (!e || e.until < clock) return;
    const g = GLYPHS[e.glyph];
    if (!g) return;
    const bx = Math.round(x);
    const by = feet - 19;
    a.globalAlpha = Math.min(1, (e.until - clock) * 3);
    a.fillStyle = "rgba(18,12,25,0.92)";
    a.fillRect(bx, by, 5, 7);
    a.fillRect(bx + 2, by + 7, 1, 1); // the tail
    a.fillStyle = e.color;
    g.forEach((row, r) => [...row].forEach((c, k) => c === "X" && a.fillRect(bx + 1 + k, by + 1 + r, 1, 1)));
    a.globalAlpha = 1;
  }

  // The stock ticker along the top: share price (value / 100 shares) and its change since the page opened.
  function drawTicker() {
    const items = firms.filter((f) => f.phase !== "gone" && f.nav !== null && f.nav0);
    if (!items.length) return;
    const h = Math.round(18 * dpr);
    ctx.fillStyle = "rgba(8,5,12,0.85)";
    ctx.fillRect(0, 0, canvas.width, h);
    ctx.fillStyle = "rgba(246,215,167,0.22)";
    ctx.fillRect(0, h - dpr, canvas.width, dpr);
    ctx.font = `${Math.round(11 * dpr)}px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const segs = items.map((f) => {
      const dead = f.phase === "rubble" || f.phase === "collapsing";
      const pct = ((f.nav - f.nav0) / f.nav0) * 100;
      const up = pct >= 0;
      return [
        [(f.brand ?? f.name).toUpperCase() + " ", f.brand ? f.sign : f.color],
        dead ? ["CLOSED", RED] : [(f.nav / 100).toFixed(2) + " ", "#fff"],
        dead ? ["", "#fff"] : [`${up ? "▲" : "▼"}${Math.abs(pct).toFixed(2)}%`, up ? GREEN : RED],
      ];
    });
    const sep = 28 * dpr;
    const widths = segs.map((s) => s.reduce((n, [t]) => n + ctx.measureText(t).width, 0) + sep);
    const total = widths.reduce((n, w) => n + w, 0);
    let x = -((tickerX * dpr) % total);
    const y = h / 2 + dpr;
    while (x < canvas.width) {
      segs.forEach((s, i) => {
        let cx = x;
        for (const [t, c] of s) {
          ctx.fillStyle = c;
          ctx.fillText(t, cx, y);
          cx += ctx.measureText(t).width;
        }
        x += widths[i];
      });
    }
    ctx.textBaseline = "alphabetic";
  }

  // ------------------------------------------------------------------ simulation

  function simulate(dt) {
    clock += dt;
    moveAgents(dt);
    if (live) simulateLive(dt);
    explore += (exploreTarget - explore) * Math.min(1, dt * 3);
    job.on += (job.target - job.on) * Math.min(1, dt * 2.2);
    job.x += (job.tx - job.x) * Math.min(1, dt * (job.target ? 1.3 : 0.7));
    for (const f of firms) {
      f.pulse = Math.max(0, f.pulse - dt);
      f.flash = Math.max(0, f.flash - dt * 0.9);
      const working = f.state === "working";
      // Windows follow the firm's health; while it works they switch on floor by floor.
      f.lights.forEach((l, i) => {
        if (Math.random() < dt * (working ? 2.5 : 0.25)) {
          const row = Math.floor(i / f.box.cols);
          const floorBias = working ? (1 - row / f.box.rows) * 0.3 : 0;
          l.v = Math.random() < f.lit + floorBias ? 1 : 0;
        }
        l.on += (l.v - l.on) * Math.min(1, dt * 6);
      });
    }
    for (const c of cars) c.x = (c.x + c.v * dt + 1) % 1;
    for (const fl of flyers) {
      if (fl.delay > 0) fl.delay -= dt;
      else fl.t += dt / fl.dur;
    }
    for (let i = flyers.length - 1; i >= 0; i--) if (flyers[i].t >= 1) flyers.splice(i, 1);
    for (let i = labels.length - 1; i >= 0; i--) if (clock > labels[i].until + 0.5) labels.splice(i, 1);
  }

  // ------------------------------------------------------------------ drawing

  function px(x, y, w = 1, h = 1) {
    a.fillRect(Math.round(x), Math.round(y), w, h);
  }

  function drawStars() {
    for (const s of stars) {
      const v = 0.5 + 0.5 * Math.sin(clock * 1.3 + s.p);
      if (v < 0.4) continue;
      a.globalAlpha = v * 0.9;
      a.fillStyle = "#fff";
      px(s.x * W, s.y * G);
    }
    a.globalAlpha = 1;
  }

  function drawSkyline() {
    for (const blk of skyline) {
      const x = blk.x + (live ? parallax * (blk.layer ? 1.5 : 3) : 0);
      a.fillStyle = blk.layer ? "#1e1029" : "#2c1735";
      a.fillRect(Math.round(x), G - blk.h, blk.w, blk.h);
      // Sparse lit windows in the far city, slowly changing.
      const r = rng(blk.seed + Math.floor(clock / 4 + blk.seed % 5));
      a.fillStyle = blk.layer ? "#8a5a6e" : "#6b3f5e";
      for (let y = G - blk.h + 2; y < G - 1; y += 3) for (let xx = 1; xx < blk.w - 1; xx += 2) if (r() < 0.12) px(x + xx, y);
    }
    // Low pink haze over the far city.
    for (let y = G - 10; y < G; y++) {
      a.globalAlpha = ((y - (G - 10)) / 10) * 0.35;
      a.fillStyle = "#a8506f";
      for (let x = (y % 2); x < W; x += 2) px(x, y);
    }
    a.globalAlpha = 1;
  }

  function drawTower(f) {
    const { x: x0, w, h, top, cols, rows } = f.box;
    const x = x0;
    const lightSide = x + w / 2 < W / 2 ? "right" : "left"; // the sun sets in the middle
    a.fillStyle = "#170f22";
    a.fillRect(Math.round(x), top, w, h);
    // Sunset rim on the side that faces the sun.
    a.fillStyle = f.flash > 0 ? mix("#7c3a5f", f.flashColor, Math.min(1, f.flash)) : "#7c3a5f";
    a.fillRect(Math.round(lightSide === "right" ? x + w - 1 : x), top, 1, h);
    a.fillStyle = "#2a1a36";
    a.fillRect(Math.round(lightSide === "right" ? x : x + w - 1), top, 1, h);
    // Roof furniture.
    a.fillStyle = "#170f22";
    if (f.roofStyle === 0) a.fillRect(Math.round(x + w / 2), top - 6, 1, 6);
    if (f.roofStyle === 1) a.fillRect(Math.round(x + 2), top - 3, Math.max(3, Math.round(w / 3)), 3);
    if (f.roofStyle === 2) {
      a.fillRect(Math.round(x + w * 0.2), top - 2, Math.round(w * 0.6), 2);
      a.fillRect(Math.round(x + w / 2), top - 5, 1, 3);
    }
    if (Math.sin(clock * 3 + f.index) > 0.2) {
      a.fillStyle = RED;
      px(x + (f.roofStyle === 1 ? 3 : w / 2), top - (f.roofStyle === 0 ? 7 : f.roofStyle === 2 ? 6 : 4));
    }
    // Windows: warm light, tinted by the owner after a takeover.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const l = f.lights[r * cols + c];
        const wx = x + 2 + c * 3;
        const wy = top + 4 + r * 4;
        if (l.on < 0.08) {
          a.fillStyle = "#24182f";
        } else {
          const base = l.warm < 0.75 ? f.tint : "#cfe6ff";
          a.fillStyle = l.on > 0.7 ? base : mix("#24182f", base, l.on);
        }
        a.fillRect(Math.round(wx), wy, 2, 2);
      }
    }
    // Neon sign on the roof edge, in the colour of the firm (or of its new owner).
    a.fillStyle = f.forSale ? (Math.sin(clock * 6) > 0 ? RED : "#5a2030") : f.sign;
    a.globalAlpha = 0.85 + f.pulse * 0.15;
    a.fillRect(Math.round(x + 1), top, w - 2, 1);
    a.globalAlpha = 1;
  }

  function drawStreet() {
    a.fillStyle = "#0f0a16";
    a.fillRect(0, G, W, H - G);
    a.fillStyle = "#2a1a36";
    a.fillRect(0, G, W, 1);
    for (const c of cars) {
      const y = G + (c.v > 0 ? 3 : 5);
      a.fillStyle = c.v > 0 ? "#ffd9a8" : "#ff6b6b";
      px(c.x * W, y, 2, 1);
      a.globalAlpha = 0.35;
      px(c.x * W - (c.v > 0 ? 3 : -3), y, 2, 1);
      a.globalAlpha = 1;
    }
    // Reflections of the lit towers on the wet street.
    for (const f of firms) {
      if (live && (f.phase !== "standing" || f.lot < 0)) continue;
      a.globalAlpha = 0.12 + f.pulse * 0.1;
      a.fillStyle = f.sign;
      for (let y = G + 2; y < Math.min(H, G + 10); y += 2) a.fillRect(Math.round(f.box.x + 1), y, f.box.w - 2, 1);
    }
    a.globalAlpha = 1;
  }

  function drawJob() {
    if (job.on < 0.02 && job.x > 1.1) return;
    const p = jobPos();
    a.globalAlpha = Math.min(1, job.on * 1.5 + 0.2);
    // A small airship carries the order across the sky.
    a.fillStyle = "#e9d8ff";
    a.fillRect(Math.round(p.x - 9), Math.round(p.y - 3), 18, 6);
    a.fillRect(Math.round(p.x - 7), Math.round(p.y - 4), 14, 8);
    a.fillStyle = "#b79fd8";
    a.fillRect(Math.round(p.x - 9), Math.round(p.y + 1), 18, 2);
    a.fillStyle = "#6b4b8a";
    a.fillRect(Math.round(p.x - 3), Math.round(p.y + 4), 6, 2);
    a.fillRect(Math.round(p.x + 9), Math.round(p.y - 2), 2, 4);
    a.globalAlpha = 1;
  }

  function lerpArc(from, to, t, arc) {
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t - Math.sin(Math.PI * t) * arc };
  }

  function drawFlyers() {
    for (const fl of flyers) {
      if (fl.delay > 0) continue;
      const from = fl.from();
      const to = fl.to();
      const e = fl.t * fl.t * (3 - 2 * fl.t);
      if (fl.kind === "beam") {
        a.fillStyle = fl.color;
        for (let s = 0; s < e; s += 0.04) {
          const q = lerpArc(from, to, s, 0);
          a.globalAlpha = 0.85 * (1 - fl.t * 0.6);
          px(q.x, q.y);
        }
        a.globalAlpha = 1;
        continue;
      }
      const q = lerpArc(from, to, e, fl.arc);
      a.fillStyle = fl.color;
      if (fl.kind === "packet") {
        for (let k = 1; k <= 3; k++) {
          const tr = lerpArc(from, to, Math.max(0, e - k * 0.04), fl.arc);
          a.globalAlpha = 0.5 - k * 0.12;
          px(tr.x, tr.y);
        }
        a.globalAlpha = 1;
        px(q.x - 1, q.y - 1, 3, 2);
      } else if (fl.kind === "coin") {
        px(q.x, q.y, 2, 2);
        a.fillStyle = "#fff";
        a.globalAlpha = 0.6;
        px(q.x, q.y);
        a.globalAlpha = 1;
      } else if (fl.kind === "block") {
        px(q.x - 1, q.y - 1, 3, 2);
      } else if (fl.kind === "key") {
        a.globalAlpha = 1 - fl.t;
        px(q.x, q.y, 3, 3);
        px(q.x + 3, q.y + 1, 4, 1);
        px(q.x + 5, q.y + 2, 1, 1);
        a.globalAlpha = 1;
      }
    }
  }

  function text(str, x, y, color, size = 11, align = "center", alpha = 1) {
    ctx.globalAlpha = alpha;
    ctx.font = `${Math.round(size * dpr)}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgba(10,6,16,0.85)";
    ctx.fillText(str, x * S + dpr, y * S + dpr);
    ctx.fillStyle = color;
    ctx.fillText(str, x * S, y * S);
    ctx.globalAlpha = 1;
  }

  function drawLabels() {
    const live = mode === "live";
    // On a phone the towers are too close for names in the hero view: only the order and the arena show text.
    const crowded = W * 4 < 900 && !live && explore < 0.5;
    // The live city with more towers than a dashboard card fits (three markets): names only, smaller.
    const packed = live && canvas.clientWidth < 1100 && firms.filter((f) => f.phase !== "gone" && f.lot >= 0).length > 8;
    if (crowded) {
      if (job.on > 0.05 && job.label) text(job.label, jobPos().x, jobPos().y - 7, "#fff", 12, "center", Math.min(1, job.on));
      return;
    }
    for (const f of firms) {
      if (live && (f.phase === "gone" || f.phase === "collapsing" || f.lot < 0)) continue;
      const r = roof(f);
      const x = r.x;
      const top = f.box.top - 9 - (live && f.phase === "standing" && f.floors < f.floorsTarget ? 13 : 0);
      // Names stay quiet in the hero and come forward in the arena view and on the dashboard.
      const show = live ? (f.phase === "rubble" ? 0.5 : 1) : 0.55 + 0.45 * explore;
      const title = live && f.brand ? f.brand : f.name;
      const sub = !live ? f.status : f.phase === "rubble" ? "wound up" : f.building ? "under construction" : f.forSale ? "for sale" : f.exName ? `ex ${f.exName}` : f.status;
      text(title.toUpperCase(), x, top, f.forSale ? RED : f.sign, W * 4 < 900 || packed ? 10 : 12, "center", show);
      // On a phone, or with more towers than the width fits, the live city shows names only: the status lines
      // would run into each other.
      if ((live && canvas.clientWidth >= 720 && !packed) || (!live && explore > 0.05)) text(f.forSale && !live ? "for sale" : sub, x, top + 4, "rgba(255,255,255,0.75)", 11, "center", live ? 0.9 * show : explore);
    }
    // Event labels stack above their tower, newest on top, so two never sit on each other.
    const stack = new Map();
    for (let i = labels.length - 1; i >= 0; i--) {
      const l = labels[i];
      const n = stack.get(l.f) ?? 0;
      stack.set(l.f, n + 1);
      const age = clock - l.born;
      const alpha = Math.min(1, age * 4) * Math.min(1, Math.max(0, (l.until + 0.5 - clock) * 2));
      const r = roof(l.f);
      text(l.text, r.x, l.f.box.top - 15 - n * 5 - Math.min(3, age * 2), l.color, 13, "center", alpha);
    }
    if (job.on > 0.05 && job.label) {
      const p = jobPos();
      text(job.label, p.x, p.y - 7, "#fff", 13, "center", Math.min(1, job.on));
    }
  }

  function draw() {
    a.drawImage(back, 0, 0);
    drawStars();
    if (live) drawWeatherSky();
    drawSkyline();
    drawJob();
    if (live) {
      // A tower sliding to its buyer passes behind the others, down a back street.
      for (const f of firms) if (f.moving) drawLiveTower(f);
      for (const f of firms) if (!f.moving) drawLiveTower(f);
    } else for (const f of firms) drawTower(f);
    drawStreet();
    if (live) drawParts();
    if (live) drawAgents();
    drawFlyers();
    if (live) drawStorm();
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const jolt = () => (live && shake > 0 ? Math.round((Math.random() - 0.5) * shake * 3) * S : 0);
    ctx.drawImage(art, jolt(), jolt(), W * S, H * S);
    drawLabels();
    if (live) drawBubbles();
    if (live) drawTicker();
  }

  function drawLiveTower(f) {
    if (f.phase === "gone" || f.lot < 0) return;
    if (f.phase === "rubble") return drawRubble(f);
    drawTower(f);
    if (f.phase === "standing" && f.floors < f.floorsTarget) drawCrane(f);
  }

  // ------------------------------------------------------------------ loop

  function step(dt) {
    if (mode === "replay") runStory(dt);
    simulate(dt);
    draw();
  }


  layout();
  document.fonts?.load(`11px ${FONT}`).then(() => draw(), () => {});

  // QA helpers: ?t=24 jumps to second 24 of the replay, &still draws one frame.
  const query = new URLSearchParams(debugQuery ? location.search : "");
  if (mode === "replay" && query.has("t")) {
    const t = Math.min(STORY_LENGTH, Number(query.get("t")) || 0);
    for (let s = 0; s < t; s += 1 / 30) {
      runStory(1 / 30);
      simulate(1 / 30);
    }
    draw();
  }
  const still = reducedMotion || query.has("still");

  let raf = 0;
  let last = performance.now();
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (document.hidden) return;
    step(dt);
  }
  if (still) step(0);
  else raf = requestAnimationFrame(frame);

  return {
    act(storyStep) {
      if (live && !still) {
        queue.push(storyStep);
        // A hidden tab piles events up: apply the old ones at once so the city never lags far behind.
        while (queue.length > 24) {
          const st = queue.shift();
          ACTIONS[st.do]?.(st);
          agentAct(st);
          gameAct(st);
        }
        return;
      }
      ACTIONS[storyStep.do]?.(storyStep);
      if (live) {
        agentAct(storyStep);
        gameAct(storyStep);
      }
      if (still) step(0);
    },
    resize() {
      layout();
      draw();
    },
    setCalmRect(rect) {
      if (!rect) return;
      calm = rect;
      layout();
      draw();
    },
    setHorizon() {},
    setPaused(paused) {
      if (paused) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (!raf && !still) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    },
    // Live city: the firms as the chain reports them, polled ({ id, name, nav (USDC), fills, status,
    // takeovers }), and the NEAR price for the exchange's board.
    setFirms(list, m = {}) {
      if (!live) return;
      if (m.price) market.price = m.price;
      let added = false;
      for (const it of list) {
        let f = firms.find((x) => x.id === it.id) ?? firms.find((x) => x.id === null && x.name === it.name);
        if (!f) {
          f = addFirm(it.name);
          if (!started) f.building = false;
          added = true;
        }
        f.id = it.id;
        if (it.name !== f.name) rename(f, it.name);
        f.fills = it.fills ?? 0;
        if (typeof it.nav === "number") {
          f.nav = it.nav;
          // A firm registered before it is funded: its value is measured from its first funded poll.
          if (f.nav0 === null && it.nav > 0) f.nav0 = it.nav;
        }
        if (f.phase === "standing") f.forSale = it.status === "Liquidating";
        if (it.status === "Closed" && f.phase === "standing") {
          if (!started) {
            // Closed before the page opened: an empty lot if a rival absorbed it, rubble if it was wound up.
            f.phase = it.takeovers > 0 ? "gone" : "rubble";
            f.floors = 0;
            liveBox(f);
            const g = agents.find((x) => x.f === f);
            if (g) g.hidden = true;
          } else f.closeDue ??= clock + 12; // its event should come first and say how it closed
        }
        retarget(f);
        if (!started || still) f.floors = f.phase === "standing" ? f.floorsTarget : 0;
        liveBox(f);
      }
      if (added) relot();
      started = true;
      if (still) step(0);
    },
    /** The firm under a point of the page (client coordinates), or null. */
    pick(clientX, clientY) {
      if (!live) return null;
      const r = canvas.getBoundingClientRect();
      const x = ((clientX - r.left) / r.width) * W;
      const y = ((clientY - r.top) / r.height) * H;
      for (let i = firms.length - 1; i >= 0; i--) {
        const f = firms[i];
        if (f.phase === "gone" || f.lot < 0 || !f.box || f.id === null) continue;
        const top = f.phase === "rubble" ? G - 8 : f.box.top - 12;
        if (x >= f.box.x - 1 && x <= f.box.x + f.box.w + 1 && y >= top && y <= G + 2) return { id: f.id, name: f.name };
      }
      return null;
    },
    /** Live city: the market regime as weather, "calm", "alert" or "storm". */
    setWeather(level) {
      if (!live) return;
      const next = level === "storm" || level === "alert" ? level : "calm";
      if (next === weather) return;
      weather = next;
      if (still) step(0);
    },
    /** -1 to 1: where the pointer is across the page, for a little depth in the far skyline. */
    setParallax(v) {
      parallaxTarget = Math.max(-1, Math.min(1, v));
    },
    setExplore(on) {
      exploreTarget = on ? 1 : 0;
      if (still) {
        explore = exploreTarget;
        step(0);
      }
    },
    dispose() {
      cancelAnimationFrame(raf);
    },
  };
}
