import { useEffect, useRef } from "react";

// The hero's dusk, redrawn as pixel art: a dithered sky, a striped sun, three dune layers in parallax
// and a small flock crossing the sky. Drawn at 1/PX resolution and scaled up with crisp pixels.
const PX = 4;
// Starts at the page colour so the art blends into the sections above it.
const SKY = ["#120c19", "#150d1f", "#1a0f27", "#22122f", "#3a2140", "#6b3557", "#a8506f", "#ec8f97", "#f6c6a0"];
const DUNES = [
  { color: "#3a2140", rim: "#ec8f97", speed: 2, amp: 0.1, base: 0.74, f: [0.021, 0.047] },
  { color: "#22122f", rim: "#a8506f", speed: 5, amp: 0.12, base: 0.84, f: [0.017, 0.039] },
  { color: "#0d0716", rim: "#6b3557", speed: 10, amp: 0.1, base: 0.93, f: [0.013, 0.031] },
];
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

export function PixelDusk({ sun = true, className = "" }: { sun?: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = 0;
    let H = 0;
    let sky: ImageData | null = null;
    const stars = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random() * 0.45, p: Math.random() * 6 }));
    const birds = Array.from({ length: 26 }, () => ({ x: Math.random() * 30, y: Math.random() * 12, vx: 0, vy: 0 }));
    let visible = false;

    function layout() {
      W = Math.max(1, Math.round(canvas.clientWidth / PX));
      H = Math.max(1, Math.round(canvas.clientHeight / PX));
      canvas.width = W;
      canvas.height = H;
      // The dithered sky only depends on the size: build it once.
      sky = ctx!.createImageData(W, H);
      const rgb = SKY.map((c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)));
      const horizon = sun ? 0.72 : 0.8;
      for (let y = 0; y < H; y++) {
        const t = Math.min(1, Math.pow(y / (H * horizon), 1.6)) * (SKY.length - 1);
        for (let x = 0; x < W; x++) {
          const k = Math.floor(t) + (t % 1 > BAYER[(y % 4) * 4 + (x % 4)] ? 1 : 0);
          const c = rgb[Math.min(SKY.length - 1, k)];
          const o = (y * W + x) * 4;
          sky.data[o] = c[0];
          sky.data[o + 1] = c[1];
          sky.data[o + 2] = c[2];
          sky.data[o + 3] = 255;
        }
      }
    }

    function ridge(d: (typeof DUNES)[number], x: number, t: number) {
      const u = x + t * d.speed;
      return H * (d.base - d.amp * (0.55 * Math.sin(u * d.f[0] + d.speed) + 0.45 * Math.sin(u * d.f[1] + 1.7)));
    }

    function draw(t: number) {
      if (!sky) return;
      ctx!.putImageData(sky, 0, 0);
      for (const s of stars) {
        const a = 0.5 + 0.5 * Math.sin(t * 1.5 + s.p);
        if (a < 0.35) continue;
        ctx!.globalAlpha = a;
        ctx!.fillStyle = "#ffffff";
        ctx!.fillRect(Math.floor(s.x * W), Math.floor(s.y * H), 1, 1);
      }
      ctx!.globalAlpha = 1;
      if (sun) {
        // A synthwave sun: a disc cut by horizontal gaps that widen towards the horizon.
        const cx = W / 2;
        const cy = H * 0.72;
        const r = Math.min(W * 0.09, H * 0.32);
        for (let y = Math.floor(cy - r); y < cy; y++) {
          const dy = cy - y;
          const gap = Math.floor((1 - dy / r) * 4);
          if (gap > 0 && (Math.floor(y + t * 3) % 5) < gap) continue;
          const half = Math.sqrt(r * r - dy * dy);
          ctx!.fillStyle = dy > r * 0.55 ? "#f6d7a7" : dy > r * 0.25 ? "#f6c6a0" : "#ec8f97";
          ctx!.fillRect(Math.round(cx - half), y, Math.round(half * 2), 1);
        }
      }
      // A small flock crossing the sky, steering like a swarm toward a slowly moving point.
      const gx = ((t * 6) % (W + 60)) - 30;
      const gy = H * 0.3 + Math.sin(t * 0.4) * H * 0.08;
      let mx = 0;
      let my = 0;
      for (const b of birds) {
        mx += b.vx;
        my += b.vy;
      }
      mx /= birds.length;
      my /= birds.length;
      ctx!.fillStyle = "#1a0f22";
      for (const b of birds) {
        const tx = gx + Math.sin(b.y * 3.1 + t) * 6;
        b.vx += ((tx - b.x) * 0.8 + (mx - b.vx) * 0.5 + Math.sin(t * 2 + b.y) * 3) * 0.05;
        b.vy += ((gy - b.y) * 0.8 + (my - b.vy) * 0.5 + Math.cos(t * 1.7 + b.x) * 3) * 0.05;
        b.vx *= 0.92;
        b.vy *= 0.92;
        b.x += b.vx * 0.3;
        b.y += b.vy * 0.3;
        if (b.x < -40 || b.x > W + 40) {
          b.x = gx;
          b.y = gy;
        }
        ctx!.fillRect(Math.round(b.x), Math.round(b.y), 1, 1);
      }
      // Dunes: filled silhouettes with a lit crest line, farthest first.
      for (const d of DUNES) {
        for (let x = 0; x < W; x++) {
          const top = Math.round(ridge(d, x, t));
          ctx!.fillStyle = d.color;
          ctx!.fillRect(x, top, 1, H - top);
          ctx!.fillStyle = d.rim;
          if (ridge(d, x - 1, t) > top || (x + Math.floor(t)) % 7 === 0) ctx!.fillRect(x, top, 1, 1);
        }
      }
    }

    layout();
    const ro = new ResizeObserver(() => {
      layout();
      draw(clock);
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(canvas);
    let clock = 0;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!visible || document.hidden) return;
      // 15 frames a second: pixel art does not need more, and it reads as animation, not video.
      acc += dt;
      if (acc < 1 / 15) return;
      clock += acc;
      acc = 0;
      draw(clock);
    };
    draw(0);
    if (!reduced) raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, [sun]);

  return <canvas ref={ref} className={`pixel-dusk ${className}`} aria-hidden="true" />;
}
