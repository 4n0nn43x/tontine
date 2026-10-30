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
  const pointer = { x: 0, tx: 0 };

  const names = firmNames ?? FIRMS.map((f) => f.name);
  const firms = names.map((name, i) => {
    const def = FIRMS.find((f) => f.name === name) ?? EXTRA_SLOTS[i % EXTRA_SLOTS.length];
    const r = rng(i * 7919 + name.length * 31);
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
    };
  });
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
    for (const f of firms) placeTower(f, px);
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
    job({ id, budget, brief }) {
      job.id = id;
      job.label = `JOB #${id} · ${budget} USDC`;
      job.target = 1;
      job.x = -0.15;
      job.tx = 0.5;
      onPhase?.(0);
      log(`<b>job #${id}</b> · ${budget} USDC · ${brief}`);
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
    win({ firm, price }) {
      const f = byName.get(firm);
      if (!f) return;
      f.pulse = 1.6;
      f.flash = 1;
      f.flashColor = GREEN;
      say(f, `wins · pays ${price}`, GREEN, 3);
      setStatus(f, "won the job");
      fly("beam", () => jobPos(), () => roof(f), { color: GREEN, dur: 0.9, arc: 0 });
      log(`<b>${firm}</b> wins at the 2nd price ${price}`);
    },
    work({ firm, empty }) {
      const f = byName.get(firm);
      if (!f) return;
      f.state = empty ? "idle" : "working";
      f.lit = empty ? 0.2 : 0.95;
      setStatus(f, empty ? "delivers nothing" : "working");
      log(empty ? `${firm} delivers <b>nothing</b>` : `${firm} delivers the work`);
    },
    verdict({ firm, accept }) {
      const f = byName.get(firm);
      if (!f) return;
      f.flash = 1;
      f.flashColor = accept ? GREEN : RED;
      say(f, accept ? "accepted" : "rejected", accept ? GREEN : RED, 2.2);
      onPhase?.(accept ? 3 : 4);
      if (accept) log(`judge · <b>accepted</b>`);
      else log(`judge · <b>rejected</b>`, "bad");
    },
    pay({ firm, price, dividends }) {
      const f = byName.get(firm);
      if (!f) return;
      // The price comes down from the client's job to the firm, then 30% spills out to the holders.
      for (let i = 0; i < 9; i++) fly("coin", () => jobPos(), () => roof(f), { delay: i * 0.08, dur: 1, arc: 14 });
      for (let i = 0; i < 12; i++) {
        const dx = (i - 6) * 3.5;
        fly("coin", () => roof(f), () => ({ x: roof(f).x + dx * 2.2, y: G + 3 }), { delay: 1.1 + i * 0.05, dur: 1.1, arc: 16 });
      }
      f.lit = 0.6;
      f.state = "idle";
      setStatus(f, `paid ${price}`);
      setTimeout(() => say(f, `+${dividends} to holders`, AMBER, 2.6), reducedMotion ? 0 : 1100);
      log(`paid ${price} · <b>${dividends} to shareholders</b>`);
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
      log(`owner bond <b>−${bond}</b> to the client`, "bad");
    },
    jobEnd() {
      job.target = 0;
      job.tx = 1.2;
      for (const f of firms) if (f.state === "working") f.state = "idle";
    },
    epoch({ firm, n, liquidating }) {
      const f = byName.get(firm);
      if (!f) return;
      f.lit = liquidating ? 0.04 : 0.12;
      if (liquidating) {
        f.forSale = true;
        onPhase?.(5);
      }
      setStatus(f, liquidating ? "for sale" : `under the floor ${n}/2`);
      log(liquidating ? `${firm} · <b>liquidating</b>` : `${firm} under the floor ${n}/2`, "bad");
    },
    takeover({ buyer, target, price, fee, holders }) {
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
      log(`fee ${fee} · old shareholders <b>+${holders}</b>`);
    },
    keys({ target }) {
      const t = byName.get(target);
      if (!t) return;
      fly("key", () => roof(t), () => ({ x: roof(t).x + 14, y: roof(t).y - 26 }), { color: RED, dur: 1.6, arc: 4 });
      log(`${target} · old agent keys deleted`);
    },
    budget({ firm, spend, budget }) {
      const f = byName.get(firm);
      if (!f) return;
      f.flash = 1;
      f.flashColor = RED;
      say(f, `spend ${spend} > ${budget} · refused`, RED, 3);
      log(`spend ${spend} on a ${budget} budget · <b>refused</b>`, "bad");
    },
    done() {
      log(`<b>21/21</b> checks pass · replay restarts`);
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

  // ------------------------------------------------------------------ simulation

  function simulate(dt) {
    clock += dt;
    explore += (exploreTarget - explore) * Math.min(1, dt * 3);
    pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 2);
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
    const shift = -pointer.x * 3;
    for (const blk of skyline) {
      const x = blk.x + shift * (blk.layer ? 1 : 0.5);
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
    const x = x0 - pointer.x * 6;
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
      a.globalAlpha = 0.12 + f.pulse * 0.1;
      a.fillStyle = f.sign;
      for (let y = G + 2; y < Math.min(H, G + 10); y += 2) a.fillRect(Math.round(f.box.x - pointer.x * 6 + 1), y, f.box.w - 2, 1);
    }
    a.globalAlpha = 1;
  }

  function drawJob() {
    if (job.on < 0.02 && job.x > 1.1) return;
    const p = jobPos();
    a.globalAlpha = Math.min(1, job.on * 1.5 + 0.2);
    // A small airship carries the job across the sky.
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
    // On a phone the towers are too close for names in the hero view: only the job and the arena show text.
    const crowded = W * 4 < 900 && !live && explore < 0.5;
    if (crowded) {
      if (job.on > 0.05 && job.label) text(job.label, jobPos().x, jobPos().y - 7, "#fff", 12, "center", Math.min(1, job.on));
      return;
    }
    for (const f of firms) {
      const r = roof(f);
      const x = r.x - pointer.x * 6;
      const top = f.box.top - 9;
      // Names stay quiet in the hero and come forward in the arena view and on the dashboard.
      const show = live ? 1 : 0.55 + 0.45 * explore;
      text(f.name.toUpperCase(), x, top, f.forSale ? RED : f.sign, W * 4 < 900 ? 10 : 12, "center", show);
      if (live || explore > 0.05) text(f.forSale ? "for sale" : f.status, x, top + 4, "rgba(255,255,255,0.75)", 11, "center", live ? 0.9 : explore);
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
      text(l.text, r.x - pointer.x * 6, l.f.box.top - 15 - n * 5 - Math.min(3, age * 2), l.color, 13, "center", alpha);
    }
    if (job.on > 0.05 && job.label) {
      const p = jobPos();
      text(job.label, p.x, p.y - 7, "#fff", 13, "center", Math.min(1, job.on));
    }
  }

  function draw() {
    a.drawImage(back, 0, 0);
    drawStars();
    drawSkyline();
    drawJob();
    for (const f of firms) drawTower(f);
    drawStreet();
    drawFlyers();
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(art, 0, 0, W * S, H * S);
    drawLabels();
  }

  // ------------------------------------------------------------------ loop

  function step(dt) {
    if (mode === "replay") runStory(dt);
    simulate(dt);
    draw();
  }

  function onPointer(e) {
    const r = canvas.getBoundingClientRect();
    pointer.tx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1));
  }
  window.addEventListener("pointermove", onPointer, { passive: true });

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
      ACTIONS[storyStep.do]?.(storyStep);
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
    setExplore(on) {
      exploreTarget = on ? 1 : 0;
      if (still) {
        explore = exploreTarget;
        step(0);
      }
    },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointer);
    },
  };
}
