// Landing page behaviour: mobile menu, stat counters, the "watch the swarm" mode, the replay ledger,
// and the WebGL scene (with the original video as a fallback when WebGL is missing).
const body = document.body;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isMobile = window.matchMedia("(max-width: 720px), (pointer: coarse)").matches;

// ------------------------------------------------------------------ mobile menu

const burger = document.querySelector(".burger");
const menu = document.querySelector(".mobile-menu");
const overlay = document.querySelector(".menu-overlay");

function setMenu(open) {
  burger.setAttribute("aria-expanded", String(open));
  burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  menu.hidden = !open;
  overlay.hidden = !open;
  body.classList.toggle("menu-open", open);
  if (open) menu.querySelector("a")?.focus();
}

burger.addEventListener("click", () => setMenu(burger.getAttribute("aria-expanded") !== "true"));
overlay.addEventListener("click", () => setMenu(false));
menu.addEventListener("click", (e) => {
  if (e.target.closest("a")) setMenu(false);
});
window.addEventListener("resize", () => {
  if (window.innerWidth > 720 && !menu.hidden) setMenu(false);
});

// ------------------------------------------------------------------ stat counters

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

function format(el, value) {
  const decimals = Number(el.dataset.decimals || 0);
  el.textContent = `${value.toFixed(decimals)}${el.dataset.suffix || ""}`;
}

async function thesisMultiple() {
  // The multiple moves with the NEAR price: read it from the latest `make thesis` run when served.
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 900);
    const r = await fetch("../thesis/result.json", { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!r.ok) return null;
    const j = await r.json();
    return Number.isFinite(j.multiple_2_5) ? j.multiple_2_5 : null;
  } catch {
    return null;
  }
}

async function startCounters() {
  const values = [...document.querySelectorAll(".stat-value[data-count]")];
  const multiple = await thesisMultiple();
  const thesisEl = values.find((el) => el.dataset.source === "thesis");
  if (thesisEl && multiple) thesisEl.dataset.count = multiple.toFixed(1);

  if (reducedMotion) {
    values.forEach((el) => format(el, Number(el.dataset.count)));
    return;
  }
  values.forEach((el) => format(el, 0));
  const run = () =>
    values.forEach((el, i) => {
      const target = Number(el.dataset.count);
      const duration = 1500 + i * 80;
      const delay = 480 + i * 90;
      const t0 = performance.now() + delay;
      const tick = (now) => {
        const t = Math.min(1, Math.max(0, (now - t0) / duration));
        format(el, target * easeOutCubic(t));
        if (t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        run();
      }
    },
    { threshold: 0.25 },
  );
  io.observe(document.querySelector(".stats"));
}

startCounters();

// ------------------------------------------------------------------ replay ledger

const ledgerLines = document.querySelector(".ledger-lines");

function addLedgerLine({ text, kind }) {
  const li = document.createElement("li");
  if (kind) li.className = kind;
  li.innerHTML = text; // text comes from story.js only, never from user input
  ledgerLines.appendChild(li);
  const keep = body.classList.contains("exploring") ? 12 : 3;
  while (ledgerLines.children.length > keep) ledgerLines.firstElementChild.remove();
}

const phases = [...document.querySelectorAll(".phases li")];

function setPhase(i) {
  phases.forEach((li, k) => {
    li.classList.toggle("now", k === i);
    li.classList.toggle("done", i >= 0 && k < i);
  });
}

// ------------------------------------------------------------------ explore mode

const exploreBtn = document.querySelector("[data-explore]");
const exitBtn = document.querySelector(".explore-exit");
let scene = null;

function setExplore(on) {
  body.classList.toggle("exploring", on);
  exitBtn.hidden = !on;
  ledgerLines.setAttribute("aria-live", on ? "polite" : "off");
  scene?.setExplore(on);
  (on ? exitBtn : exploreBtn).focus({ preventScroll: true });
}

exploreBtn.addEventListener("click", () => setExplore(true));
exitBtn.addEventListener("click", () => setExplore(false));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!menu.hidden) setMenu(false);
  else if (body.classList.contains("exploring")) setExplore(false);
});

// ------------------------------------------------------------------ background

const canvas = document.querySelector(".bg-canvas");
const video = document.querySelector(".bg-video");

function calmRect() {
  // The copy block: from the trust row to the call to action.
  const parts = [".trust", ".headline", ".subhead", ".cta"].map((s) => document.querySelector(s).getBoundingClientRect());
  return {
    left: Math.min(...parts.map((r) => r.left)),
    right: Math.max(...parts.map((r) => r.right)),
    top: Math.min(...parts.map((r) => r.top)),
    bottom: Math.max(...parts.map((r) => r.bottom)),
  };
}

function useVideo() {
  const source = video.querySelector("source");
  source.src = source.dataset.src;
  video.hidden = false;
  video.autoplay = !reducedMotion;
  video.load();
  if (!reducedMotion) video.play().catch(() => {});
  canvas.remove();
}

function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}

async function startBackground() {
  if (!webglAvailable()) return useVideo();
  try {
    const { startScene } = await import("./scene.js");
    scene = startScene({
      canvas,
      tagsLayer: document.querySelector(".tags"),
      onEvent: addLedgerLine,
      onPhase: setPhase,
      reducedMotion,
      isMobile,
    });
    // The copy settles after its entrance animation and the web fonts: measure it then.
    const measure = () => {
      // Horizon between the trust row and the title: the glow frames the copy without sitting behind it.
      const trust = document.querySelector(".trust").getBoundingClientRect();
      const title = document.querySelector(".headline").getBoundingClientRect();
      scene.setHorizon((trust.bottom * 0.4 + title.top * 0.6) / window.innerHeight);
      scene.setCalmRect(calmRect());
    };
    measure();
    document.fonts?.ready.then(measure);
    setTimeout(measure, 1200);
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        scene.resize();
        measure();
      }, 120);
    });
    requestAnimationFrame(() => canvas.classList.add("ready"));
  } catch (err) {
    console.warn("WebGL scene unavailable, falling back to video:", err);
    useVideo();
  }
}

startBackground();
