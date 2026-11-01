// SEALED world: three floating island plazas at dusk above a sea of clouds, one per market. Firms are towers on each
// island's ring and auctions play out on the central pedestal. pages/City.tsx drives it through PlazaApi and owns the
// game and the HTML HUD. Everything is procedural (no assets). Dynamic things are instanced and rebuilt every frame
// ("immediate mode"): that keeps the scene near 60 draw calls and makes every animation a plain function of time.
import {
  AdditiveBlending,
  BackSide,
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DirectionalLight,
  DodecahedronGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  HalfFloatType,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineSegments,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  NeutralToneMapping,
  NormalBlending,
  OctahedronGeometry,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Raycaster,
  RedFormat,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Spherical,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  type MeshToonMaterialParameters,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export type Regime = "calm" | "alert" | "storm";
export type MarketSym = "NEAR" | "ETH" | "SOL";
export type PlazaFirm = { key: string; market: MarketSym; name: string; color: string; nav: number; fills: number; status: string; rank: number };
export type ScreenPoint = { x: number; y: number; visible: boolean };
/** Optional extra, for the dev harness: counters of the last rendered frame. */
export type PlazaStats = { calls: number; triangles: number; frameMs: number; dpr: number; bloom: boolean; shadows: boolean };
export type PlazaApi = {
  setFirms(firms: PlazaFirm[]): void; // add, update (animate height/colour/status changes), remove towers; idempotent, called every few seconds
  setRegime(market: MarketSym, r: Regime): void;
  order(market: MarketSym, o: { id: string; side: "Buy" | "Sell"; mine?: boolean }): void;
  commit(market: MarketSym, firmKey: string): void;
  reveal(market: MarketSym, firmKey: string, label: string, best?: boolean): void;
  win(market: MarketSym, firmKey: string, label: string): void;
  refund(market: MarketSym): void;
  slash(market: MarketSym, firmKey: string): void;
  dividend(market: MarketSym, firmKey: string): void;
  takeover(market: MarketSym, buyerKey: string, targetKey: string): void;
  close(market: MarketSym, firmKey: string): void;
  focus(market: MarketSym | null, force?: boolean): void;
  focusFirm(firmKey: string): void;
  setHighlight(firmKey: string | null): void; // outline or glow on one tower (hover, picked or backed by the player)
  pick(clientX: number, clientY: number): string | null; // the firm key under the pointer
  project(firmKey: string): ScreenPoint | null; // the tower top on screen in CSS pixels, for HTML labels
  projectMarket(market: MarketSym): ScreenPoint; // the pedestal on screen
  setAuto(on: boolean): void;
  setQuality(q: "auto" | "low" | "high"): void;
  resize(): void;
  dispose(): void;
  /** Optional extra (dev harness): draw calls, triangles, frame time and active quality features. */
  stats?(): PlazaStats;
};

const MARKETS: MarketSym[] = ["NEAR", "ETH", "SOL"];
const TINT: Record<MarketSym, string> = { NEAR: "#5ee6c8", ETH: "#9fb4ff", SOL: "#d7a6ff" };
const SIDE = { Buy: "#0072B2", Sell: "#E69F00" };
const GOLD = "#ffcc4d";
const RING = 32; // island centres sit on this ring
const R = 11; // island radius
const FH = 0.62; // floor height
const PL = 0.24; // tower plinth height
const PED = 1.45; // pedestal table top
const IDLE = 20; // seconds without input before the auto camera takes over
const TAU = Math.PI * 2;
const SUN = new Vector3(-0.86, 0.05, -0.5).normalize(); // the sun as drawn in the sky, on the horizon
const KEY = new Vector3(-0.75, 0.32, 0.55).normalize(); // low key light: walls catch it, plazas stay in the mid band
const MOON = new Vector3(0.42, 0.028, -0.9).normalize(); // low, so it shows in the default framings
// Tower slots in island space (+z points away from the ring centre, toward the usual camera): back slots fill
// first so the front of the plaza stays open on the pedestal.
const SLOTS = Array.from({ length: 16 }, (_, i) => {
  const outer = i >= 8;
  const a = [4, 3, 5, 2, 6, 1, 7, 0][i % 8] * (Math.PI / 4) + (outer ? Math.PI / 8 : 0);
  const r = outer ? 9.1 : 6.25;
  return { x: Math.sin(a) * r, z: Math.cos(a) * r, a };
});

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const hashStr = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const span = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const easeIn = (t: number) => t * t;
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const backOut = (t: number) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2;
// GLSL literal of a colour in linear space, so shader constants match three's colour management.
const lin = (hex: string) => {
  const c = new Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

// ------------------------------------------------------------------ shaders

// The dusk sky. Shared by the sky dome and by every material's fog, so distant things melt exactly into it.
const SKY = /* glsl */ `
uniform vec3 uSun;
vec3 skyColor(vec3 d) {
  float e = d.y;
  vec3 c = mix(${lin("#5a3f86")}, ${lin("#2a2466")}, smoothstep(0.0, 0.16, e));
  c = mix(c, ${lin("#17143c")}, smoothstep(0.14, 0.42, e));
  c = mix(c, ${lin("#0b0a1a")}, smoothstep(0.42, 0.95, e));
  float az = max(dot(normalize(d.xz + vec2(1e-4)), normalize(uSun.xz)), 0.0);
  c = mix(c, ${lin("#f08a6a")}, pow(az, 4.0) * (1.0 - smoothstep(-0.06, 0.26, e)) * 0.9);
  c = mix(c, ${lin("#302a6c")}, smoothstep(0.0, -0.16, e) * (1.0 - 0.5 * pow(az, 4.0)));
  float s = max(dot(d, uSun), 0.0);
  c += ${lin("#ffc29a")} * (pow(s, 60.0) * 1.4 + pow(s, 7.0) * 0.22);
  return c;
}
float h13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
`;

const VPARS = /* glsl */ `
uniform float uTime;
#ifdef ISLE
uniform float uWind; attribute float aSway; attribute float aEmit; varying float vEmit;
#endif
#ifdef WIN
attribute vec4 aWin; attribute vec4 aFx; varying vec4 vWin; varying vec4 vFx; varying vec3 vLocal; varying vec3 vLN;
#endif
`;
const VMAIN = /* glsl */ `
#ifdef ISLE
vEmit = aEmit;
transformed.x += aSway * uWind * (sin(uTime * 2.1 + position.z * 0.6) * 0.16 + 0.09);
transformed.z += aSway * uWind * cos(uTime * 1.7 + position.x * 0.6) * 0.1;
#endif
#ifdef WIN
vWin = aWin; vFx = aFx; vLocal = position; vLN = normal;
#endif
`;
const FPARS = /* glsl */ `
uniform float uTime; uniform float uFogNear; uniform float uFogFar;
uniform vec3 uIsle[3]; uniform float uGloom[3]; uniform float uFlash[3];
${SKY}
#ifdef ISLE
varying float vEmit;
#endif
#ifdef WIN
varying vec4 vWin; varying vec4 vFx; varying vec3 vLocal; varying vec3 vLN;
#endif
`;
// Window grid on tower floors: aWin = (lit share, seed, win pulse, flicker), aFx = (crack, highlight, dark, 0).
const FEMIT = /* glsl */ `
#ifdef ISLE
totalEmissiveRadiance += diffuseColor.rgb * vEmit * 1.8;
#endif
#ifdef EMIT
totalEmissiveRadiance += diffuseColor.rgb * EMIT;
#endif
#ifdef WIN
{
  vec3 an = abs(vLN);
  float side = step(an.y, 0.5);
  float across = an.x > 0.5 ? vLocal.z : vLocal.x;
  float face = an.x > 0.5 ? (vLN.x > 0.0 ? 0.0 : 1.0) : (vLN.z > 0.0 ? 2.0 : 3.0);
  float u = (across + 0.5) * 3.0;
  float cell = floor(u); float fu = fract(u);
  float inWin = side * step(0.2, fu) * step(fu, 0.8) * step(0.34, vLocal.y) * step(vLocal.y, 0.84);
  float h = h13(vec3(vWin.y, face * 7.0 + cell, 3.1));
  float tw = h13(vec3(vWin.y + cell, face, floor(uTime * 0.09 + h * 17.0)));
  float lit = step(h * 0.82 + tw * 0.18, vWin.x + vWin.z * 0.8);
  lit *= mix(1.0, step(0.4, h13(vec3(h, floor(uTime * 8.0), 1.7))), vWin.w) * (1.0 - vFx.z);
  vec3 glass = mix(vec3(0.02, 0.02, 0.06), vec3(0.09, 0.08, 0.2), (vLocal.y - 0.34) * 2.0);
  vec3 warm = mix(vec3(1.0, 0.62, 0.3), vec3(1.0, 0.82, 0.55), h);
  diffuseColor.rgb = mix(diffuseColor.rgb, glass, inWin);
  totalEmissiveRadiance += inWin * lit * mix(warm, vec3(1.0, 0.85, 0.45), vWin.z) * (1.25 + vWin.z * 1.2);
  float cy = 0.55 + 0.17 * sin(across * 11.0 + vWin.y * 3.0) + 0.08 * sin(across * 31.0 + vWin.y);
  float crack = side * smoothstep(0.07, 0.0, abs(vLocal.y - cy)) * vFx.x;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.5, 0.06, 0.1), vFx.x * 0.4 * side);
  totalEmissiveRadiance += crack * vec3(5.0, 0.45, 0.3) + vFx.w * vec3(0.9, 0.08, 0.1);
  totalEmissiveRadiance += vFx.y * diffuseColor.rgb * 0.3;
}
#endif
`;
// Fog toward the sky colour in the view direction, height fog into the clouds, and per-island storm gloom and flash.
const FOG = /* glsl */ `
{
  vec3 wDir = normalize((vec4(-vViewPosition, 0.0) * viewMatrix).xyz);
  float wDist = length(vViewPosition);
  vec3 wPos = cameraPosition + wDir * wDist;
  for (int i = 0; i < 3; i++) {
    float k = 1.0 - smoothstep(9.0, 21.0, length(wPos.xz - uIsle[i].xz));
    outgoingLight *= 1.0 - 0.5 * uGloom[i] * k;
    outgoingLight += vec3(0.75, 0.78, 1.0) * uFlash[i] * k * (0.15 + diffuseColor.rgb * 0.8);
  }
  float fogF = smoothstep(uFogNear, uFogFar, wDist);
#ifdef HFOG
  fogF = max(fogF, smoothstep(-4.0, -12.0, wPos.y) * 0.92);
#endif
  outgoingLight = mix(outgoingLight, skyColor(wDir), fogF);
}
`;

const BILL_V = /* glsl */ `
attribute vec3 iPos; attribute vec4 iCol; attribute float iSize; uniform float uFar;
varying vec2 vUv; varying vec4 vCol;
void main() {
  vec4 mv = viewMatrix * vec4(iPos, 1.0);
  mv.xy += position.xy * iSize;
  vUv = position.xy * 2.0;
  vCol = iCol;
  vCol.a *= 1.0 - smoothstep(uFar * 0.55, uFar, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const BILL_F = /* glsl */ `
varying vec2 vUv; varying vec4 vCol;
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
#ifdef DUST
  gl_FragColor = vec4(vCol.rgb, smoothstep(1.0, 0.0, r2) * vCol.a);
#else
  float a = (exp(-r2 * 6.0) * 0.75 + exp(-r2 * 45.0)) * (1.0 - r2) * vCol.a;
  gl_FragColor = vec4(vCol.rgb * a, 1.0);
#endif
  #include <colorspace_fragment>
}`;

// ------------------------------------------------------------------ geometry helpers

type PaintFn = (p: Vector3, n: Vector3) => Color;
type Paint = Color | string | PaintFn;
type PartOpts = { sway?: (p: Vector3) => number; emit?: number; jitter?: number; smooth?: boolean };

/** A flat-shaded, vertex-coloured piece (one colour per triangle, for the low-poly look) ready to merge. */
function part(src: BufferGeometry, paint: Paint, o: PartOpts = {}): BufferGeometry {
  const g = src.index && !o.smooth ? src.toNonIndexed() : src;
  if (g !== src) src.dispose();
  for (const k of Object.keys(g.attributes)) if (k !== "position" && !(o.smooth && k === "normal")) g.deleteAttribute(k);
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  const pos = g.getAttribute("position") as BufferAttribute;
  const nor = g.getAttribute("normal") as BufferAttribute;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const sway = new Float32Array(n);
  const emit = new Float32Array(n).fill(o.emit ?? 0);
  const fixed = typeof paint === "function" ? null : new Color(paint);
  const r = rng(n * 31 + 7);
  const p = new Vector3();
  const q = new Vector3();
  const a = new Vector3();
  const c = new Color();
  if (o.smooth) {
    for (let i = 0; i < n; i++) {
      p.fromBufferAttribute(pos, i);
      q.fromBufferAttribute(nor, i);
      c.copy(fixed ?? (paint as PaintFn)(p, q)).toArray(col, i * 3);
    }
  } else
  for (let i = 0; i < n; i += 3) {
    p.set(0, 0, 0);
    for (let k = 0; k < 3; k++) p.add(a.fromBufferAttribute(pos, i + k));
    p.multiplyScalar(1 / 3);
    q.fromBufferAttribute(nor, i);
    c.copy(fixed ?? (paint as PaintFn)(p, q)).multiplyScalar(1 + (r() - 0.5) * 2 * (o.jitter ?? 0));
    for (let k = 0; k < 3; k++) {
      c.toArray(col, (i + k) * 3);
      if (o.sway) sway[i + k] = o.sway(a.fromBufferAttribute(pos, i + k));
    }
  }
  g.setAttribute("color", new BufferAttribute(col, 3));
  g.setAttribute("aSway", new BufferAttribute(sway, 1));
  g.setAttribute("aEmit", new BufferAttribute(emit, 1));
  return g;
}

/** Rock-like noise on vertices; hashed on the rounded position so seam duplicates move together (no cracks). */
function jitterVerts(g: BufferGeometry, amt: number, keep: (y: number) => boolean) {
  const pos = g.getAttribute("position") as BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (keep(y)) continue;
    const kx = Math.round(x * 1000) / 1000;
    const ky = Math.round(y * 1000) / 1000;
    const kz = Math.round(z * 1000) / 1000;
    const h = (k: number) => {
      const s = Math.sin(kx * 12.9898 + ky * 78.233 + kz * 37.719 + k * 11.3) * 43758.5453;
      return s - Math.floor(s) - 0.5;
    };
    const rad = 1 + h(1) * amt * 0.22;
    pos.setXYZ(i, x * rad + h(2) * amt * 0.3, y + h(3) * amt * 0.5, z * rad + h(4) * amt * 0.3);
  }
}

type Anchor = { p: Vector3; c: Color; s: number; k: number }; // a static glow: k 0 lamp, 1 rim light, 2 crystal, 3 inlay

/** One island in its own space: lawn, paved plaza, tower boulevard, rim lights, pedestal, trees, rock and crystals. */
function islandGeo(m: MarketSym, seed: number) {
  const r = rng(seed);
  const tint = new Color(TINT[m]);
  const tone = (hex: string, k = 0) => new Color(hex).lerp(tint, k);
  const G: BufferGeometry[] = [];
  const anchors: Anchor[] = [];
  const add = (g: BufferGeometry, paint: Paint, o?: PartOpts) => void G.push(part(g, paint, o));
  const glow = (x: number, y: number, z: number, c: Color, s: number, k: number) => anchors.push({ p: new Vector3(x, y, z), c, s, k });
  const PI = Math.PI;
  const stone = tone("#9086b2", 0.06);

  add(new RingGeometry(0.2, R, 64, 7).rotateX(-PI / 2), tone("#2f6a5f", 0.12), { jitter: 0.07 });
  add(new CylinderGeometry(R, R * 0.93, 1.1, 64, 1, true).translate(0, -0.55, 0), "#6d5174", { jitter: 0.05 });
  // Paved inner plaza with concentric bands, and a glowing inlay in the market's colour.
  const paveA = tone("#a99fc8", 0.05);
  const paveB = tone("#9990bb", 0.05);
  add(new RingGeometry(0.2, 4.4, 48, 5).rotateX(-PI / 2).translate(0, 0.14, 0), (p) => (Math.floor(Math.hypot(p.x, p.z) / 0.88) % 2 ? paveA : paveB), { jitter: 0.03 });
  add(new CylinderGeometry(4.4, 4.45, 0.14, 48, 1, true).translate(0, 0.07, 0), "#8d84a9");
  add(new TorusGeometry(3.3, 0.06, 4, 72).rotateX(PI / 2).translate(0, 0.15, 0), tint, { emit: 0.45 });
  // The boulevard ring the towers stand on, and four paths out to the rim.
  add(new RingGeometry(5.1, 7.4, 72, 3).rotateX(-PI / 2).translate(0, 0.07, 0), stone, { jitter: 0.05 });
  add(new CylinderGeometry(7.4, 7.42, 0.07, 72, 1, true).translate(0, 0.035, 0), "#7d7499");
  for (let k = 0; k < 4; k++) {
    const len = R - 7.35;
    add(new BoxGeometry(1.1, 0.07, len).translate(0, 0.035, 7.35 + len / 2).rotateY(PI / 8 + (k * PI) / 2), stone, { jitter: 0.04 });
  }
  // Rim curb with small lamps: from afar every island reads as a ring of lights in its market's colour.
  add(new TorusGeometry(R - 0.12, 0.2, 5, 96).rotateX(PI / 2).translate(0, 0.08, 0), "#9a91b8", { jitter: 0.04 });
  for (let k = 0; k < 18; k++) {
    const a = (k / 18) * TAU + 0.17;
    const x = Math.sin(a) * (R - 0.12);
    const z = Math.cos(a) * (R - 0.12);
    add(new BoxGeometry(0.16, 0.55, 0.16).translate(x, 0.3, z), "#8a81a8");
    add(new OctahedronGeometry(0.12).translate(x, 0.68, z), tint, { emit: 1.2 });
    glow(x, 0.7, z, tint, 0.95, 1);
  }
  // The rock underneath, in strata, with hanging spurs and glowing crystals.
  const cone = new ConeGeometry(R * 0.93, 9.5, 22, 7).rotateX(PI).translate(0, -1.1 - 4.75, 0);
  jitterVerts(cone, 1.3, (y) => y > -1.3);
  const rockTop = new Color("#7d6a96");
  const rockBot = new Color("#271d43");
  const strata = (p: Vector3) => rockTop.clone().lerp(rockBot, clamp01((-1.1 - p.y) / 9.5)).multiplyScalar(Math.floor(-p.y * 1.3) % 2 ? 0.9 : 1.05);
  add(cone, strata, { jitter: 0.05 });
  for (let k = 0; k < 3; k++) {
    const a = r() * TAU;
    const d = 3.5 + r() * 3.5;
    const h = 2.4 + r() * 2.2;
    const top = -1.1 - 9.5 * (1 - d / (R * 0.93)) + 0.8;
    const spur = new ConeGeometry(1.1 + r() * 0.7, h, 7, 2).rotateX(PI).translate(Math.sin(a) * d, top - h / 2, Math.cos(a) * d);
    jitterVerts(spur, 0.6, () => false);
    add(spur, strata, { jitter: 0.05 });
  }
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU + r() * 0.6;
    const y = -2 - r() * 4.2;
    const rr = R * 0.93 * (1 - (-1.1 - y) / 9.5) + 0.05;
    const x = Math.sin(a) * rr;
    const z = Math.cos(a) * rr;
    add(new OctahedronGeometry(0.3 + r() * 0.22).scale(1, 2.4, 1).rotateZ((r() - 0.5) * 0.9).translate(x, y, z), tint, { emit: 1.4 });
    glow(x, y, z, tint, 3.2, 2);
  }
  // The auction table.
  add(new CylinderGeometry(2.0, 2.25, 0.32, 40).translate(0, 0.3, 0), "#a89fc4", { jitter: 0.03 });
  add(new CylinderGeometry(0.95, 1.15, PED - 0.68, 24).translate(0, 0.46 + (PED - 0.68) / 2, 0), "#8a80ab");
  add(new CylinderGeometry(1.75, 1.55, 0.22, 40).translate(0, PED - 0.11, 0), "#d6cfe9", { jitter: 0.02 });
  add(new TorusGeometry(1.36, 0.05, 4, 48).rotateX(PI / 2).translate(0, PED + 0.005, 0), tint, { emit: 0.6 });
  for (let k = 0; k < 8; k++) glow(Math.sin((k / 8) * TAU) * 1.36, PED + 0.05, Math.cos((k / 8) * TAU) * 1.36, tint, 0.7, 3);
  // Lamp posts around the inner plaza.
  const warm = new Color("#ffcf8f");
  for (let k = 0; k < 6; k++) {
    const a = PI / 6 + (k * PI) / 3;
    const x = Math.sin(a) * 4.8;
    const z = Math.cos(a) * 4.8;
    add(new CylinderGeometry(0.05, 0.08, 1.7, 6).translate(x, 0.85, z), "#3d3658");
    add(new BoxGeometry(0.26, 0.26, 0.26).translate(x, 1.82, z), warm, { emit: 1.1 });
    glow(x, 1.85, z, warm, 1.5, 0);
  }
  // Trees near the rim and bushes between the towers; foliage sways with the wind.
  const leaf = ["#2f7a6b", "#3e8f77", "#2c6a84", "#4c9a80"].map((h) => tone(h, 0.12));
  const tree = (x: number, z: number, s: number) => {
    const type = Math.floor(r() * 3);
    const lc = leaf[Math.floor(r() * leaf.length)];
    const o: PartOpts = { sway: (p) => clamp01((p.y - 0.3) / (2.2 * s)), jitter: 0.06 };
    add(new CylinderGeometry(0.07 * s, 0.11 * s, 0.7 * s, 5).translate(x, 0.35 * s, z), "#5a3f52");
    if (type === 0) {
      add(new ConeGeometry(0.62 * s, 1.15 * s, 7).translate(x, 1.05 * s, z), lc, o);
      add(new ConeGeometry(0.45 * s, 0.9 * s, 7).translate(x, 1.6 * s, z), lc, o);
    } else if (type === 1) add(new IcosahedronGeometry(0.64 * s, 0).scale(1, 1.15, 1).translate(x, 1.15 * s, z), lc, o);
    else add(new ConeGeometry(0.34 * s, 1.9 * s, 6).translate(x, 1.3 * s, z), lc, o);
  };
  for (let k = 0; k < 8; k++)
    for (const j of [-1, 1]) {
      const a = (k * PI) / 4 + j * 0.13 + (r() - 0.5) * 0.06;
      const d = 9.5 + r() * 0.8;
      tree(Math.sin(a) * d, Math.cos(a) * d, k === 0 ? 0.7 : 0.85 + r() * 0.45);
    }
  for (let k = 1; k < 8; k += 2)
    for (const j of [-1, 1]) {
      const a = (k * PI) / 4 + PI / 8 + j * 0.09;
      const x = Math.sin(a) * 7.95;
      const z = Math.cos(a) * 7.95;
      add(new IcosahedronGeometry(0.36 + r() * 0.12, 0).scale(1, 0.75, 1).translate(x, 0.24, z), leaf[k % leaf.length], { sway: (p) => clamp01(p.y / 1.5), jitter: 0.08 });
    }
  const geo = mergeGeometries(G);
  for (const g of G) g.dispose();
  return { geo, anchors };
}

const V0 = new Vector3();
const V9 = new Vector3();
const UP0 = new Vector3(0, 1, 0);

/** The cloud carpet: a polar grid (dense near the islands, coarse far out) lifted by value noise into puffs. */
function cloudCarpet(mobile: boolean) {
  const r = rng(9);
  const G = 64;
  const grid = Float32Array.from({ length: G * G }, () => r());
  const at = (i: number, j: number) => grid[(((i % G) + G) % G) + (((j % G) + G) % G) * G];
  const noise = (x: number, z: number) => {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const fx = x - xi;
    const fz = z - zi;
    const sx = fx * fx * (3 - 2 * fx);
    const sz = fz * fz * (3 - 2 * fz);
    return lerp(lerp(at(xi, zi), at(xi + 1, zi), sx), lerp(at(xi, zi + 1), at(xi + 1, zi + 1), sx), sz);
  };
  const height = (x: number, z: number) => {
    const n = noise(x / 20, z / 20) * 0.6 + noise(x / 8 + 7, z / 8 + 3) * 0.3 + noise(x / 3.5, z / 3.5) * 0.1;
    return -12.5 + Math.pow(Math.max(0, n - 0.28) / 0.72, 0.6) * 6;
  };
  const NT = mobile ? 96 : 150;
  const NR = mobile ? 36 : 54;
  const pos: number[] = [0, height(0, 0), 0];
  for (let k = 1; k <= NR; k++) {
    const rad = 2 + 440 * (k / NR) ** 2.2;
    for (let j = 0; j < NT; j++) {
      const a = (j / NT) * TAU + (k % 2) * (Math.PI / NT); // staggered rings: triangles instead of a radial grid
      const x = Math.sin(a) * rad;
      const z = Math.cos(a) * rad;
      pos.push(x, height(x, z), z);
    }
  }
  const idx: number[] = [];
  const v = (k: number, j: number) => (k === 0 ? 0 : 1 + (k - 1) * NT + (((j % NT) + NT) % NT));
  for (let j = 0; j < NT; j++) idx.push(0, v(1, j), v(1, j + 1));
  for (let k = 1; k < NR; k++)
    for (let j = 0; j < NT; j++) {
      const s = k % 2;
      idx.push(v(k, j), v(k + 1, j + s), v(k, j + 1), v(k, j + 1), v(k + 1, j + s), v(k + 1, j + 1 + s));
    }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const lo = new Color("#2a2360");
  const mid = new Color("#56479a");
  const hi = new Color("#bea0d8");
  const c = new Color();
  const geo = part(
    g,
    (p) => {
      const h = clamp01((p.y + 12.5) / 6);
      return h < 0.5 ? c.copy(lo).lerp(mid, h * 2) : c.copy(mid).lerp(hi, (h - 0.5) * 2);
    },
    { smooth: true },
  );
  return { geo, height };
}

// ------------------------------------------------------------------ the scene

type Status = "solvent" | "illiquid" | "liquidating" | "closed";
type Phase = "standing" | "collapsing" | "rubble" | "lot" | "takeover" | "removing";
type Floor = { y: number; vy: number; s: number; gone: boolean; born: number };
type Isle = {
  m: MarketSym;
  i: number;
  angle: number;
  c: Vector3;
  mesh: Mesh;
  mat: Matrix4;
  phase: number;
  wind: { value: number };
  anchors: Anchor[];
  regime: Regime;
  amt: number;
  slots: (Tower | null)[];
  round: Round | null;
  rain: LineSegments;
  rainAmt: { value: number };
  bolt: Line;
  boltPts: Vector3[];
  boltT: number;
  nextBolt: number;
  light: PointLight;
};
type Tower = {
  key: string;
  firm: PlazaFirm;
  isle: Isle;
  slot: number;
  x: number;
  z: number;
  yaw: number;
  w: number;
  d: number;
  style: 0 | 1;
  seed: number;
  floors: Floor[];
  top: number;
  target: number;
  bonus: number;
  next: number;
  step: number;
  built: boolean;
  color: Color;
  to: Color;
  status: Status;
  phase: Phase;
  t0: number;
  buyer: Tower | null;
  heat: number;
  fills: number;
  credit: number;
  rankScore: number;
  lit: number;
  winT: number;
  crackT: number;
  shakeT: number;
  scaffold: number;
  lean: number;
  leanAxis: Vector3;
  plinth: number;
};
type Env = { t: Tower; born: number; from: Vector3; ang: number; open: number; best: boolean; out: number; toTower: boolean; popped: boolean; label: Sprite | null; p: Vector3 };
type Round = { isle: Isle; side: "Buy" | "Sell"; mine: boolean; t0: number; end: 0 | 1 | 2; endT: number; winner: Tower | null; envs: Map<string, Env>; best: boolean; p: Vector3 };
type Flyer = { from: Vector3; yaw: number; w: number; d: number; color: Color; t0: number; dur: number; to: Tower; arc: number; last: boolean; done: boolean };
type Pt = { kind: 0 | 1 | 2; p: Vector3; v: Vector3; age: number; life: number; size: number; c: Color; land: number; g: number; spin: number };
type Fx = { t0: number; dur: number; f: (t: number) => void };
type View = { t: Vector3; r: number; phi: number; th: number };

export function startPlaza(opts: { canvas: HTMLCanvasElement; reducedMotion: boolean; mobile: boolean; onUserInput?: () => void }): PlazaApi {
  const { canvas, mobile } = opts;
  const rm = opts.reducedMotion;
  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance", stencil: false });
  renderer.toneMapping = NeutralToneMapping; // keeps violets violet (ACES drifts them to pink)
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.info.autoReset = false; // bloom renders several passes per frame: count them all
  const scene = new Scene();
  scene.background = new Color("#0b0a1a");
  const cam = new PerspectiveCamera(40, 1, 0.5, 1500);

  const U = {
    uTime: { value: 0 },
    uSun: { value: SUN },
    uFogNear: { value: 85 },
    uFogFar: { value: 320 },
    uIsle: { value: [new Vector3(), new Vector3(), new Vector3()] },
    uGloom: { value: [0, 0, 0] },
    uFlash: { value: [0, 0, 0] },
  };
  const ramp = new DataTexture(new Uint8Array([84, 172, 255]), 3, 1, RedFormat);
  ramp.minFilter = ramp.magFilter = NearestFilter;
  ramp.needsUpdate = true;

  /** A toon material patched with the shared sky fog, plus windows, island sway or flat emission when asked. */
  function toon(p: MeshToonMaterialParameters, o: { win?: boolean; hfog?: boolean; isle?: { value: number }; emit?: number } = {}) {
    const m = new MeshToonMaterial({ gradientMap: ramp, ...p });
    const defs = `${o.win ? "#define WIN\n" : ""}${o.hfog ? "#define HFOG\n" : ""}${o.isle ? "#define ISLE\n" : ""}${o.emit ? `#define EMIT ${o.emit.toFixed(3)}\n` : ""}`;
    m.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, U);
      if (o.isle) s.uniforms.uWind = o.isle;
      s.vertexShader = defs + s.vertexShader.replace("#include <common>", `#include <common>\n${VPARS}`).replace("#include <begin_vertex>", `#include <begin_vertex>\n${VMAIN}`);
      s.fragmentShader =
        defs +
        s.fragmentShader
          .replace("#include <common>", `#include <common>\n${FPARS}`)
          .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${FEMIT}`)
          .replace("#include <opaque_fragment>", `${FOG}\n#include <opaque_fragment>`)
          .replace("#include <fog_fragment>", "");
    };
    m.customProgramCacheKey = () => `plaza${defs}`;
    return m;
  }

  // Instanced pools filled from scratch every frame.
  type Pool = { mesh: InstancedMesh; n: number; attrs: Record<string, InstancedBufferAttribute>; put(m: Matrix4, c: Color): number; flush(): void };
  function pool(geo: BufferGeometry, mat: Material, cap: number, shadow = false, extra: Record<string, number> = {}): Pool {
    const mesh = new InstancedMesh(geo, mat, cap);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(DynamicDrawUsage);
    const attrs: Record<string, InstancedBufferAttribute> = {};
    for (const [k, size] of Object.entries(extra)) geo.setAttribute(k, (attrs[k] = new InstancedBufferAttribute(new Float32Array(cap * size), size).setUsage(DynamicDrawUsage)));
    mesh.frustumCulled = false; // instances move every frame: a stale bounding sphere would cull them
    mesh.castShadow = mesh.receiveShadow = shadow;
    scene.add(mesh);
    const p: Pool = {
      mesh,
      n: 0,
      attrs,
      put(m, c) {
        if (p.n >= cap) return -1;
        mesh.setMatrixAt(p.n, m);
        c.toArray(mesh.instanceColor!.array, p.n * 3);
        return p.n++;
      },
      flush() {
        mesh.count = p.n;
        mesh.visible = p.n > 0;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.needsUpdate = true;
        for (const a of Object.values(attrs)) a.needsUpdate = true;
        p.n = 0;
      },
    };
    return p;
  }

  // Camera-facing glow sprites (additive) and dust puffs (alpha), one draw call each for the whole scene.
  function billboards(cap: number, additive: boolean) {
    const g = new InstancedBufferGeometry();
    const plane = new PlaneGeometry(1, 1);
    g.index = plane.index;
    g.setAttribute("position", plane.getAttribute("position"));
    const pos = new InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(DynamicDrawUsage);
    const col = new InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(DynamicDrawUsage);
    const siz = new InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(DynamicDrawUsage);
    g.setAttribute("iPos", pos);
    g.setAttribute("iCol", col);
    g.setAttribute("iSize", siz);
    const mat = new ShaderMaterial({ uniforms: { uFar: U.uFogFar }, vertexShader: BILL_V, fragmentShader: BILL_F, transparent: true, depthWrite: false, blending: additive ? AdditiveBlending : NormalBlending, defines: additive ? {} : { DUST: "" } });
    const mesh = new Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = additive ? 6 : 5;
    scene.add(mesh);
    let n = 0;
    return {
      add(p: Vector3, c: Color, size: number, a: number) {
        if (n >= cap || a <= 0.004) return;
        pos.setXYZ(n, p.x, p.y, p.z);
        col.setXYZW(n, c.r, c.g, c.b, a);
        siz.setX(n, size);
        n++;
      },
      flush() {
        g.instanceCount = n;
        mesh.visible = n > 0;
        pos.needsUpdate = col.needsUpdate = siz.needsUpdate = true;
        n = 0;
      },
    };
  }

  // ---------------------------------------------------------------- sky, light, clouds

  const sky = new Mesh(
    new SphereGeometry(800, 40, 20),
    new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      uniforms: { uSun: U.uSun, uTime: U.uTime, uMoon: { value: MOON } },
      vertexShader: /* glsl */ `varying vec3 vDir; void main() { vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
      fragmentShader: /* glsl */ `
        ${SKY}
        uniform float uTime; uniform vec3 uMoon; varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          vec3 c = skyColor(d);
          vec3 sp = d * 160.0; vec3 cell = floor(sp); float hh = h13(cell);
          if (hh > 0.985) {
            vec3 ctr = normalize(cell + 0.5 + (vec3(h13(cell + 1.3), h13(cell + 2.7), h13(cell + 4.1)) - 0.5) * 0.6) * 160.0;
            float st = smoothstep(0.3 + 0.25 * fract(hh * 97.0), 0.0, length(sp - ctr)) * smoothstep(0.06, 0.35, d.y);
            c += vec3(1.0, 0.92, 0.85) * st * (0.65 + 0.35 * sin(uTime * (0.7 + hh * 3.0) + hh * 300.0)) * 2.2;
          }
          float md = dot(d, uMoon);
          float disc = smoothstep(0.99981, 0.99987, md) - smoothstep(0.99981, 0.99987, dot(d, normalize(uMoon + vec3(0.0085, 0.0045, 0.004))));
          c += vec3(1.0, 0.93, 0.8) * max(disc, 0.0) * 1.5 + ${lin("#8d80c8")} * pow(max(md, 0.0), 2500.0) * 0.35;
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);

  scene.add(new HemisphereLight("#6a62c8", "#1e1636", 1.25));
  const sun = new DirectionalLight("#ffbb8f", 3.2);
  sun.position.copy(KEY).multiplyScalar(110);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -50;
  sun.shadow.camera.right = sun.shadow.camera.top = 50;
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 230;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);
  const rim = new DirectionalLight("#7f7cff", 0.9); // cool back light so silhouettes separate from the sky
  rim.position.set(0.6, 0.4, -0.7).multiplyScalar(100);
  scene.add(rim, rim.target);

  // The sea of clouds: one lumpy low-poly carpet, a few cumulus puffs on top, a few loose clouds between islands.
  const puff = part(new IcosahedronGeometry(1, 2), "#ffffff", { smooth: true });
  const softRamp = new DataTexture(new Uint8Array([150, 205, 255]), 3, 1, RedFormat);
  softRamp.minFilter = softRamp.magFilter = NearestFilter;
  softRamp.needsUpdate = true;
  const cloudMat = toon({ vertexColors: true, gradientMap: softRamp });
  const carpet = cloudCarpet(mobile);
  const sea = new Mesh(carpet.geo, cloudMat);
  const seaN = mobile ? 26 : 46;
  const cumulus = new InstancedMesh(puff, cloudMat, seaN * 3);
  {
    const r = rng(42);
    const M = new Matrix4();
    const Q = new Quaternion();
    const c = new Color();
    const lo = new Color("#463b8c");
    const hi = new Color("#b49ad6");
    let n = 0;
    for (let i = 0; i < seaN; i++) {
      const a = r() * TAU;
      const d = 14 + Math.sqrt(r()) * 120;
      const cx = Math.sin(a) * d;
      const cz = Math.cos(a) * d;
      const cy = carpet.height(cx, cz) - 1.6;
      for (let k = 0; k < 3; k++) {
        const s = 2.2 + r() * 3.2;
        M.compose(V0.set(cx + (r() - 0.5) * 6, cy + r() * 0.8, cz + (r() - 0.5) * 6), Q.setFromAxisAngle(UP0, r() * TAU), V9.set(s * (1 + r() * 0.4), s * (0.7 + r() * 0.25), s));
        cumulus.setMatrixAt(n, M);
        cumulus.setColorAt(n++, c.copy(lo).lerp(hi, 0.45 + r() * 0.55));
      }
    }
  }
  sea.add(cumulus);
  scene.add(sea);

  // ---------------------------------------------------------------- islands

  const glows = billboards(1100, true);
  const dust = billboards(260, false);
  const isles = new Map<MarketSym, Isle>();
  const isleList: Isle[] = [];
  const rainN = mobile ? 260 : 650;
  MARKETS.forEach((m, i) => {
    const angle = [0, (-2 * Math.PI) / 3, (2 * Math.PI) / 3][i];
    const c = new Vector3(Math.sin(angle) * RING, 0, Math.cos(angle) * RING);
    U.uIsle.value[i].copy(c);
    const wind = { value: 0.12 };
    const { geo, anchors } = islandGeo(m, 11 + i * 97);
    const mesh = new Mesh(geo, toon({ vertexColors: true }, { isle: wind, hfog: true }));
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
    // Rain: line streaks falling in the vertex shader, only over this island.
    const seeds = new Float32Array(rainN * 8);
    const ends = new Float32Array(rainN * 2);
    const rr = rng(500 + i);
    for (let k = 0; k < rainN; k++) {
      const a = rr() * TAU;
      const d = Math.sqrt(rr()) * (R - 0.6);
      const s = [Math.sin(a) * d, Math.cos(a) * d, rr(), rr()];
      seeds.set(s, k * 8);
      seeds.set(s, k * 8 + 4);
      ends[k * 2 + 1] = 1;
    }
    const rg = new BufferGeometry();
    rg.setAttribute("position", new BufferAttribute(new Float32Array(rainN * 6), 3));
    rg.setAttribute("aSeed", new BufferAttribute(seeds, 4));
    rg.setAttribute("aEnd", new BufferAttribute(ends, 1));
    const rainAmt = { value: 0 };
    const rain = new LineSegments(
      rg,
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: { uTime: U.uTime, uAmt: rainAmt, uOrigin: { value: c.clone().setY(0.15) }, uColor: { value: new Color("#b4bcff") } },
        vertexShader: /* glsl */ `
          attribute vec4 aSeed; attribute float aEnd; uniform float uTime; uniform float uAmt; uniform vec3 uOrigin; varying float vA;
          void main() {
            float H = 12.0;
            float y = H - mod(aSeed.z * H + uTime * (13.0 + aSeed.w * 5.0), H);
            vec3 p = uOrigin + vec3(aSeed.x, y, aSeed.y) + vec3(0.16, -0.9, 0.08) * aEnd;
            vA = uAmt * aEnd * 0.55 * smoothstep(0.0, 1.2, y) * smoothstep(H, H - 3.0, y);
            gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
          }`,
        fragmentShader: /* glsl */ `uniform vec3 uColor; varying float vA;
          void main() {
            gl_FragColor = vec4(uColor * vA, 1.0);
            #include <colorspace_fragment>
          }`,
      }),
    );
    rain.frustumCulled = false;
    rain.visible = false;
    scene.add(rain);
    const boltPts = Array.from({ length: 14 }, () => new Vector3());
    const bolt = new Line(new BufferGeometry().setFromPoints(boltPts), new LineBasicMaterial({ color: "#f3efff", transparent: true, toneMapped: false }));
    bolt.frustumCulled = false;
    bolt.visible = false;
    scene.add(bolt);
    const light = new PointLight("#c9c4ff", 0, 60, 1.3);
    light.position.copy(c).setY(10);
    scene.add(light);
    const isle: Isle = { m, i, angle, c, mesh, mat: new Matrix4(), phase: i * 2.1, wind, anchors, regime: "calm", amt: 0, slots: Array(16).fill(null), round: null, rain, rainAmt, bolt, boltPts, boltT: -9, nextBolt: 0, light };
    isles.set(m, isle);
    isleList.push(isle);
  });

  // ---------------------------------------------------------------- shared meshes

  const floorGeo = mergeGeometries([part(new BoxGeometry(1, 0.86, 1).translate(0, 0.57, 0), "#ffffff"), part(new BoxGeometry(1.08, 0.14, 1.08).translate(0, 0.07, 0), "#8a84a8")]);
  const hullMat = new MeshBasicMaterial({ color: "#c8fff1", side: BackSide, toneMapped: false });
  const hull = pool(part(new BoxGeometry(1, 1, 1).translate(0, 0.5, 0), "#ffffff"), hullMat, 4);
  const floors = pool(floorGeo, toon({ vertexColors: true }, { win: true, hfog: true }), 420, true, { aWin: 4, aFx: 4 });
  const roofGeos = [
    mergeGeometries([
      part(new BoxGeometry(1.1, 0.14, 1.1).translate(0, 0.07, 0), "#e2dcf2"),
      part(new BoxGeometry(0.4, 0.32, 0.4).translate(0.2, 0.3, -0.18), "#a39cc0"),
      part(new BoxGeometry(0.05, 1.0, 0.05).translate(-0.24, 0.64, 0.22), "#4a4466"),
    ]),
    mergeGeometries([
      part(new BoxGeometry(1.1, 0.14, 1.1).translate(0, 0.07, 0), "#e2dcf2"),
      part(new ConeGeometry(0.62, 1.0, 4).rotateY(Math.PI / 4).translate(0, 0.64, 0), "#c2bbdc"),
      part(new CylinderGeometry(0.02, 0.02, 0.4, 4).translate(0, 1.3, 0), "#4a4466"),
    ]),
  ];
  const TIPS = [new Vector3(-0.24, 1.17, 0.22), new Vector3(0, 1.52, 0)];
  const roofMat = toon({ vertexColors: true }, { hfog: true });
  const roofs = roofGeos.map((g) => pool(g, roofMat, 40, true));
  const plinths = pool(part(new BoxGeometry(1, 1, 1).translate(0, 0.5, 0), "#ffffff"), toon({ vertexColors: true }), 48, true);
  const rubble = pool(part(new DodecahedronGeometry(0.34, 0), "#ffffff"), toon({ vertexColors: true }), 320, true);
  const poles = pool(part(new BoxGeometry(1, 1, 1).translate(0, 0.5, 0), "#ffffff"), toon({ vertexColors: true }), 420, true);
  const crane = pool(
    mergeGeometries([
      part(new BoxGeometry(0.14, 2.2, 0.14).translate(0, 1.1, 0), "#f2b233"),
      part(new BoxGeometry(2.6, 0.1, 0.12).translate(0.7, 2.2, 0), "#f2b233"),
      part(new BoxGeometry(0.42, 0.32, 0.32).translate(-0.5, 2.05, 0), "#6c6488"),
      part(new BoxGeometry(0.02, 0.9, 0.02).translate(1.8, 1.7, 0), "#3a3550"),
      part(new BoxGeometry(0.14, 0.1, 0.14).translate(1.8, 1.22, 0), "#3a3550"),
    ]),
    toon({ vertexColors: true }),
    12,
    true,
  );
  const parcels = pool(
    mergeGeometries([
      part(new BoxGeometry(0.86, 0.72, 0.86).translate(0, 0.36, 0), "#ffffff"),
      part(new BoxGeometry(0.9, 0.74, 0.16).translate(0, 0.37, 0), "#9a94b4"),
      part(new BoxGeometry(0.16, 0.74, 0.9).translate(0, 0.37, 0), "#9a94b4"),
    ]),
    toon({ vertexColors: true }, { emit: 0.35 }),
    8,
    true,
  );
  const rings = pool(part(new TorusGeometry(0.95, 0.055, 6, 56).rotateX(Math.PI / 2), "#ffffff"), new MeshBasicMaterial({ vertexColors: true, blending: AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }), 24);
  const envBody = pool(part(new BoxGeometry(1, 0.64, 0.035), "#ffffff"), toon({ vertexColors: true }), 32, true);
  const flapGeo = new BufferGeometry().setFromPoints([new Vector3(-0.5, 0, 0), new Vector3(0, -0.42, 0), new Vector3(0.5, 0, 0)]);
  const envFlap = pool(part(flapGeo, "#ffffff"), toon({ vertexColors: true, side: DoubleSide }), 32);
  const envSeal = pool(part(new CylinderGeometry(0.12, 0.12, 0.035, 14).rotateX(Math.PI / 2), "#ffffff"), toon({ vertexColors: true }, { emit: 0.25 }), 32);
  const coins = pool(part(new CylinderGeometry(0.17, 0.17, 0.045, 16).rotateX(Math.PI / 2), "#ffffff"), toon({ vertexColors: true, color: GOLD }, { emit: 0.35 }), 220);
  const storms = pool(puff, toon({ vertexColors: true, gradientMap: softRamp }), 45, true);
  const birdGeo = new BufferGeometry().setFromPoints([new Vector3(0, 0, 0.18), new Vector3(-0.62, 0.05, -0.12), new Vector3(0, 0, -0.14), new Vector3(0, 0, 0.18), new Vector3(0, 0, -0.14), new Vector3(0.62, 0.05, -0.12)]);
  const birdMat = new MeshBasicMaterial({ color: "#1d1636", side: DoubleSide });
  birdMat.onBeforeCompile = (s) => {
    s.uniforms.uTime = U.uTime;
    s.vertexShader = `uniform float uTime;\n${s.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed.y += abs(position.x) * sin(uTime * 9.0 + float(gl_InstanceID) * 1.7) * 0.7;")}`;
  };
  const birds = pool(part(birdGeo, "#ffffff"), birdMat, 14);

  // Win beams and light columns: open cylinders with a soft additive shader.
  const beamGeo = new CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, 0.5, 0);
  const beamMat = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: { uColor: { value: new Color() }, uAlpha: { value: 0 }, uTime: { value: 0 }, uTop: { value: 0.8 } },
    vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vV; varying float vY;
      void main() { vY = position.y; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `uniform vec3 uColor; uniform float uAlpha; uniform float uTime; uniform float uTop; varying vec3 vN; varying vec3 vV; varying float vY;
      void main() {
        float a = pow(abs(dot(normalize(vN), normalize(vV))), 1.6) * uAlpha;
        a *= smoothstep(0.0, 0.05, vY) * smoothstep(1.0, uTop, vY) * (0.75 + 0.25 * sin(vY * 34.0 - uTime * 14.0));
        gl_FragColor = vec4(uColor * a, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const beams = Array.from({ length: 8 }, () => {
    const b = new Mesh(beamGeo, beamMat.clone());
    b.frustumCulled = false;
    b.visible = false;
    b.renderOrder = 7;
    scene.add(b);
    return b;
  });
  let beamN = 0;
  const BV = new Vector3();
  function beam(from: Vector3, to: Vector3, radius: number, color: Color | string, alpha: number, top = 0.82) {
    const b = beams[beamN];
    if (!b || alpha <= 0.01) return;
    beamN++;
    const dir = BV.subVectors(to, from);
    const len = dir.length();
    if (len < 0.01) return;
    b.position.copy(from);
    b.quaternion.setFromUnitVectors(UP, dir.multiplyScalar(1 / len));
    b.scale.set(radius, len, radius);
    const u = (b.material as ShaderMaterial).uniforms;
    u.uColor.value.set(color);
    u.uAlpha.value = alpha;
    u.uTime.value = clock;
    u.uTop.value = top;
    b.visible = true;
  }

  // ---------------------------------------------------------------- state

  const towers = new Map<string, Tower>();
  const rounds: Round[] = [];
  const flyers: Flyer[] = [];
  const pts: Pt[] = [];
  const fx: Fx[] = [];
  const floaters: { s: Sprite; t: Tower; t0: number }[] = [];
  let highlight: string | null = null;
  let clock = 0; // effect time: always runs
  let amb = 0; // ambient time: frozen with reduced motion
  let trauma = 0;
  let busyUntil = 0;
  const wake = (s: number) => void (busyUntil = Math.max(busyUntil, clock + s));

  const UP = new Vector3(0, 1, 0);
  const V1 = new Vector3();
  const V2 = new Vector3();
  const V3 = new Vector3();
  const V4 = new Vector3();
  const C1 = new Color();
  const C2 = new Color();
  const M1 = new Matrix4();
  const M2 = new Matrix4();
  const B1 = new Matrix4();
  const L1 = new Matrix4();
  const Q1 = new Quaternion();
  const E1 = new Euler();
  const S1 = new Vector3();
  const WHITE = new Color("#ffffff");
  const STONE = new Color("#9d95b8");
  const DUST = new Color("#b9aed2");
  const RED = new Color("#ff3b3b");
  const AMBER = new Color("#ffb02e");
  const GOLDC = new Color(GOLD);
  const HL = new Color("#8ff5dc");
  const ENV = new Color("#f4ead2");
  const FLAP = new Color("#cfb68c");

  function emitPt(kind: 0 | 1 | 2, p: Vector3, v: Vector3, life: number, size: number, c: Color, land = -Infinity, g = kind === 0 ? 9.8 : 0, delay = 0) {
    if (pts.length > 700) return;
    pts.push({ kind, p: p.clone(), v: v.clone(), age: -delay, life, size, c: c.clone(), land, g, spin: Math.random() * TAU });
  }
  const rnd = (a: number) => (Math.random() - 0.5) * 2 * a;
  function burst(p: Vector3, c: Color, n: number, speed: number, life = 0.7, size = 0.4) {
    for (let i = 0; i < n; i++) emitPt(1, p, V4.set(rnd(1), Math.random() * 0.9 + 0.2, rnd(1)).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.6)), life * (0.6 + Math.random() * 0.6), size, c);
  }
  function puffs(p: Vector3, n: number, spread: number, size = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      emitPt(2, V1.set(p.x + Math.sin(a) * spread * Math.random(), p.y + Math.random() * 0.3, p.z + Math.cos(a) * spread * Math.random()), V2.set(Math.sin(a) * 1.2, 0.5 + Math.random() * 0.8, Math.cos(a) * 1.2), 1 + Math.random() * 0.6, size * (0.8 + Math.random() * 0.8), DUST);
    }
  }

  // ---------------------------------------------------------------- labels

  function label(text: string, accent: string, gold: boolean): Sprite {
    const cv = document.createElement("canvas");
    const g = cv.getContext("2d")!;
    const font = "600 60px Inter, ui-sans-serif, system-ui, sans-serif";
    g.font = font;
    const H = 108;
    const W = Math.ceil(g.measureText(text).width) + 124;
    cv.width = W;
    cv.height = H;
    g.font = font;
    g.textBaseline = "middle";
    g.fillStyle = gold ? "rgba(46, 31, 6, 0.93)" : "rgba(13, 11, 32, 0.9)";
    g.strokeStyle = gold ? GOLD : accent;
    g.lineWidth = 6;
    g.beginPath();
    g.roundRect(4, 4, W - 8, H - 8, 32);
    g.fill();
    g.stroke();
    g.fillStyle = gold ? GOLD : accent;
    g.beginPath();
    g.arc(50, H / 2, 13, 0, TAU);
    g.fill();
    g.fillStyle = gold ? "#ffe39a" : "#eeecfa";
    g.fillText(text, 76, H / 2 + 3);
    const tex = new CanvasTexture(cv);
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = 4;
    const s = new Sprite(new SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false }));
    s.center.set(0.5, 0);
    s.renderOrder = 30;
    s.userData.aspect = W / H;
    s.visible = false;
    scene.add(s);
    return s;
  }
  function dropLabel(s: Sprite | null) {
    if (!s) return;
    scene.remove(s);
    s.material.map?.dispose();
    s.material.dispose();
  }
  // Labels grow a little with distance so they stay legible from the overview.
  function placeLabel(s: Sprite, p: Vector3, h: number, alpha: number) {
    const k = Math.min(2.4, Math.max(0.9, cam.position.distanceTo(p) / 30));
    s.position.copy(p);
    s.scale.set(h * k * s.userData.aspect, h * k, 1);
    s.material.opacity = alpha;
    s.visible = alpha > 0.01;
  }

  // ---------------------------------------------------------------- towers

  const statusOf = (s: string): Status => {
    const v = s.toLowerCase();
    return v === "illiquid" || v === "liquidating" || v === "closed" ? v : "solvent";
  };
  const alive = (t: Tower) => t.floors.reduce((n, f) => n + (f.gone ? 0 : 1), 0);

  function towerBase(t: Tower, out: Matrix4) {
    const sh = t.shakeT >= 0 ? Math.max(0, 1 - (clock - t.shakeT) / 0.35) : 0;
    out.makeTranslation(t.x + (sh ? Math.sin(clock * 90) * 0.08 * sh : 0), 0, t.z + (sh ? Math.cos(clock * 77) * 0.05 * sh : 0));
    if (t.lean) out.multiply(M2.makeRotationAxis(t.leanAxis, t.lean));
    out.multiply(M2.makeRotationY(t.yaw));
    return out.premultiply(t.isle.mat);
  }
  /** The tower's tip (beacon) in world space; the plinth top for a tower without floors. */
  function tipOf(t: Tower, out: Vector3) {
    towerBase(t, B1);
    const tip = TIPS[t.style];
    return t.floors.length ? out.set(tip.x * t.w, PL + t.top + tip.y, tip.z * t.d).applyMatrix4(B1) : out.set(0, PL + 0.5, 0).applyMatrix4(B1);
  }
  function roofOf(t: Tower, out: Vector3) {
    towerBase(t, B1);
    return out.set(0, PL + t.top + 0.15, 0).applyMatrix4(B1);
  }

  function addTower(f: PlazaFirm, isle: Isle): Tower | null {
    const slot = SLOTS.findIndex((_, i) => !isle.slots[i]);
    if (slot < 0) return null; // ponytail: 16 towers per island max, extra firms are not drawn
    const r = rng(hashStr(f.key));
    const s = SLOTS[slot];
    const status = statusOf(f.status);
    const t: Tower = {
      key: f.key,
      firm: f,
      isle,
      slot,
      x: s.x,
      z: s.z,
      yaw: s.a,
      w: 1.35 + r() * 0.35,
      d: 1.35 + r() * 0.35,
      style: r() < 0.5 ? 0 : 1,
      seed: Math.floor(r() * 997),
      floors: [],
      top: 0,
      target: 0,
      bonus: 0,
      next: clock + 0.25 + slot * 0.1,
      step: 0.07,
      built: false,
      color: new Color(f.color),
      to: new Color(f.color),
      status,
      phase: status === "closed" ? "rubble" : "standing",
      t0: -9,
      buyer: null,
      heat: 0,
      fills: f.fills,
      credit: 0,
      rankScore: 0.5,
      lit: 0.3,
      winT: -9,
      crackT: -9,
      shakeT: -9,
      scaffold: status === "liquidating" ? 1 : 0,
      lean: 0,
      leanAxis: new Vector3(r() - 0.5, 0, r() - 0.5).normalize(),
      plinth: 0,
    };
    isle.slots[slot] = t;
    towers.set(f.key, t);
    return t;
  }
  function freeTower(t: Tower) {
    towers.delete(t.key);
    if (t.isle.slots[t.slot] === t) t.isle.slots[t.slot] = null;
  }

  // Height from rank and relative value within the market (raw NAVs are too close to separate towers).
  function retarget(isle: Isle) {
    const live = [...towers.values()].filter((t) => t.isle === isle && t.status !== "closed" && (t.phase === "standing" || t.phase === "collapsing"));
    live.sort((a, b) => a.firm.rank - b.firm.rank);
    const navs = live.map((t) => t.firm.nav);
    const lo = Math.min(...navs);
    const hi = Math.max(...navs);
    live.forEach((t, i) => {
      t.rankScore = live.length > 1 ? 1 - i / (live.length - 1) : 0.6;
      const value = hi > lo ? (t.firm.nav - lo) / (hi - lo) : 0.5;
      t.target = Math.min(12, 3 + Math.round(6 * (0.6 * t.rankScore + 0.4 * value)) + t.bonus);
    });
  }

  function startCollapse(t: Tower) {
    t.phase = "collapsing";
    t.t0 = clock;
    t.next = clock + 0.22;
    t.step = Math.min(0.2, Math.max(0.09, 1.1 / Math.max(1, alive(t))));
    t.scaffold = 0;
    towerBase(t, B1);
    puffs(V1.set(0, PL, 0).applyMatrix4(B1), 6, 1.2, 1.3);
    wake(3);
  }

  function updateTower(t: Tower, dt: number) {
    t.color.lerp(t.to, 1 - Math.exp(-dt * 2.5));
    t.heat *= Math.exp(-dt / 400); // recent fills fade over minutes
    t.lit += (Math.min(0.92, 0.22 + 0.12 * t.rankScore + Math.min(0.55, t.heat * 0.14)) - t.lit) * (1 - Math.exp(-dt));
    t.scaffold += ((t.status === "liquidating" && t.phase === "standing" ? 1 : 0) - t.scaffold) * (1 - Math.exp(-dt * 2.5));
    t.plinth += ((t.phase === "removing" ? 0 : 1) - t.plinth) * (1 - Math.exp(-dt * 5));
    const n = alive(t);
    if (t.phase === "standing" || t.phase === "removing") {
      const want = t.phase === "removing" ? 0 : t.target;
      if (clock >= t.next && n < want) {
        t.floors.push({ y: t.top, vy: 0, s: 0, gone: false, born: clock });
        t.next = clock + (t.built ? 0.18 : 0.075);
      } else if (clock >= t.next && n > want) {
        for (let i = t.floors.length - 1; i >= 0; i--)
          if (!t.floors[i].gone) {
            t.floors[i].gone = true;
            break;
          }
        t.next = clock + 0.12;
      } else if (n === want && clock >= t.next) t.built = true;
      if (t.phase === "removing" && !t.floors.length && t.plinth < 0.02) freeTower(t);
    } else if (t.phase === "collapsing") {
      t.lean += (0.16 - t.lean) * (1 - Math.exp(-dt * 3));
      if (clock >= t.next && n > 0) {
        const f = t.floors.find((x) => !x.gone)!;
        f.gone = true;
        towerBase(t, B1);
        puffs(V1.set(0, PL + 0.2, 0).applyMatrix4(B1), 3, 1.1);
        t.next = clock + t.step;
      }
      if (!t.floors.length) {
        t.phase = "rubble";
        t.t0 = clock;
        t.lean = 0;
        towerBase(t, B1);
        puffs(V1.set(0, PL, 0).applyMatrix4(B1), 8, 1.6, 1.5);
      }
    } else if (t.phase === "takeover" && t.buyer) {
      if (clock >= t.next && t.floors.length) {
        const f = t.floors.pop()!;
        towerBase(t, B1);
        const last = !t.floors.length;
        flyers.push({ from: V1.set(0, PL + f.y, 0).applyMatrix4(B1).clone(), yaw: t.yaw + t.isle.angle, w: t.w, d: t.d, color: t.color.clone(), t0: clock, dur: 0.85, to: t.buyer, arc: 3.2 + Math.random() * 1.6, last, done: false });
        t.next = clock + t.step;
      }
      if (!t.floors.length) {
        t.phase = "lot";
        t.t0 = clock;
      }
    }
    // A new floor grows out of the top with a little overshoot (the roof bobs up); a collapse shrinks the bottom
    // floor and the ones above fall onto it under gravity.
    let stack = 0;
    for (const f of t.floors) {
      if (f.gone) f.s *= Math.exp(-dt * (t.phase === "collapsing" ? 16 : 12));
      else f.s = backOut(span(clock - f.born, 0, t.built ? 0.4 : 0.28));
      if (f.y > stack + 1e-4) {
        f.vy -= 30 * dt;
        f.y += f.vy * dt;
        if (f.y <= stack) {
          f.y = stack;
          f.vy = f.vy < -3 ? -f.vy * 0.2 : 0;
        }
      } else {
        f.y = stack;
        f.vy = 0;
      }
      stack = f.y + FH * f.s;
    }
    t.floors = t.floors.filter((f) => !(f.gone && f.s < 0.03));
    t.top = stack;
  }

  function drawTower(t: Tower) {
    towerBase(t, B1);
    const isle = t.isle;
    const hl = highlight === t.key ? 1 : 0;
    C1.copy(STONE).lerp(C2.set(TINT[isle.m]), 0.12);
    plinths.put(M1.multiplyMatrices(B1, L1.makeScale((t.w + 0.6) * t.plinth, PL * t.plinth, (t.d + 0.6) * t.plinth)), C1);
    const crack = t.crackT >= 0 ? (clock - t.crackT < 0.08 ? (clock - t.crackT) / 0.08 : 1 - span(clock - t.crackT, 0.5, 1.5)) : 0;
    const dark = t.phase === "collapsing" || t.phase === "removing" ? 1 : 0;
    const lit = t.status === "liquidating" ? t.lit * 0.5 : t.lit;
    const flicker = t.status === "illiquid" ? 1 : 0;
    const last = t.floors.length - 1;
    for (let i = 0; i <= last; i++) {
      const f = t.floors[i];
      const s = Math.max(f.s, 0.001);
      const xz = 0.8 + 0.2 * Math.min(1, s);
      M1.multiplyMatrices(B1, L1.makeScale(t.w * xz, FH * s, t.d * xz).setPosition(0, PL + f.y, 0));
      const idx = floors.put(M1, C1.copy(t.color).multiplyScalar(i % 2 ? 0.93 : 1));
      if (idx < 0) break;
      const pw = clock - t.winT - 0.22 - i * 0.075; // the win lights the windows floor by floor, bottom up
      const pulse = pw < 0 ? 0 : pw < 0.12 ? pw / 0.12 : Math.exp(-(pw - 0.12) * 1.8);
      floors.attrs.aWin.setXYZW(idx, lit, t.seed + i * 1.37, pulse, flicker);
      floors.attrs.aFx.setXYZW(idx, crack, hl, dark, t.crackT >= 0 ? Math.max(0, 1 - (clock - t.crackT) / 0.45) : 0);
    }
    // Highlight: one inverted hull around the whole stack, a clean toon outline.
    if (hl && t.top > 0.05) hull.put(M1.multiplyMatrices(B1, L1.makeScale(t.w * 1.08 + 0.12, t.top + 0.2, t.d * 1.08 + 0.12).setPosition(0, PL - 0.04, 0)), WHITE);
    if (t.floors.length && t.phase !== "removing") {
      M1.multiplyMatrices(B1, L1.makeScale(t.w, 1, t.d).setPosition(0, PL + t.top, 0));
      roofs[t.style].put(M1, C1.copy(t.color).lerp(WHITE, 0.25));
      // The beacon: firm colour when solvent, amber when illiquid, blinking red when liquidating.
      const tip = TIPS[t.style];
      V1.set(tip.x * t.w, PL + t.top + tip.y, tip.z * t.d).applyMatrix4(B1);
      if (t.phase === "collapsing") {
        /* the beacon dies with the tower */
      } else if (t.status === "liquidating") glows.add(V1, RED, 1.4, Math.sin(clock * 7) > 0 ? 1 : 0.06);
      else if (t.status === "illiquid") glows.add(V1, AMBER, 1.25, 0.75 + 0.25 * Math.sin(clock * 23 + t.seed));
      else glows.add(V1, C1.copy(t.color).lerp(WHITE, 0.4), 1.05 + hl * 0.5, 0.55 + 0.3 * Math.sin(amb * 2.2 + t.seed));
      if (t.scaffold > 0.01) {
        const h = (t.top + 0.45) * t.scaffold;
        const ox = t.w / 2 + 0.2;
        const oz = t.d / 2 + 0.2;
        C1.set("#e3a240");
        for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) poles.put(M1.multiplyMatrices(B1, L1.makeScale(0.07, h, 0.07).setPosition(sx * ox, PL, sz * oz)), C1);
        for (let y = FH * 1.5; y < h; y += FH * 2) {
          poles.put(M1.multiplyMatrices(B1, L1.makeScale(t.w + 0.5, 0.05, 0.05).setPosition(0, PL + y, oz)), C1);
          poles.put(M1.multiplyMatrices(B1, L1.makeScale(t.w + 0.5, 0.05, 0.05).setPosition(0, PL + y, -oz)), C1);
          poles.put(M1.multiplyMatrices(B1, L1.makeScale(0.05, 0.05, t.d + 0.5).setPosition(ox, PL + y, 0)), C1);
          poles.put(M1.multiplyMatrices(B1, L1.makeScale(0.05, 0.05, t.d + 0.5).setPosition(-ox, PL + y, 0)), C1);
        }
        const k = backOut(clamp01(t.scaffold * 1.2 - 0.2));
        L1.compose(V2.set(t.w * 0.22, PL + t.top + 0.1, -t.d * 0.22), Q1.setFromAxisAngle(UP, amb * 0.22 + t.seed), S1.set(k, k, k));
        crane.put(M1.multiplyMatrices(B1, L1), WHITE);
      }
    }
    // Rubble after a close, a bare lot after a takeover.
    if (t.phase === "rubble" || t.phase === "lot") {
      const r = rng(t.seed + 5);
      const nChunks = t.phase === "rubble" ? 10 : 3;
      for (let i = 0; i < nChunks; i++) {
        const k = backOut(span(clock - t.t0 - i * 0.035, 0, 0.35));
        const a = r() * TAU;
        const d = r() * (t.phase === "rubble" ? 0.75 : 0.5) * t.w;
        const sc = (t.phase === "rubble" ? 0.7 + r() * 0.8 : 0.45 + r() * 0.3) * k;
        L1.compose(V2.set(Math.sin(a) * d, PL + 0.1 + (1 - d / t.w) * 0.35 * (t.phase === "rubble" ? 1 : 0), Math.cos(a) * d), Q1.setFromEuler(E1.set(r() * 3, r() * 3, r() * 3)), S1.set(sc, sc * 0.8, sc));
        rubble.put(M1.multiplyMatrices(B1, L1), C1.copy(i % 3 ? t.color : STONE).multiplyScalar(0.62));
      }
    }
    if (hl) {
      const k = (Math.max(t.w, t.d) * 0.78 + 0.55) / 0.95;
      rings.put(M1.multiplyMatrices(B1, L1.makeScale(k, 1, k).setPosition(0, PL + 0.04, 0)), C1.copy(HL).multiplyScalar(0.7 + 0.3 * Math.sin(clock * 4)));
    }
  }

  // ---------------------------------------------------------------- rounds

  /** The parcel in island space: drop with a bounce, rest, then slide to the winner or lift away on a refund. */
  function parcelLocal(r: Round, out: Vector3) {
    const t = clock - r.t0;
    let s = 1;
    let sy = 1;
    let a = 1;
    if (t < 0.2) {
      out.set(0, PED + 13, 0);
      s = 0;
    } else if (t < 0.62) {
      out.set(0, PED + 13 * (1 - easeIn(span(t, 0.2, 0.62))), 0);
      sy = 1.18;
    } else {
      const b = t - 0.62;
      out.set(0, PED + Math.abs(Math.sin(b * 8)) * 0.55 * Math.exp(-b * 5.5), 0);
      sy = 1 - 0.32 * Math.exp(-b * 9) * Math.cos(b * 16);
    }
    if (r.end) {
      const te = clock - r.endT;
      if (r.end === 1 && r.winner) {
        const w = r.winner;
        const len = Math.hypot(w.x, w.z);
        const door = Math.max(0, len - (Math.max(w.w, w.d) / 2 + 0.45)) / len;
        const k = easeInOut(span(te, 0.2, 1.05));
        const lift = easeOut(span(te, 0, 0.2)) * 0.4 * (1 - k);
        out.lerp(V3.set(w.x * door, PL + 0.05, w.z * door), k);
        out.y += lift + Math.sin(k * Math.PI) * 1.7;
        s = 1 - easeIn(span(te, 0.85, 1.15));
      } else {
        const dip = te < 0.15 ? Math.sin((te / 0.15) * Math.PI) * 0.15 : 0;
        const k = span(te, 0.15, 1.25);
        out.y += -dip + easeIn(k) * 9;
        s = 1 - k * 0.5;
        a = 1 - k;
      }
    }
    return { s, sy, a };
  }

  function endRound(r: Round, how: 1 | 2, winner: Tower | null = null) {
    r.end = how;
    r.endT = clock;
    r.winner = winner;
    if (r.isle.round === r) r.isle.round = null;
    for (const e of r.envs.values()) {
      e.out = clock;
      e.toTower = !!winner && e.t === winner;
    }
    wake(3);
  }

  function updateRound(r: Round, dt: number) {
    const isle = r.isle;
    const side = C2.set(SIDE[r.side]);
    const t = clock - r.t0;
    const { s, sy, a } = parcelLocal(r, V1);
    const p = r.p.copy(V1).applyMatrix4(isle.mat);
    if (s > 0.01) {
      L1.compose(V1, Q1.setFromAxisAngle(UP, isle.angle + 0.4 + (r.end ? (clock - r.endT) * 3 : 0)), S1.set(s * (2 - sy) ** 0.5, s * sy, s * (2 - sy) ** 0.5));
      parcels.put(M1.multiplyMatrices(isle.mat, L1), C1.copy(r.mine ? GOLDC : WHITE).lerp(side, r.mine ? 0 : 0.4));
      glows.add(V2.copy(p).setY(p.y + 0.4), r.mine ? GOLDC : side, 3.6, 0.6 * a * s * (0.85 + 0.15 * Math.sin(clock * 3)));
    }
    // The side ring on the table, and a shockwave at impact.
    const te = r.end ? clock - r.endT : 0;
    const ringK = backOut(span(t, 0.05, 0.32)) * (r.end ? 1 - span(te, 0, 0.45) : 1);
    V2.set(0, PED + 0.04, 0);
    if (ringK > 0.01) {
      L1.compose(V2, Q1.setFromAxisAngle(UP, clock * 0.6), S1.set(ringK * 1.05, 1, ringK * 1.05));
      rings.put(M1.multiplyMatrices(isle.mat, L1), C1.copy(side).multiplyScalar(1.3));
    }
    if (t > 0.6 && t < 1.2) {
      const k = span(t, 0.6, 1.2);
      L1.compose(V2, Q1.identity(), S1.set(1 + k * 2.4, 1, 1 + k * 2.4));
      rings.put(M1.multiplyMatrices(isle.mat, L1), C1.copy(side).multiplyScalar((1 - k) * 1.4));
      if (t - dt <= 0.62) {
        puffs(V3.copy(V2).applyMatrix4(isle.mat), 5, 1.2, 0.8);
        burst(V3, side, 10, 3, 0.6, 0.35);
      }
    }
    if (t < 0.25) glows.add(V3.copy(V2).applyMatrix4(isle.mat), side, 1.5 + t * 8, t * 3); // anticipation: the table lights up
    if (r.mine && s > 0.01 && Math.random() < dt * (t < 0.7 ? 60 : 8)) emitPt(1, V3.set(p.x + rnd(0.5), p.y + 0.3 + rnd(0.4), p.z + rnd(0.5)), V4.set(rnd(0.2), 0.3, rnd(0.2)), 0.8, 0.45, GOLDC);
    // Sealed envelopes orbit above the table.
    const list = [...r.envs.values()];
    const n = list.length;
    list.forEach((e, i) => {
      const goal = amb * 0.32 + (i / Math.max(1, n)) * TAU;
      e.ang += (goal - e.ang) * (1 - Math.exp(-dt * 4));
      const orbit = V2.set(Math.cos(e.ang) * 2.5, PED + 2.1 + Math.sin(amb * 1.7 + i) * 0.1, Math.sin(e.ang) * 2.5).applyMatrix4(isle.mat);
      const fk = span(clock - e.born, 0, 0.85);
      let sc = 1.3 * backOut(span(clock - e.born, 0, 0.22));
      const ep = e.p;
      if (fk < 1) {
        const k = easeInOut(fk);
        ep.lerpVectors(e.from, orbit, k);
        ep.y += Math.sin(k * Math.PI) * 2.4;
        if (fk > 0.96) glows.add(ep, C1.copy(e.t.color), 1.6, 0.6);
      } else ep.copy(orbit);
      let roll = Math.sin(amb * 1.3 + i * 2) * 0.08 + (fk < 1 ? Math.sin(fk * Math.PI) * 0.5 : 0);
      let flap = 0;
      let seal = 1;
      let lab = 0;
      let rise = 0;
      if (e.open >= 0) {
        const to = clock - e.open;
        if (to < 0.15) {
          sc *= 1 + 0.18 * Math.sin((to / 0.15) * Math.PI);
          roll += Math.sin(to * 80) * 0.06;
        }
        flap = -0.8 * Math.PI * easeOut(span(to, 0.12, 0.42));
        seal = to < 0.12 ? 1 : to < 0.24 ? 1 + span(to, 0.12, 0.24) * 0.8 : 0;
        if (!e.popped && to >= 0.2) {
          e.popped = true;
          burst(ep, e.t.color, 8, 2.2, 0.5, 0.3);
        }
        lab = span(to, 0.25, 0.4);
        rise = 0.32 + 0.55 * backOut(span(to, 0.25, 0.6));
        sc *= 1 - 0.6 * easeInOut(span(to, 0.45, 0.8));
        if (e.best) {
          sc *= 1 + 0.15 * span(to, 0.3, 0.5);
          glows.add(ep, GOLDC, 3.2, (0.45 + 0.15 * Math.sin(clock * 5)) * span(to, 0.3, 0.6));
        }
      }
      const dim = r.best && !e.best && e.open >= 0 ? 0.45 : 1;
      let gone = false;
      if (e.out >= 0) {
        const to = clock - e.out;
        if (e.toTower) {
          const k = span(to, 0.1, 0.7);
          tipOf(e.t, V3);
          ep.lerp(V3, easeIn(k));
          ep.y += Math.sin(k * Math.PI) * 1.2;
          sc *= 1 - k * 0.7;
          if (k >= 1) gone = true;
        } else sc *= 1 - easeIn(span(to, 0, 0.5));
        lab *= 1 - span(to, 0.15, 0.6);
      }
      if (!gone && sc > 0.01) {
        glows.add(ep, e.t.color, 2.2 * sc, 0.28 * dim);
        M1.lookAt(cam.position, ep, UP);
        M1.multiply(M2.makeRotationZ(roll));
        M1.scale(S1.set(sc, sc, sc));
        M1.setPosition(ep);
        envBody.put(M1, C1.copy(ENV).multiplyScalar(dim));
        envFlap.put(M2.multiplyMatrices(M1, L1.makeRotationX(flap).setPosition(0, 0.32, 0.02)), C1.copy(FLAP).multiplyScalar(dim));
        if (seal > 0) envSeal.put(M2.multiplyMatrices(M1, L1.makeScale(seal, seal, seal).setPosition(0, -0.03, 0.04)), C1.copy(e.t.color).multiplyScalar(dim));
      }
      if (e.label) placeLabel(e.label, V3.copy(ep).setY(ep.y + rise * sc), 0.55, lab * (dim < 1 ? 0.55 : 1));
    });
  }

  // ---------------------------------------------------------------- weather

  function strike(isle: Isle) {
    const standing = [...towers.values()].filter((t) => t.isle === isle && t.floors.length);
    const target = standing.length && Math.random() < 0.6 ? tipOf(standing[Math.floor(Math.random() * standing.length)], V1).clone() : V1.set(rnd(7), 0.2, rnd(7)).add(isle.c).clone();
    const start = V2.set(target.x + rnd(4), 11.5, target.z + rnd(4));
    const pts = isle.boltPts;
    pts.forEach((q, k) => {
      const f = k / (pts.length - 1);
      q.lerpVectors(start, target, f);
      if (k && k < pts.length - 1) q.add(V3.set(rnd(0.9), rnd(0.3), rnd(0.9)).multiplyScalar(1 - f * 0.4));
    });
    isle.bolt.geometry.setFromPoints(pts);
    isle.boltT = clock;
    isle.nextBolt = clock + 3.5 + Math.random() * 5;
    isle.light.position.copy(target).setY(target.y + 3);
    burst(target, WHITE, 10, 3, 0.5, 0.4);
  }

  function updateWeather(isle: Isle, dt: number) {
    const want = isle.regime === "storm" ? 2 : isle.regime === "alert" ? 1 : 0;
    isle.amt += Math.max(-dt * 0.6, Math.min(dt * 0.6, want - isle.amt));
    const a = isle.amt;
    U.uGloom.value[isle.i] = a <= 1 ? a * 0.32 : 0.32 + (a - 1) * 0.33;
    isle.wind.value = 0.12 + a * 0.42;
    isle.rainAmt.value = clamp01(a - 1);
    isle.rain.visible = isle.rainAmt.value > 0.01;
    // Dark clouds gather over the island.
    const k = clamp01(a);
    if (k > 0.01) {
      const r = rng(77 + isle.i);
      C1.set("#a49ed6").lerp(C2.set("#6e68a4"), clamp01(a - 1)); // the island gloom darkens them further
      for (let j = 0; j < 15; j++) {
        const ang = r() * TAU + amb * 0.03;
        const d = r() * 6;
        const sc = (1.3 + r() * 1.3) * (0.3 + 0.7 * k);
        L1.compose(V1.set(isle.c.x + Math.sin(ang) * d, 10.4 + r() * 1.3 + (1 - k) * 3, isle.c.z + Math.cos(ang) * d), Q1.identity(), S1.set(sc * 1.5, sc * 0.6, sc));
        storms.put(L1, C1);
      }
    }
    // Lightning with a cooldown, never with reduced motion (flashes).
    if (!rm && a > 1.6 && clock >= isle.nextBolt) strike(isle);
    const tb = clock - isle.boltT;
    const f = tb < 0.07 ? 1 : tb < 0.11 ? 0.12 : tb < 0.22 ? 0.85 : tb < 0.34 ? (0.34 - tb) / 0.12 * 0.5 : 0;
    U.uFlash.value[isle.i] = f * 0.22;
    isle.light.intensity = f * 220;
    isle.bolt.visible = f > 0.05;
    (isle.bolt.material as LineBasicMaterial).opacity = f;
    if (f > 0.05) for (let j = 0; j < isle.boltPts.length - 1; j++) for (let q = 0; q < 3; q++) glows.add(V1.lerpVectors(isle.boltPts[j], isle.boltPts[j + 1], q / 3), C1.set("#cfc8ff"), 0.7, f * 0.55);
    if (isle.rainAmt.value > 0.3 && !rm) for (let j = 0; j < 6; j++) glows.add(V1.set(rnd(R - 1), 0.25, rnd(R - 1)).add(isle.c), C1.set("#c2c8ff"), 0.3, 0.5 * isle.rainAmt.value);
  }

  // ---------------------------------------------------------------- camera

  const ctl = new OrbitControls(cam, canvas);
  Object.assign(ctl, {
    enableDamping: !rm,
    dampingFactor: 0.08,
    rotateSpeed: 0.45,
    zoomSpeed: 0.8,
    panSpeed: 0.7,
    minDistance: 9,
    maxDistance: 210,
    minPolarAngle: 0.3,
    maxPolarAngle: 1.36, // never under the islands
    screenSpacePanning: false,
    maxTargetRadius: 52,
    autoRotateSpeed: 0.32,
  });
  ctl.addEventListener("change", () => wake(0.5));
  const sph = new Spherical();
  let flight: { a: View; b: View; t0: number; dur: number; auto: boolean } | null = null;
  let auto = true;
  let engaged = !rm; // attract mode from the start: the visitor has not touched anything yet
  let lastInput = -IDLE;
  let lastPing = -9;
  let focusM: MarketSym | null = null;

  const fit = (halfW: number, halfH: number) => {
    const vf = (cam.fov * Math.PI) / 360;
    const hf = Math.atan(Math.tan(vf) * cam.aspect);
    return Math.max(halfW / Math.tan(hf), halfH / Math.tan(vf));
  };
  function nowView(): View {
    sph.setFromVector3(V1.copy(cam.position).sub(ctl.target));
    return { t: ctl.target.clone(), r: sph.radius, phi: sph.phi, th: sph.theta };
  }
  function setView(v: View) {
    ctl.target.copy(v.t);
    cam.position.setFromSpherical(sph.set(v.r, v.phi, v.th)).add(v.t);
    cam.lookAt(v.t);
  }
  function viewOf(m: MarketSym | null): View {
    const isle = m ? isles.get(m) : undefined;
    const tall = cam.aspect < 1;
    if (!isle) return { t: new Vector3(0, 1.5, 0), r: fit(tall ? 30 : 39, 24), phi: tall ? 1.05 : 1.27, th: nowView().th };
    return { t: isle.c.clone().setY(tall ? 1.6 : 2.6), r: fit(tall ? 10.5 : 13, 8.4), phi: tall ? 1.05 : 1.19, th: isle.angle };
  }
  function fly(b: View, isAuto: boolean) {
    if (rm) {
      setView(b);
      ctl.update();
      wake(1);
      return;
    }
    flight = { a: nowView(), b, t0: clock, dur: 1.9, auto: isAuto };
  }
  const input = (e: Event) => {
    lastInput = clock;
    // Hovering only stops the auto camera; a press or the wheel also takes over a flight in progress.
    if (engaged || flight?.auto || e.type !== "pointermove") flight = null;
    engaged = false;
    ctl.autoRotate = false;
    wake(1.5);
    if (clock - lastPing > 0.25) {
      lastPing = clock;
      opts.onUserInput?.();
    }
  };
  canvas.addEventListener("pointerdown", input);
  canvas.addEventListener("pointermove", input);
  canvas.addEventListener("wheel", input, { passive: true });

  function updateCamera(dt: number) {
    if (auto && !engaged && clock - lastInput >= IDLE) {
      engaged = true;
      fly(viewOf(focusM), true);
    }
    if (flight) {
      const { a, b } = flight;
      const k = easeInOut(span(clock, flight.t0, flight.t0 + flight.dur));
      let dth = (b.th - a.th) % TAU;
      if (dth > Math.PI) dth -= TAU;
      if (dth < -Math.PI) dth += TAU;
      setView({ t: V2.lerpVectors(a.t, b.t, k), r: a.r * Math.pow(b.r / a.r, k), phi: lerp(a.phi, b.phi, k), th: a.th + dth * k });
      if (k >= 1) flight = null;
      wake(0.3);
    } else {
      ctl.autoRotate = engaged && !rm;
      ctl.update(dt);
      const ty = Math.min(9, Math.max(-3, ctl.target.y));
      if (ty !== ctl.target.y) {
        cam.position.y += ty - ctl.target.y;
        ctl.target.y = ty;
      }
    }
  }

  // ---------------------------------------------------------------- quality

  let quality: "auto" | "low" | "high" = "auto";
  let dpr = 1;
  let shadows = false;
  let bloomWanted = false;
  type Composer = { render(): void; setSize(w: number, h: number): void; setPixelRatio(r: number): void; dispose(): void };
  let composer: Composer | null = null;
  let bloomLoading = false;
  let frameMs = 16;
  let ftAcc = 0;
  let ftN = 0;
  let ftWait = 3;

  function setShadows(on: boolean) {
    if (shadows === on) return;
    shadows = on;
    renderer.shadowMap.enabled = on;
    sun.castShadow = on;
    sun.shadow.mapSize.set(2048, 2048);
    scene.traverse((o) => {
      const m = (o as Mesh).material as Material | Material[] | undefined;
      if (m) for (const x of Array.isArray(m) ? m : [m]) x.needsUpdate = true;
    });
  }
  function loadBloom() {
    if (composer || bloomLoading) return;
    bloomLoading = true;
    // Post-processing is a separate chunk: mobile and low quality never download it.
    Promise.all([
      import("three/examples/jsm/postprocessing/EffectComposer.js"),
      import("three/examples/jsm/postprocessing/RenderPass.js"),
      import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
      import("three/examples/jsm/postprocessing/OutputPass.js"),
    ])
      .then(([{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }]) => {
        bloomLoading = false;
        if (disposed) return;
        const w = Math.max(1, canvas.clientWidth);
        const h = Math.max(1, canvas.clientHeight);
        const c = new EffectComposer(renderer, new WebGLRenderTarget(w, h, { type: HalfFloatType, samples: 4 }));
        c.addPass(new RenderPass(scene, cam));
        c.addPass(new UnrealBloomPass(new Vector2(w, h), 0.55, 0.5, 0.88));
        c.addPass(new OutputPass());
        composer = c;
        resize();
      })
      .catch(() => {
        bloomLoading = false;
        bloomWanted = false;
      });
  }
  function applyQuality() {
    const dev = window.devicePixelRatio || 1;
    dpr = Math.min(dev, mobile || quality === "low" ? 1.5 : 2);
    setShadows(!mobile && quality !== "low");
    // Bloom on desktop only: always on "high", on "auto" until frames get slow.
    bloomWanted = !mobile && quality !== "low";
    if (bloomWanted) loadBloom();
    ftAcc = ftN = 0;
    ftWait = 3;
    resize();
  }
  function stepDown() {
    if (bloomWanted) bloomWanted = false;
    else if (dpr > 1) dpr = Math.max(1, dpr - 0.25);
    else if (shadows) setShadows(false);
    else return;
    resize();
  }

  function resize() {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    cam.aspect = w / h;
    cam.fov = cam.aspect < 1 ? 50 : 40; // portrait screens get a wider lens
    cam.updateProjectionMatrix();
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    composer?.setPixelRatio(dpr);
    composer?.setSize(w, h);
    wake(0.5);
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);

  // ---------------------------------------------------------------- frame

  const ndc = new Vector2();
  const ray = new Raycaster();
  const box = new Box3();
  let raf = 0;
  let lastT = performance.now();
  let lastRender = 0;
  let disposed = false;
  let hiddenAt = 0;

  function update(dt: number) {
    clock += dt;
    if (!rm) amb += dt;
    U.uTime.value = amb;
    beamN = 0;
    // Islands bob gently.
    for (const isle of isleList) {
      const bob = rm ? 0 : Math.sin(amb * 0.42 + isle.phase) * 0.22;
      E1.set(rm ? 0 : Math.sin(amb * 0.31 + isle.phase) * 0.006, isle.angle, rm ? 0 : Math.cos(amb * 0.27 + isle.phase) * 0.006);
      isle.mat.compose(V1.set(isle.c.x, bob, isle.c.z), Q1.setFromEuler(E1), S1.set(1, 1, 1));
      isle.mesh.matrix.copy(isle.mat);
      isle.mesh.matrixWorldNeedsUpdate = true;
      updateWeather(isle, dt);
      glows.add(V1.set(isle.c.x, -7.5, isle.c.z), C1.set(TINT[isle.m]), 30, 0.16); // the island's light on the clouds below
      for (const a of isle.anchors) {
        const tw = a.k === 0 ? 0.9 + 0.1 * Math.sin(amb * 9 + a.p.x * 3) : a.k === 1 ? 0.7 + 0.3 * Math.sin(amb * 1.5 + a.p.x + a.p.z) : a.k === 2 ? 0.7 + 0.3 * Math.sin(amb * 0.8 + a.p.y * 2) : 0.8;
        glows.add(V1.copy(a.p).applyMatrix4(isle.mat), a.c, a.s, (a.k === 2 ? 0.5 : 0.62) * tw);
      }
    }
    sea.rotation.y = amb * 0.004;
    sky.position.copy(cam.position);
    for (const t of towers.values()) updateTower(t, dt);
    for (const t of towers.values()) drawTower(t);
    // Takeover floors in flight.
    for (const f of flyers) {
      const k = (clock - f.t0) / f.dur;
      const b = f.to;
      roofOf(b, V2);
      let sy = 1;
      if (k < 1) {
        const e = easeInOut(k);
        V1.lerpVectors(f.from, V2, e);
        V1.y += Math.sin(e * Math.PI) * f.arc;
      } else {
        V1.copy(V2);
        sy = 1 - span(k, 1, 1 + 0.22 / f.dur);
        if (!f.done) {
          f.done = true;
          b.winT = clock - 0.45;
          burst(V2, b.color, 10, 2.5, 0.6, 0.4);
          trauma = Math.min(1, trauma + (f.last ? 0.55 : 0.12));
          if (f.last) {
            b.bonus = Math.min(2, b.bonus + 1);
            retarget(b.isle);
          }
        }
      }
      const e = clamp01(k);
      L1.compose(V1, Q1.setFromEuler(E1.set(Math.sin(e * Math.PI) * 0.5, lerp(f.yaw, b.yaw + b.isle.angle, e) + e * Math.PI, 0)), S1.set(lerp(f.w, b.w, e), FH * Math.max(0.001, sy), lerp(f.d, b.d, e)));
      const idx = floors.put(L1, C1.copy(f.color).lerp(b.color, e));
      if (idx >= 0) {
        floors.attrs.aWin.setXYZW(idx, 0.6, f.t0 * 13, 0.5 * Math.sin(e * Math.PI), 0);
        floors.attrs.aFx.setXYZW(idx, 0, 0, 0, 0);
      }
    }
    for (let i = flyers.length - 1; i >= 0; i--) if (clock - flyers[i].t0 > flyers[i].dur + 0.25) flyers.splice(i, 1);
    for (const r of rounds) updateRound(r, dt);
    for (let i = rounds.length - 1; i >= 0; i--) {
      const r = rounds[i];
      if (r.end && clock - r.endT > 1.6) {
        for (const e of r.envs.values()) dropLabel(e.label);
        rounds.splice(i, 1);
      }
    }
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      const k = clock - f.t0;
      tipOf(f.t, V1);
      V1.y += 0.5 + easeOut(span(k, 0, 0.5)) * 0.6 + k * 0.1;
      placeLabel(f.s, V1, 0.62, span(k, 0, 0.25) * (1 - span(k, 2.8, 3.3)));
      if (k > 3.3) {
        dropLabel(f.s);
        floaters.splice(i, 1);
      }
    }
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i];
      const k = (clock - f.t0) / f.dur;
      if (k >= 1) fx.splice(i, 1);
      else f.f(k);
    }
    for (let i = beamN; i < beams.length; i++) beams[i].visible = false;
    // Particles: coins (instanced), sparks (glows), dust (puffs).
    for (let i = pts.length - 1; i >= 0; i--) {
      const q = pts[i];
      q.age += dt;
      if (q.age < 0) continue;
      q.v.y -= q.g * dt;
      q.p.addScaledVector(q.v, dt);
      if (q.kind === 2) q.v.multiplyScalar(1 - dt * 1.5);
      const landed = q.p.y < q.land && q.v.y < 0;
      if (landed && q.kind === 0) burst(q.p, GOLDC, 3, 1.5, 0.4, 0.3);
      if (landed || q.age > q.life) {
        pts[i] = pts[pts.length - 1];
        pts.pop();
        continue;
      }
      const k = q.age / q.life;
      if (q.kind === 0) {
        L1.compose(q.p, Q1.setFromEuler(E1.set(0.3, q.spin + q.age * 9, 0)), S1.set(1, 1, 1));
        coins.put(L1, WHITE);
      } else if (q.kind === 1) glows.add(q.p, q.c, q.size * (0.7 + 0.3 * Math.sin(q.age * 30 + q.spin)), 1 - k);
      else dust.add(q.p, q.c, q.size * (1 + k * 1.8), 0.55 * (1 - k) * span(q.age, 0, 0.1));
    }
    // Birds circle in two loose flocks; drones blink between the islands.
    {
      for (let i = 0; i < 12; i++) {
        const flock = i < 7;
        const a = amb * (flock ? 0.05 : -0.11) + i * (flock ? 0.09 : 0.12);
        const rr = flock ? 47 + (i % 3) * 1.6 : 24 + (i % 2) * 1.4;
        const cx = flock ? 0 : isleList[0].c.x;
        const cz = flock ? 0 : isleList[0].c.z;
        V1.set(cx + Math.sin(a) * rr, (flock ? 10 : 15) + Math.sin(amb * 0.7 + i) * 0.6 + (i % 3) * 0.5, cz + Math.cos(a) * rr);
        L1.compose(V1, Q1.setFromAxisAngle(UP, a + (flock ? Math.PI / 2 : -Math.PI / 2)), S1.set(0.55, 0.55, 0.55));
        birds.put(L1, WHITE);
      }
      for (let i = 0; i < 4; i++) {
        const A = isleList[i % 3].c;
        const Bc = isleList[(i + 1) % 3].c;
        const k = 0.5 - 0.5 * Math.cos(amb * 0.05 + i * 1.7);
        V1.lerpVectors(A, Bc, k);
        V1.y = 6 + i * 0.8 + Math.sin(amb * 0.9 + i) * 0.4;
        V1.x += Math.sin(amb * 0.3 + i) * 4;
        glows.add(V2.copy(V1).setY(V1.y - 0.12), C1.set(i % 2 ? "#ff5a5a" : "#7dffd8"), 0.55, Math.sin(amb * 5 + i) > 0.3 ? 0.9 : 0.15);
        glows.add(V2.copy(V1).setY(V1.y + 0.05), WHITE, 0.3, 0.5);
      }
    }
    trauma = Math.max(0, trauma - dt * 1.3);
    updateCamera(dt);
    for (const p of [floors, hull, plinths, rubble, poles, crane, parcels, rings, envBody, envFlap, envSeal, coins, storms, birds, ...roofs]) p.flush();
    glows.flush();
    dust.flush();
  }

  function render() {
    renderer.info.reset();
    const shake = !rm && trauma > 0.001;
    if (shake) {
      const s = trauma * trauma * 0.6;
      V4.set(Math.sin(clock * 37) + Math.sin(clock * 61) * 0.5, Math.sin(clock * 43 + 1) * 0.8, Math.sin(clock * 53 + 2) + Math.sin(clock * 29) * 0.5).multiplyScalar(s);
      cam.position.add(V4);
    }
    if (composer && bloomWanted) composer.render();
    else renderer.render(scene, cam);
    if (shake) cam.position.sub(V4);
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    // Reduced motion: only a few frames per second while nothing happens.
    if (rm && clock > busyUntil && now - lastRender < 250) return;
    const real = now - lastT;
    lastT = now;
    const dt = Math.min(0.05, real / 1000);
    frameMs = frameMs * 0.95 + real * 0.05;
    // Auto quality: judged on real time (the sim clock is clamped), over windows of at least 1.5 s.
    if (quality === "auto" && !(rm && clock > busyUntil) && (ftWait -= real / 1000) <= 0) {
      ftAcc += real;
      if (++ftN >= 90 || ftAcc > 1500) {
        if (ftAcc / ftN > 22) {
          stepDown();
          ftWait = 2;
        }
        ftAcc = ftN = 0;
      }
    }
    update(dt);
    render();
    lastRender = now;
  }

  const onVis = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
      hiddenAt = performance.now();
    } else if (!raf && !disposed) {
      // Skip what played while hidden: queued animations complete instead of all firing at once.
      clock += Math.min(10, (performance.now() - hiddenAt) / 1000);
      lastT = performance.now();
      ftWait = 2;
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener("visibilitychange", onVis);

  applyQuality();
  setView(viewOf(null));
  // Compile every program up front, hidden pools included: the first auction or storm must not hitch (a hitch
  // would also trip the auto quality). Parallel compile where available, so this does not block either.
  {
    const hidden: Object3D[] = [];
    scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    renderer.compileAsync(scene, cam).catch(() => {});
    for (const o of hidden) o.visible = false;
  }
  if (!document.hidden) raf = requestAnimationFrame(frame);

  // ---------------------------------------------------------------- API

  const toScreen = (p: Vector3): ScreenPoint => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    V4.copy(p).project(cam);
    const x = ((V4.x + 1) / 2) * w;
    const y = ((1 - V4.y) / 2) * h;
    return { x, y, visible: V4.z > -1 && V4.z < 1 && x >= 0 && x <= w && y >= 0 && y <= h };
  };
  const towerOn = (market: MarketSym, key: string) => {
    const t = towers.get(key);
    return t && t.isle.m === market && t.phase !== "removing" ? t : undefined;
  };
  function commit(market: MarketSym, key: string) {
    const r = isles.get(market)?.round;
    const t = towerOn(market, key);
    if (!r || !t || r.envs.has(key)) return;
    const n = r.envs.size;
    r.envs.set(key, { t, born: clock, from: tipOf(t, V1).clone(), ang: amb * 0.32 + (n / (n + 1)) * TAU, open: -1, best: false, out: -1, toTower: false, popped: false, label: null, p: new Vector3() });
    wake(2);
  }

  return {
    setFirms(list) {
      const seen = new Set<string>();
      const touched = new Set<Isle>();
      const before = [...towers.values()].map((t) => `${t.key}${t.status}${t.phase}${t.target}${t.to.getHex()}`).join();
      for (const f of list) {
        const isle = isles.get(f.market);
        if (!isle) continue;
        seen.add(f.key);
        let t = towers.get(f.key);
        if (t && t.isle !== isle) {
          touched.add(t.isle);
          freeTower(t);
          t = undefined;
        }
        const fresh = !t;
        t ??= addTower(f, isle) ?? undefined;
        if (!t) continue;
        touched.add(isle);
        t.firm = f;
        t.to.set(f.color);
        if (t.phase === "removing") t.phase = "standing"; // it came back before its tower was gone
        const st = statusOf(f.status);
        if (st === "closed" && t.phase === "standing") {
          if (fresh) t.phase = "rubble";
          else startCollapse(t);
        } else if (st !== "closed" && t.phase === "rubble") {
          t.phase = "standing";
          t.built = false;
        }
        t.status = st;
        // Fills the scene already showed as a win are not counted twice.
        if (f.fills > t.fills) {
          const d = f.fills - t.fills;
          t.heat += Math.max(0, d - t.credit);
          t.credit = Math.max(0, t.credit - d);
        }
        t.fills = f.fills;
      }
      // A first look at a market: windows follow the fill counts so the city is lit from the start.
      for (const isle of touched) {
        const mine = [...towers.values()].filter((t) => t.isle === isle);
        const top = Math.max(1, ...mine.map((t) => t.firm.fills));
        for (const t of mine) if (!t.built && t.heat === 0) t.heat = 2.6 * (t.firm.fills / top);
      }
      for (const t of towers.values())
        if (!seen.has(t.key) && t.phase !== "removing") {
          t.phase = "removing";
          for (const f of t.floors) f.gone = true;
          touched.add(t.isle);
        }
      for (const isle of touched) retarget(isle);
      // Polled every few seconds: only wake a reduced-motion render loop when something visible changed.
      if ([...towers.values()].map((t) => `${t.key}${t.status}${t.phase}${t.target}${t.to.getHex()}`).join() !== before) wake(2);
    },
    setRegime(market, r) {
      const isle = isles.get(market);
      if (!isle || isle.regime === r) return;
      isle.regime = r;
      if (r === "storm") isle.nextBolt = Math.max(isle.nextBolt, clock + 1.5);
      wake(4);
    },
    order(market, o) {
      const isle = isles.get(market);
      if (!isle) return;
      if (isle.round) endRound(isle.round, 2); // a new order replaces an unsettled one
      const r: Round = { isle, side: o.side === "Sell" ? "Sell" : "Buy", mine: !!o.mine, t0: clock, end: 0, endT: 0, winner: null, envs: new Map(), best: false, p: new Vector3() };
      isle.round = r;
      rounds.push(r);
      wake(2.5);
    },
    commit,
    reveal(market, key, text, best) {
      const r = isles.get(market)?.round;
      const t = towerOn(market, key);
      if (!r || !t) return;
      let e = r.envs.get(key);
      if (!e) {
        // Joined after the commit: the envelope appears in place, already sealed.
        commit(market, key);
        e = r.envs.get(key)!;
        e.born = clock - 1;
      }
      if (e.open >= 0) return;
      e.open = clock;
      e.best = !!best;
      if (best) r.best = true;
      e.label = label(text, `#${t.color.getHexString()}`, !!best);
      wake(2);
    },
    win(market, key, text) {
      const isle = isles.get(market);
      const r = isle?.round;
      const t = towerOn(market, key);
      if (!isle || !r || !t) return;
      endRound(r, 1, t);
      t.winT = clock;
      t.heat += 1;
      t.credit += 1;
      fx.push({
        t0: clock,
        dur: 1.5,
        f: (k) => {
          const ped = V2.set(0, PED + 0.3, 0).applyMatrix4(isle.mat);
          const top = tipOf(t, V3);
          const grow = easeOut(span(k, 0.1, 0.3));
          const fade = 1 - span(k, 0.65, 1);
          beam(ped, V4.lerpVectors(ped, top, grow).clone(), 0.32, GOLD, 1.1 * fade * grow);
          beam(top, V4.copy(top).setY(top.y + 26), 0.9, GOLD, 0.65 * fade * span(k, 0.15, 0.35), 0.0);
          glows.add(ped, GOLDC, 3 + k * 2, (1 - k) * 0.8);
        },
      });
      // Coins rain on the winner's roof.
      roofOf(t, V1);
      for (let i = 0; i < 26; i++) emitPt(0, V2.set(V1.x + rnd(0.8), V1.y + 3.2 + Math.random() * 1.6, V1.z + rnd(0.8)), V3.set(rnd(0.6), -1 - Math.random() * 1.5, rnd(0.6)), 3, 1, GOLDC, V1.y, 9.8, 0.2 + i * 0.022);
      const s = label(text, GOLD, true);
      floaters.push({ s, t, t0: clock + 0.35 });
      wake(4);
    },
    refund(market) {
      const r = isles.get(market)?.round;
      if (!r) return;
      endRound(r, 2);
    },
    slash(market, key) {
      const t = towerOn(market, key);
      if (!t || !t.floors.length) return;
      t.crackT = t.shakeT = clock;
      towerBase(t, B1);
      const mid = V1.set(0, PL + t.top * 0.55, 0).applyMatrix4(B1).clone();
      fx.push({ t0: clock, dur: 0.9, f: (k) => glows.add(mid, RED, 5 + k * 4, (1 - k) * 1.2) });
      const out = V2.set(t.x, 0, t.z).normalize().transformDirection(t.isle.mat);
      for (let i = 0; i < 5; i++) emitPt(0, mid, V3.copy(out).multiplyScalar(1.6 + Math.random()).add(V4.set(rnd(0.8), 3 + Math.random(), rnd(0.8))), 2, 1, GOLDC, t.isle.mat.elements[13] + 0.1, 9.8, i * 0.05);
      burst(mid, RED, 18, 3.5, 0.6, 0.5);
      wake(2.5);
    },
    dividend(market, key) {
      const t = towerOn(market, key);
      if (!t || !t.floors.length) return;
      roofOf(t, V1);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * TAU;
        emitPt(0, V2.set(V1.x + Math.sin(a) * 0.5, V1.y + 0.5, V1.z + Math.cos(a) * 0.5), V3.set(Math.sin(a) * 0.4, 1.5 + Math.random() * 0.4, Math.cos(a) * 0.4), 1.4, 1, GOLDC, -Infinity, 0.7, i * 0.06);
        emitPt(1, V2, V3.multiplyScalar(0.8), 1.2, 0.5, GOLDC, -Infinity, 0, i * 0.06 + 0.1);
      }
      wake(2);
    },
    takeover(market, buyerKey, targetKey) {
      const b = towerOn(market, buyerKey);
      const t = towerOn(market, targetKey);
      if (!b || !t || b === t || t.phase === "lot" || t.phase === "rubble" || t.phase === "takeover") return;
      t.phase = "takeover";
      t.t0 = clock;
      t.buyer = b;
      t.scaffold = 0;
      t.next = clock + 0.35;
      t.step = Math.min(0.4, 2.3 / Math.max(1, t.floors.length));
      for (const f of t.floors) f.gone = false;
      fx.push({ t0: clock, dur: 0.6, f: (k) => glows.add(tipOf(t, V1), RED, 2 + k * 3, 1 - k) });
      wake(5);
    },
    close(market, key) {
      const t = towerOn(market, key);
      if (!t || (t.phase !== "standing" && t.phase !== "takeover")) return;
      startCollapse(t);
    },
    focus(market, force) {
      focusM = market;
      if (force) {
        lastInput = clock; // an explicit choice: hold it before the auto camera resumes
        engaged = false;
        fly(viewOf(market), false);
      } else if (engaged) fly(viewOf(market), true);
    },
    focusFirm(key) {
      const t = towers.get(key);
      if (!t) return;
      towerBase(t, B1);
      const base = V1.set(0, 0, 0).applyMatrix4(B1);
      lastInput = clock;
      engaged = false;
      fly({ t: base.clone().setY(PL + t.top * 0.55 + 0.6), r: Math.max(15, fit(5, 4.5)), phi: 1.18, th: Math.atan2(base.x - t.isle.c.x, base.z - t.isle.c.z) }, false);
    },
    setHighlight(key) {
      if (highlight !== key) wake(1);
      highlight = key;
    },
    pick(cx, cy) {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      ndc.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, cam);
      let best: string | null = null;
      let bd = Infinity;
      for (const t of towers.values()) {
        if (t.phase === "removing") continue;
        towerBase(t, B1);
        V1.set(0, 0, 0).applyMatrix4(B1);
        const hw = Math.max(t.w, t.d) / 2 + 0.35;
        box.min.set(V1.x - hw, V1.y, V1.z - hw);
        box.max.set(V1.x + hw, V1.y + PL + Math.max(0.7, t.top + (t.floors.length ? 1.2 : 0)), V1.z + hw);
        if (ray.ray.intersectBox(box, V2)) {
          const d = V2.distanceToSquared(ray.ray.origin);
          if (d < bd) {
            bd = d;
            best = t.key;
          }
        }
      }
      return best;
    },
    project(key) {
      const t = towers.get(key);
      return t ? toScreen(tipOf(t, V1)) : null;
    },
    projectMarket(market) {
      const isle = isles.get(market) ?? isleList[0];
      return toScreen(V1.set(0, PED, 0).applyMatrix4(isle.mat));
    },
    setAuto(on) {
      auto = on;
      if (!on) {
        engaged = false;
        if (flight?.auto) flight = null;
      }
    },
    setQuality(q) {
      quality = q;
      applyQuality();
    },
    resize,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("pointerdown", input);
      canvas.removeEventListener("pointermove", input);
      canvas.removeEventListener("wheel", input);
      ro.disconnect();
      ctl.dispose();
      for (const f of floaters) dropLabel(f.s);
      for (const r of rounds) for (const e of r.envs.values()) dropLabel(e.label);
      scene.traverse((o: Object3D) => {
        const m = o as Mesh;
        m.geometry?.dispose();
        const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
        for (const x of mats) {
          (x as SpriteMaterial).map?.dispose();
          x.dispose();
        }
      });
      ramp.dispose();
      softRamp.dispose();
      composer?.dispose();
      renderer.renderLists.dispose();
      renderer.resetState(); // default GL state, so a new renderer on this canvas (StrictMode remount) starts clean
      renderer.dispose();
    },
    stats: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, frameMs, dpr, bloom: !!composer && bloomWanted, shadows }),
  };
}
