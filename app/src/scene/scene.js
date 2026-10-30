// Tontine landing scene: a dot-matrix desert at dusk, a data sky, and five AI firms that replay
// the real `make demo` run (sealed bids, second price, dividends, slashing, liquidation, takeover).
// Everything is GPU points: no textures, no postprocessing.
import * as THREE from "three";

// Colours here are written like CSS colours and output as is: no linear conversion.
THREE.ColorManagement.enabled = false;
import { FIRMS, EXTRA_SLOTS, JOB, STORY, STORY_LENGTH } from "./story.js";

const TAU = Math.PI * 2;
// Horizon height as a fraction of the viewport from the top; main.js moves it between the trust row and the title.
let HORIZON = 0.34;

// ------------------------------------------------------------------ shaders

const DOT_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aAlpha;
  uniform float uPixelRatio;
  uniform float uScale;
  uniform float uMaxSize;
  uniform vec4 uCalm;          // calm zone: center xy, half size zw (NDC)
  uniform float uCalmStrength;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float size = aSize * uScale * uPixelRatio / max(-mv.z, 0.001);
    float alpha = aAlpha;
    // Below 2px a point shimmers: keep it at 2px and fade it instead.
    if (size < 2.0) { alpha *= max(size, 0.0) / 2.0; size = 2.0; }
    gl_PointSize = min(size, uMaxSize * uPixelRatio);
    vec2 ndc = gl_Position.xy / max(gl_Position.w, 0.0001);
    vec2 d = max(abs(ndc - uCalm.xy) - uCalm.zw, 0.0);
    float inside = 1.0 - smoothstep(0.0, 0.16, length(d));
    vAlpha = alpha * (1.0 - uCalmStrength * inside);
    vColor = aColor;
  }
`;

const DOT_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uHardness;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float r2 = dot(p, p) * 4.0;               // 0 at center, 1 at the edge
    float a = exp(-r2 * uHardness) * (1.0 - smoothstep(0.85, 1.0, r2)) * vAlpha;
    if (a < 0.002) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

const DUNE_VERT = /* glsl */ `
  attribute float aShade;
  attribute float aPhase;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform vec4 uCalm;
  uniform float uCalmStrength;
  uniform vec3 uGlow;
  uniform vec3 uDeep;
  uniform vec3 uHaze;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec3 p = position;
    // Wind: sand grains drift along the crests.
    p.y += sin(p.x * 0.55 - uTime * 0.55 + p.z * 0.3) * 0.035;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = -mv.z;
    float far = smoothstep(18.0, 150.0, dist);
    float near = smoothstep(2.0, 16.0, dist);
    float twinkle = 0.86 + 0.14 * sin(uTime * (0.6 + aPhase * 1.7) + aPhase * 40.0);
    vec3 lit = mix(uDeep, uGlow, pow(aShade, 1.7));
    vColor = mix(lit, uHaze, far * 0.75);
    float size = (1.25 + 0.6 * aShade) * uPixelRatio * (18.0 / max(dist, 0.001));
    float alpha = (0.1 + 0.55 * pow(aShade, 1.3)) * near * twinkle * (1.0 - far * 0.7);
    if (size < 1.6) { alpha *= size / 1.6; size = 1.6; }
    gl_PointSize = min(size, 4.0 * uPixelRatio);
    vec2 ndc = gl_Position.xy / max(gl_Position.w, 0.0001);
    vec2 d = max(abs(ndc - uCalm.xy) - uCalm.zw, 0.0);
    float inside = 1.0 - smoothstep(0.0, 0.2, length(d));
    vAlpha = alpha * (1.0 - uCalmStrength * 0.45 * inside);
  }
`;

const DUNE_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float a = (1.0 - smoothstep(0.32, 0.5, length(p))) * vAlpha;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

// Solid dunes: dark sand lit from behind by the horizon, with a warm rim on the crests.
const TERRAIN_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vW;
  varying float vDist;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    vN = normal;
    vec4 mv = viewMatrix * w;
    vDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const TERRAIN_FRAG = /* glsl */ `
  uniform vec3 uCam;
  uniform vec3 uLight;
  uniform vec3 uGlow;
  uniform vec3 uHaze;
  uniform vec3 uBase;
  uniform float uTime;
  varying vec3 vN;
  varying vec3 vW;
  varying float vDist;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  void main() {
    vec3 N = normalize(vN);
    vec3 V = normalize(uCam - vW);
    // Warm back light from the horizon (rim on the crests), cool fill from the front (dune forms).
    float back = pow(clamp(dot(N, uLight) * 0.5 + 0.5, 0.0, 1.0), 2.5);
    float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
    float fill = clamp(dot(N, normalize(vec3(-0.45, 0.75, 0.5))), 0.0, 1.0);
    vec3 col = uBase
      + uGlow * rim * (0.16 + 0.72 * back)
      + vec3(0.13, 0.1, 0.22) * pow(fill, 1.6);
    // Carry the dusk down to the foreground: slopes facing the horizon catch the sky, the others stay in
    // shade, so the near dunes read as coloured waves. Sand grain is fixed to the ground, not the screen.
    float face = clamp(dot(N, uLight) * 0.5 + 0.5, 0.0, 1.0);
    float reach = smoothstep(6.0, 34.0, vDist);
    vec3 dusk = mix(uHaze * 1.4, uGlow * 0.7, pow(face, 3.0));
    col += dusk * (0.12 + 0.75 * pow(face, 4.0)) * reach;
    col *= 0.78 + 0.44 * hash(floor(vW.xz * 40.0));
    float fog = smoothstep(26.0, 300.0, vDist);
    col = mix(col, uHaze, fog * 0.8);
    col += uGlow * 0.07 * fog * fog * (0.6 + 0.4 * rim);
    col += (hash(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) * 0.035;
    gl_FragColor = vec4(col, 1.0);
  }
`;

// The sky: dusk gradient, horizon glow and a falling rain of dot-matrix glyphs.
const SKY_VERT = /* glsl */ `
  void main() { gl_Position = vec4(position.xy, 0.9999, 1.0); }
`;

const SKY_FRAG = /* glsl */ `
  precision highp float;
  uniform vec2 uResolution;
  uniform float uTime;
  uniform float uHorizon;      // GL y of the horizon, 0..1 from the bottom
  uniform float uPixelRatio;
  uniform float uRain;
  uniform vec4 uCalm;          // NDC
  uniform float uCalmStrength;

  // 5x7 glyphs, one row per int, MSB on the left: 0 8 S X # $ 1 %
  const int G[56] = int[56](
    14,17,19,21,25,17,14,  14,17,17,14,17,17,14,  15,16,16,14,1,1,30,  17,17,10,4,10,17,17,
    10,10,31,10,31,10,10,  4,15,20,14,5,30,4,     4,12,4,4,4,4,14,     25,26,2,4,8,11,19
  );

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

  void main() {
    vec2 frag = gl_FragCoord.xy;
    float y = frag.y / uResolution.y;
    float t = (y - uHorizon) / max(1.0 - uHorizon, 0.001);   // 0 at the horizon, 1 at the top

    vec3 top = vec3(0.035, 0.03, 0.07);
    vec3 mid = vec3(0.16, 0.10, 0.25);
    vec3 low = vec3(0.47, 0.25, 0.42);
    vec3 glow = vec3(1.0, 0.56, 0.42);
    vec3 col;
    if (t >= 0.0) {
      col = mix(low, mid, smoothstep(0.0, 0.35, t));
      col = mix(col, top, smoothstep(0.3, 1.0, t));
      col += glow * (0.55 * exp(-t * 14.0) + 0.16 * exp(-t * 3.5));
    } else {
      float b = -t * (1.0 - uHorizon) / max(uHorizon, 0.001);   // 0 at the horizon, 1 at the bottom
      col = mix(glow * 0.32, vec3(0.0), smoothstep(0.0, 0.18, b));
    }

    // Glyph rain, only above the horizon.
    if (t > 0.0 && uRain > 0.0) {
      float pitch = 2.0 * uPixelRatio;                  // dot pitch in device pixels
      vec2 cell = vec2(6.0, 9.0) * pitch;               // 5x7 glyph + spacing
      float col_i = floor(frag.x / cell.x);
      float speed = mix(0.35, 1.25, hash(vec2(col_i, 7.0)));
      float yTop = (uResolution.y - frag.y) / cell.y;
      float row_f = yTop - uTime * speed + hash(vec2(col_i, 3.0)) * 50.0;
      float row_i = floor(row_f);
      float density = mix(0.05, 0.5, smoothstep(0.05, 0.95, t));
      float on = step(1.0 - density, hash(vec2(col_i, row_i)));
      if (on > 0.0) {
        float flick = floor(uTime * mix(0.5, 3.0, hash(vec2(row_i, col_i))));
        int g = int(floor(hash(vec2(col_i + flick, row_i)) * 8.0));
        vec2 local = vec2(mod(frag.x, cell.x), fract(row_f) * cell.y) / pitch;
        int cx = int(floor(local.x));
        int cy = int(floor(local.y));
        if (cx < 5 && cy < 7) {
          int bits = G[g * 7 + cy];
          if (((bits >> (4 - cx)) & 1) == 1) {
            vec2 f = fract(local) - 0.5;
            float dotMask = 1.0 - smoothstep(0.26, 0.42, length(f));
            float bright = mix(0.25, 0.9, hash(vec2(col_i * 3.1, row_i)));
            float fade = smoothstep(0.02, 0.45, t);
            vec2 ndc = frag / uResolution * 2.0 - 1.0;
            vec2 dd = max(abs(ndc - uCalm.xy) - uCalm.zw, 0.0);
            float calm = 1.0 - uCalmStrength * 0.8 * (1.0 - smoothstep(0.0, 0.18, length(dd)));
            col += vec3(0.86, 0.82, 0.95) * dotMask * bright * fade * calm * 0.36 * uRain;
          }
        }
      }
    }

    // Film grain, like the dusk footage this scene replaces.
    col += (hash(frag + fract(uTime) * 61.0) - 0.5) * 0.025;
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ------------------------------------------------------------------ helpers

const hex = (h) => new THREE.Color(h);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function dotMaterial(uniformsBase, hardness = 3.2) {
  return new THREE.ShaderMaterial({
    uniforms: { ...uniformsBase, uHardness: { value: hardness } },
    vertexShader: DOT_VERT,
    fragmentShader: DOT_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
}

/** A Points cloud of `n` dots whose attributes are rewritten every frame. */
function dynamicPoints(n, material) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const alpha = new Float32Array(n);
  for (const [name, arr, k] of [["position", pos, 3], ["aColor", col, 3], ["aSize", size, 1], ["aAlpha", alpha, 1]]) {
    const attr = new THREE.BufferAttribute(arr, k);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, attr);
  }
  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  return {
    points,
    pos,
    col,
    size,
    alpha,
    n,
    used: 0,
    begin() {
      this.used = 0;
    },
    push(x, y, z, c, s, a) {
      if (this.used >= this.n || a <= 0.001) return;
      const i = this.used++;
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      size[i] = s;
      alpha[i] = a;
    },
    end() {
      geo.setDrawRange(0, this.used);
      for (const name of ["position", "aColor", "aSize", "aAlpha"]) geo.attributes[name].needsUpdate = true;
    },
  };
}

function bezier(out, a, c, b, t) {
  const u = 1 - t;
  out.set(
    u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    u * u * a.z + 2 * u * t * c.z + t * t * b.z,
  );
  return out;
}

/** Height of the dunes at (x, z): broad wind-shaped ridges and one large dune on the horizon. */
function duneHeight(x, z) {
  const ridge = Math.sin(x * 0.07 + z * 0.045 + Math.sin(z * 0.021) * 1.4);
  const crest = 1 - Math.abs(Math.sin(x * 0.045 - z * 0.032 + 0.6));
  const big = 3.4 * Math.exp(-((x / 26) ** 2 + ((z + 78) / 34) ** 2));
  const left = 2.2 * Math.exp(-(((x + 34) / 20) ** 2 + ((z + 40) / 22) ** 2));
  const right = 2.0 * Math.exp(-(((x - 30) / 18) ** 2 + ((z + 34) / 20) ** 2));
  const ripples = 0.06 * Math.sin(x * 1.1 + z * 0.6) * Math.sin(z * 0.9 - x * 0.3);
  // Far ridges rise above the camera so their crests cut the glow, as dunes do at dusk.
  const farT = Math.min(1, Math.max(0, (-z - 70) / 120));
  const far = farT * farT * (6.5 + 3.2 * Math.sin(x * 0.018 + 1.3) + 2.2 * Math.sin(x * 0.047 - 0.4));
  return -1.9 + 0.9 * ridge + 1.3 * crest * crest + big + left + right + ripples + far;
}

// ------------------------------------------------------------------ scene

// mode "replay": plays the recorded `make demo` story in a loop. mode "live": driven from outside with
// act(step), one call per chain event. firmNames: the firms in chain order (live mode).
export function startScene({
  canvas,
  tagsLayer,
  onEvent,
  onPhase,
  reducedMotion = false,
  isMobile = false,
  mode = "replay",
  firmNames = null,
  calmStrength = 0.72,
  debugQuery = true,
  swarmInHero = true,
}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 1);
  let pixelRatio = Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 600);
  camera.rotation.order = "YXZ";
  const BASE = new THREE.Vector3(0, 3.1, 16);
  camera.position.copy(BASE);

  let clock = 0;
  let explore = 0; // 0 = hero view, 1 = arena view ("Watch the swarm")
  let exploreTarget = 0;
  const calm = new THREE.Vector4(0, 0, 0, 0);
  const shared = {
    uPixelRatio: { value: pixelRatio },
    uScale: { value: 260 },
    uMaxSize: { value: 64 },
    uCalm: { value: calm },
    uCalmStrength: { value: calmStrength },
  };

  // Sky
  const skyUniforms = {
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uHorizon: { value: 1 - HORIZON },
    uPixelRatio: { value: pixelRatio },
    uRain: { value: 1 },
    uCalm: { value: calm },
    uCalmStrength: shared.uCalmStrength,
  };
  const sky = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({ uniforms: skyUniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, depthWrite: false, depthTest: false }),
  );
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);

  // Dunes
  const duneUniforms = {
    uTime: { value: 0 },
    uPixelRatio: shared.uPixelRatio,
    uCalm: { value: calm },
    uCalmStrength: shared.uCalmStrength,
    uGlow: { value: hex("#ff9f86") },
    uDeep: { value: hex("#1a1026") },
    uHaze: { value: hex("#7d4d78") },
  };
  const dunes = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.ShaderMaterial({
      uniforms: duneUniforms,
      vertexShader: DUNE_VERT,
      fragmentShader: DUNE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    }),
  );
  dunes.frustumCulled = false;
  dunes.renderOrder = -5;
  scene.add(dunes);
  let duneAspect = 0;

  const terrainUniforms = {
    uCam: { value: camera.position },
    uLight: { value: new THREE.Vector3(0.1, 0.32, -1).normalize() },
    uGlow: { value: hex("#ec8f97") },
    uHaze: { value: hex("#3a2140") },
    uBase: { value: hex("#060309") },
    uTime: { value: 0 },
  };
  const terrain = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.ShaderMaterial({
      uniforms: terrainUniforms,
      vertexShader: TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
      side: THREE.DoubleSide, // the near ground is seen from above, against the winding
      polygonOffset: true, // let the grain dots sitting on the surface win the depth test
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    }),
  );
  terrain.frustumCulled = false;
  terrain.renderOrder = -8;
  scene.add(terrain);

  function buildTerrain(aspect) {
    const nx = isMobile ? 110 : 190;
    const nz = isMobile ? 90 : 150;
    const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.max(aspect, 0.6) * 1.5;
    const pos = new Float32Array(nx * nz * 3);
    const nrm = new Float32Array(nx * nz * 3);
    const e = 0.35;
    for (let j = 0; j < nz; j++) {
      const d = 1.5 * Math.pow(220, j / (nz - 1));
      const z = BASE.z - d;
      const half = d * tanH + 4;
      for (let i = 0; i < nx; i++) {
        const x = (i / (nx - 1)) * 2 * half - half;
        const k = (j * nx + i) * 3;
        pos[k] = x;
        pos[k + 1] = duneHeight(x, z);
        pos[k + 2] = z;
        const n = new THREE.Vector3(duneHeight(x - e, z) - duneHeight(x + e, z), 2 * e, duneHeight(x, z - e) - duneHeight(x, z + e)).normalize();
        nrm[k] = n.x;
        nrm[k + 1] = n.y;
        nrm[k + 2] = n.z;
      }
    }
    const idx = [];
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    geo.setIndex(idx);
    terrain.geometry.dispose();
    terrain.geometry = geo;
  }

  function buildDunes(aspect) {
    duneAspect = aspect;
    const nx = isMobile ? 150 : 270;
    const nz = isMobile ? 110 : 200;
    const n = nx * nz;
    const pos = new Float32Array(n * 3);
    const shade = new Float32Array(n);
    const phase = new Float32Array(n);
    const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.max(aspect, 0.6) * 1.35;
    const light = new THREE.Vector3(0.15, 0.55, -1).normalize();
    const e = 0.35;
    let k = 0;
    for (let j = 0; j < nz; j++) {
      const v = (j + Math.random()) / nz;
      const d = 3 * Math.pow(110, v); // log depth: even density on screen
      const z = BASE.z - d;
      const half = d * tanH + 3;
      for (let i = 0; i < nx; i++) {
        const x = ((i + Math.random()) / nx) * 2 * half - half;
        const y = duneHeight(x, z);
        const nxv = duneHeight(x - e, z) - duneHeight(x + e, z);
        const nzv = duneHeight(x, z - e) - duneHeight(x, z + e);
        const nrm = new THREE.Vector3(nxv, 2 * e, nzv).normalize();
        pos[k * 3] = x;
        pos[k * 3 + 1] = y;
        pos[k * 3 + 2] = z;
        const lambert = Math.max(0, nrm.dot(light));
        shade[k] = clamp01(Math.pow(lambert, 1.5) * 1.1 + Math.random() * 0.08);
        phase[k] = Math.random();
        k++;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aShade", new THREE.BufferAttribute(shade, 1));
    geo.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    dunes.geometry.dispose();
    dunes.geometry = geo;
  }

  // Swarm, decorations, beams, sparks and the job: all additive dots.
  const AGENTS_PER_FIRM = isMobile ? 70 : 160;
  const TRAIL = 4;
  const agentsCloud = dynamicPoints(FIRMS.length * AGENTS_PER_FIRM * (TRAIL + 1), dotMaterial(shared, 3.4));
  const RINGS = [
    { r: 0.95, w: 0.95, rx: 0.42, rz: 0.18 },
    { r: 1.55, w: 0.62, rx: -0.55, rz: 0.62 },
    { r: 2.25, w: 0.44, rx: 1.12, rz: -0.38 },
  ];
  const decoCloud = dynamicPoints(6000, dotMaterial(shared, 3.0));
  const glowCloud = dynamicPoints(64, dotMaterial(shared, 1.6));
  for (const c of [decoCloud, agentsCloud, glowCloud]) scene.add(c.points);

  // ------------------------------------------------------------------ state

  const defs = firmNames
    ? firmNames.map((name, i) => ({ ...(FIRMS.find((f) => f.name === name) ?? EXTRA_SLOTS[i % EXTRA_SLOTS.length]), name }))
    : FIRMS;
  const firms = defs.map((f, i) => ({
    ...f,
    index: i,
    anchor: new THREE.Vector3(),
    anchorHero: new THREE.Vector3(),
    anchorArena: new THREE.Vector3(),
    tint: hex(f.color),
    baseTint: hex(f.color),
    target: hex(f.color),
    energy: 1, // core brightness, drops when illiquid
    pulse: 0, // ring flash
    pulseColor: hex("#ffffff"),
    mode: "idle", // idle | rush | scatter
    hollow: false,
    owner: null, // index of the buyer firm after a takeover
  }));

  const agents = [];
  for (const f of firms) {
    const spin = f.index % 2 ? 1 : -1;
    for (let k = 0; k < AGENTS_PER_FIRM; k++) {
      const ring = RINGS[k % 3];
      const scout = Math.random() < 0.1;
      agents.push({
        firm: f.index,
        p: new THREE.Vector3(),
        v: new THREE.Vector3(),
        trail: Array.from({ length: TRAIL }, () => new THREE.Vector3()),
        phase: Math.random() * TAU,
        ring,
        r: ring.r * (0.88 + Math.random() * 0.24) * (scout ? 1.5 : 1),
        speed: ring.w * spin * (0.85 + Math.random() * 0.3),
        wob: (Math.random() - 0.5) * 0.3,
        tilt: (Math.random() - 0.5) * 1.4,
        lag: Math.random(),
        size: 0.5 + Math.random() * 0.55,
      });
    }
  }

  const job = { on: 0, target: 0, pos: new THREE.Vector3(), anchor: new THREE.Vector3(), anchorHero: new THREE.Vector3(), anchorArena: new THREE.Vector3(), flash: 0, flashColor: hex("#ffffff"), born: 0, rings: [] };
  const beams = []; // { from, to, kind, state, born, color, fade }
  const sparks = []; // { a, c, b, t, dur, color, size, delay, born }
  const tags = new Map(); // key -> { el, pos(), until }

  // ------------------------------------------------------------------ layout

  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  let width = 1;
  let height = 1;

  function worldAt(fx, fy, dist, out) {
    tmp.set(fx * 2 - 1, 1 - fy * 2, 0.5).unproject(camera);
    tmp.sub(camera.position).normalize();
    return out.copy(camera.position).addScaledVector(tmp, dist);
  }

  function layout() {
    width = Math.max(1, canvas.clientWidth || window.innerWidth);
    height = Math.max(1, canvas.clientHeight || window.innerHeight);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // Narrow screens: widen the view so the swarm still fits around the copy.
    camera.fov = camera.aspect < 0.8 ? 62 : 48;
    camera.updateProjectionMatrix();
    const ndcY = 1 - 2 * HORIZON;
    camera.position.copy(BASE);
    camera.rotation.set(-Math.atan(ndcY * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))), 0, 0);
    camera.updateMatrixWorld();
    skyUniforms.uResolution.value.set(width * pixelRatio, height * pixelRatio);
    skyUniforms.uHorizon.value = 1 - HORIZON;
    skyUniforms.uPixelRatio.value = pixelRatio;
    shared.uPixelRatio.value = pixelRatio;
    shared.uScale.value = height * 0.1;
    const portrait = camera.aspect < 0.8;
    const place = (spot, dist, out) => {
      worldAt(spot[0], spot[1], dist, out);
      // Never inside a dune: keep the core and its rings above the sand.
      out.y = Math.max(out.y, duneHeight(out.x, out.z) + 2.6);
    };
    for (const f of firms) {
      place(portrait ? f.screenMobile : f.screen, portrait ? f.distMobile : f.dist, f.anchorHero);
      place(portrait ? f.screenMobile : f.arena, portrait ? f.distMobile : f.arenaDist, f.anchorArena);
    }
    worldAt(...(portrait ? JOB.screenMobile : JOB.screen), portrait ? JOB.distMobile : JOB.dist, job.anchorHero);
    worldAt(...(portrait ? JOB.screenMobile : JOB.arena), portrait ? JOB.distMobile : JOB.arenaDist, job.anchorArena);
    placeAnchors();
    const aspect = camera.aspect;
    if (!duneAspect || Math.abs(aspect - duneAspect) / duneAspect > 0.2) {
      buildDunes(aspect);
      buildTerrain(aspect);
    }
  }

  function placeAnchors() {
    const e = easeInOut(clamp01(explore));
    for (const f of firms) f.anchor.lerpVectors(f.anchorHero, f.anchorArena, e);
    job.anchor.lerpVectors(job.anchorHero, job.anchorArena, e);
  }

  function setCalmRect(rect) {
    if (!rect) return;
    const cx = ((rect.left + rect.right) / 2 / width) * 2 - 1;
    const cy = 1 - ((rect.top + rect.bottom) / 2 / height) * 2;
    calm.set(cx, cy, (rect.right - rect.left) / width, (rect.bottom - rect.top) / height);
  }

  // ------------------------------------------------------------------ tags (HTML labels)

  // slot: "above", "below", "left" or "right" of the object (radius r in world units, turned into
  // pixels on screen), or "center".
  function tag(key, text, cls, worldFn, seconds, slot = "center", r = 0) {
    let t = tags.get(key);
    if (!t) {
      const el = document.createElement("div");
      el.className = `tag ${cls}`;
      tagsLayer.appendChild(el);
      t = { el, worldFn, until: 0 };
      tags.set(key, t);
    }
    if (text) t.el.textContent = text;
    t.w = undefined;
    t.el.className = `tag ${cls}`;
    t.worldFn = worldFn;
    t.slot = slot;
    t.r = r;
    t.until = seconds === Infinity ? Infinity : clock + seconds;
    requestAnimationFrame(() => {
      if (t.until > clock) t.el.classList.add("show");
    });
  }

  function dropTag(key) {
    const t = tags.get(key);
    if (t) t.until = 0;
  }

  function updateTags() {
    for (const [key, t] of tags) {
      const expired = t.until !== Infinity && clock > t.until;
      if (expired) {
        t.el.classList.remove("show");
        if (clock > t.until + 0.8) {
          t.el.remove();
          tags.delete(key);
          continue;
        }
      }
      t.worldFn(tmp2);
      const depth = -tmp.copy(tmp2).applyMatrix4(camera.matrixWorldInverse).z;
      const pxPerUnit = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.max(depth, 0.1));
      const gap = t.r * pxPerUnit + 16;
      const half = (t.w ??= t.el.offsetWidth) / 2;
      const offY = t.slot === "above" ? -gap : t.slot === "below" ? gap : 0;
      const offX = t.slot === "right" ? gap + half : t.slot === "left" ? -gap - half : 0;
      tmp2.project(camera);
      // In the hero view a label over the copy would fight with it: hide it there.
      const overCopy = explore < 0.5 && Math.abs(tmp2.x - calm.x) < calm.z + 0.04 && Math.abs(tmp2.y - calm.y) < calm.w + 0.06;
      t.el.classList.toggle("muted", overCopy || tmp2.z > 1);
      const x = Math.min(width - half - 14, Math.max(half + 14, (tmp2.x * 0.5 + 0.5) * width + offX));
      const y = Math.min(height - 16, Math.max(16, (-tmp2.y * 0.5 + 0.5) * height + offY));
      t.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
    }
  }

  // Name tags carry the firm's current state, like a character with a live verb.
  for (const f of firms) {
    tag(`name-${f.index}`, "", "name show", (o) => o.copy(f.anchor), Infinity, "below", 2.3);
    const el = tags.get(`name-${f.index}`).el;
    el.innerHTML = "<b></b><span></span>";
    el.firstChild.textContent = f.name;
  }
  function status(f, text) {
    const el = tags.get(`name-${f.index}`)?.el;
    if (el?.lastChild) el.lastChild.textContent = text;
  }
  for (const f of firms) status(f, "idle");

  // ------------------------------------------------------------------ story actions

  const firmById = (name) => firms.find((f) => f.name === name);

  function log(text, kind = "") {
    onEvent?.({ text, kind });
  }

  function beam(fromFirm, to, kind) {
    const b = { from: fromFirm, to, kind, state: "sealed", born: clock, fade: 0, color: firms[fromFirm].tint.clone() };
    beams.push(b);
    return b;
  }

  function endpoints(b, a, c, e) {
    a.copy(firms[b.from].anchor);
    if (b.to === "job") e.copy(job.pos);
    else e.copy(firms[b.to].anchor);
    c.copy(a).lerp(e, 0.5);
    c.y += a.distanceTo(e) * 0.08 + 0.6;
  }

  function sparkFlow(a, b, count, color, { size = 1, spread = 0.6, dur = 1.6, lift = 0.25 } = {}) {
    for (let i = 0; i < count; i++) {
      const c = a.clone().lerp(b, 0.5);
      c.y += a.distanceTo(b) * lift + (Math.random() - 0.3) * spread * 3;
      c.x += (Math.random() - 0.5) * spread * 3;
      sparks.push({ a: a.clone(), c, b: b.clone(), t: 0, dur: dur * (0.75 + Math.random() * 0.5), delay: Math.random() * 0.6, born: clock, color: color.clone(), size: size * (0.6 + Math.random() * 0.7) });
    }
  }

  function sparkRise(from, count, color, { height = 7, spread = 2.2, dur = 2.4, delay = 0 } = {}) {
    for (let i = 0; i < count; i++) {
      const a = from.clone();
      const b = from.clone().add(new THREE.Vector3((Math.random() - 0.5) * spread * 2, height * (0.6 + Math.random() * 0.6), (Math.random() - 0.5) * spread));
      const c = a.clone().lerp(b, 0.4).add(new THREE.Vector3((Math.random() - 0.5) * spread, 0, 0));
      sparks.push({ a, c, b, t: 0, dur: dur * (0.7 + Math.random() * 0.6), delay: delay + Math.random() * 0.8, born: clock, color: color.clone(), size: 0.7 + Math.random() * 0.6, fadeOut: true });
    }
  }

  const ACTIONS = {
    reset() {
      onPhase?.(-1);
      beams.length = 0;
      sparks.length = 0;
      for (const f of firms) {
        f.mode = "idle";
        f.hollow = false;
        f.energy = 1;
        f.owner = null;
        f.pulse = 0;
        f.target.copy(f.baseTint);
      }
      job.target = 0;
      for (const key of [...tags.keys()]) if (!key.startsWith("name-")) dropTag(key);
      for (const f of firms) status(f, "idle");
    },
    job({ id, budget, brief }) {
      job.target = 1;
      job.born = clock;
      job.flash = 0;
      onPhase?.(0);
      tag("job", `JOB #${id} · ${budget} USDC`, "win show", (o) => o.copy(job.pos), 5, "right", 1.6);
      log(`<b>job #${id}</b> · ${budget} USDC · ${brief}`);
    },
    commit({ firm, target }) {
      const f = firmById(firm);
      beam(f.index, target === undefined ? "job" : firmById(target).index, "bid");
      onPhase?.(target === undefined ? 1 : 5);
      status(f, target === undefined ? "sealed bid" : `sealed bid for ${target}`);
      f.pulse = 1;
      f.pulseColor.set("#ffffff");
      log(`${firm} · <b>sealed bid</b>`);
    },
    reveal({ firm, price }) {
      const f = firmById(firm);
      const b = beams.find((x) => x.from === f.index && x.state === "sealed");
      if (b) b.state = "revealed";
      if (b?.to === "job") onPhase?.(2);
      status(f, `bid ${price}`);
      tag(`price-${f.index}`, price, "price show", (o) => o.copy(f.anchor), 6, f.priceSlot ?? "above", 2.3);
      log(`${firm} reveals <b>${price}</b>`);
    },
    win({ firm, price, label }) {
      const f = firmById(firm);
      for (const b of beams) {
        if (b.state === "revealed" || b.state === "sealed") b.state = b.from === f.index ? "win" : "lose";
      }
      f.pulse = 1;
      f.pulseColor.copy(f.tint);
      status(f, `won at ${price}`);
      const at = beams.find((x) => x.from === f.index && x.state === "win");
      const where = at && at.to !== "job" ? firms[at.to].anchor : job.pos;
      tag("toast", label ?? `2ND PRICE ${price}`, "win show", (o) => o.copy(where), 3.2, at && at.to !== "job" ? "above" : "right", at && at.to !== "job" ? 2.3 : 1.6);
      log(`<b>${firm}</b> wins at the 2nd price ${price}`);
    },
    work({ firm, empty }) {
      const f = firmById(firm);
      f.mode = "rush";
      f.hollow = !!empty;
      status(f, empty ? "delivering nothing" : "working");
      log(empty ? `${firm} delivers <b>nothing</b>` : `${firm} delivers the work`);
    },
    verdict({ firm, accept }) {
      const f = firmById(firm);
      job.flash = 1;
      job.flashColor.set(accept ? "#ffffff" : "#ff5a5a");
      onPhase?.(accept ? 3 : 4);
      status(f, accept ? "paid" : "rejected");
      if (accept) {
        log(`judge · <b>accepted</b>`);
      } else {
        log(`judge · <b>rejected</b>`, "bad");
      }
      f.mode = accept ? "idle" : "scatter";
      for (const b of beams) if (b.state === "win") b.state = "lose";
    },
    pay({ firm, price, firmShare, dividends }) {
      const f = firmById(firm);
      const n = isMobile ? 40 : 90;
      sparkFlow(job.pos, f.anchor, Math.round(n * 0.7), hex("#f6d7a7"), { dur: 1.7, lift: 0.04 });
      sparkFlow(job.pos, tmp2.copy(f.anchor).add(tmp.set(0, 4.2, 0)), Math.round(n * 0.3), hex("#ffe9c4"), { dur: 1.9, lift: 0.04, size: 1.3 });
      sparkRise(f.anchor, isMobile ? 30 : 70, hex("#ffe9c4"), { height: 9, delay: 1.2 });
      tag("toast", `+${dividends} TO SHAREHOLDERS`, "good show", (o) => o.copy(f.anchor), 3.6, "above", 2.3);
      log(`paid ${price} · <b>${dividends} to shareholders</b>`);
    },
    slash({ firm, bond }) {
      const f = firmById(firm);
      f.pulse = 1;
      f.pulseColor.set("#ff5a5a");
      f.energy = 0.55;
      status(f, `bond −${bond}`);
      sparkFlow(f.anchor, job.pos, isMobile ? 24 : 50, hex("#ff7a7a"), { dur: 1.5, lift: 0.04 });
      tag("toast", `−${bond} BOND SLASHED`, "bad show", (o) => o.copy(f.anchor), 3.6, "above", 2.3);
      log(`owner bond <b>−${bond}</b> to the client`, "bad");
    },
    jobEnd() {
      job.target = 0;
      for (const f of firms) {
        if (f.mode === "rush") f.mode = "idle";
        if (f.energy === 1) status(f, "idle");
      }
      for (const b of beams) b.state = "lose";
    },
    epoch({ firm, n, liquidating }) {
      const f = firmById(firm);
      f.energy = liquidating ? 0.22 : 0.4;
      f.mode = "idle";
      f.pulse = 1;
      f.pulseColor.set(liquidating ? "#ff5a5a" : "#f6b37a");
      if (liquidating) onPhase?.(5);
      status(f, liquidating ? "liquidating" : `under the floor ${n}/2`);
      tag("toast", liquidating ? "LIQUIDATING" : `UNDER THE FLOOR ${n}/2`, "bad show", (o) => o.copy(f.anchor), 2.6, "above", 2.3);
      log(liquidating ? `${firm} · <b>liquidating</b>` : `${firm} under the floor ${n}/2`, "bad");
    },
    takeover({ buyer, target, price, fee, holders }) {
      const b = firmById(buyer);
      const t = firmById(target);
      for (const x of beams) if (x.state === "revealed" || x.state === "sealed") x.state = x.from === b.index ? "win" : "lose";
      t.owner = b.index;
      onPhase?.(6);
      status(t, `owned by ${buyer}`);
      status(b, `bought ${target}`);
      t.target.copy(b.baseTint);
      t.energy = 0.9;
      t.pulse = 1;
      t.pulseColor.copy(b.baseTint);
      sparkRise(t.anchor, isMobile ? 26 : 60, hex("#ffe9c4"), { height: 8 });
      tag("toast", `BOUGHT BY ${buyer.toUpperCase()} · ${price}`, "win show", (o) => o.copy(t.anchor), 4, "above", 2.3);
      log(`<b>${buyer}</b> buys ${target} · ${price}`);
      log(`fee ${fee} · old shareholders <b>+${holders}</b>`);
    },
    keys({ target }) {
      for (const b of beams) b.state = "lose";
      log(`${target} · old agent keys deleted`);
    },
    budget({ firm, spend, budget }) {
      const f = firmById(firm);
      f.pulse = 1;
      f.pulseColor.set("#ff5a5a");
      status(f, "spend refused");
      tag("toast", `${spend} > ${budget} BUDGET · REFUSED`, "bad show", (o) => o.copy(f.anchor), 3, "above", 2.3);
      log(`spend ${spend} on a ${budget} budget · <b>refused</b>`, "bad");
    },
    done() {
      log(`<b>21/21</b> checks pass · replay restarts`);
    },
  };

  let storyIndex = 0;
  let storyClock = 0;
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

  const c3 = new THREE.Color();
  const white = hex("#ffffff");
  const ringGround = new THREE.Vector3();

  function simulate(dt) {
    // Job orb follows its anchor, condenses and dissolves.
    job.on += (job.target - job.on) * Math.min(1, dt * 1.4);
    job.flash = Math.max(0, job.flash - dt * 0.9);
    job.pos.copy(job.anchor);
    job.pos.y += Math.sin(clock * 0.8) * 0.25;

    for (const f of firms) {
      f.tint.lerp(f.target, Math.min(1, dt * 0.9));
      f.pulse = Math.max(0, f.pulse - dt * 0.8);
    }

    const k = 7.5;
    const damp = 3.6;
    for (const a of agents) {
      const f = firms[a.firm];
      const ang = a.phase + clock * a.speed;
      let tx, ty, tz;
      if (f.mode === "rush" && job.on > 0.3) {
        const r = 1.1 + a.r * 0.6;
        const ang2 = a.phase + clock * a.speed * 3.2;
        tx = job.pos.x + Math.cos(ang2) * r;
        ty = job.pos.y + Math.sin(ang2 * 1.3 + a.tilt) * r * 0.7;
        tz = job.pos.z + Math.sin(ang2) * r;
      } else {
        // A point on a tilted ring: rotate (cos, wobble, sin) by the ring's tilt around x then z.
        const spread = f.mode === "scatter" ? 2.2 : 1;
        const breathe = 1 + 0.06 * Math.sin(clock * 0.9 + a.phase * 3);
        const r = a.r * breathe * spread * (0.75 + 0.25 * f.energy);
        const cx = Math.cos(ang) * r;
        const cy = Math.sin(ang * 3 + a.phase) * a.wob * r;
        const cz = Math.sin(ang) * r;
        const sx = Math.sin(a.ring.rx);
        const cxr = Math.cos(a.ring.rx);
        const y1 = cy * cxr - cz * sx;
        const z1 = cy * sx + cz * cxr;
        const sz = Math.sin(a.ring.rz);
        const czr = Math.cos(a.ring.rz);
        tx = f.anchor.x + cx * czr - y1 * sz;
        ty = f.anchor.y + cx * sz + y1 * czr - (f.mode === "scatter" ? 0.9 : 0);
        tz = f.anchor.z + z1;
      }
      // Critically damped spring towards the target, with a little per-agent lag.
      const kk = k * (0.55 + a.lag * 0.9);
      a.v.x += ((tx - a.p.x) * kk - a.v.x * damp) * dt;
      a.v.y += ((ty - a.p.y) * kk - a.v.y * damp) * dt;
      a.v.z += ((tz - a.p.z) * kk - a.v.z * damp) * dt;
      a.p.addScaledVector(a.v, dt);
      let prev = a.p;
      for (const t of a.trail) {
        t.lerp(prev, Math.min(1, dt * 9));
        prev = t;
      }
    }

    for (const b of beams) {
      if (b.state === "lose") b.fade = Math.min(1, b.fade + dt * 1.2);
    }
    for (let i = beams.length - 1; i >= 0; i--) if (beams[i].fade >= 1) beams.splice(i, 1);
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      if (clock - s.born < s.delay) continue;
      s.t += dt / s.dur;
      if (s.t >= 1) sparks.splice(i, 1);
    }
  }

  // ------------------------------------------------------------------ draw

  const A = new THREE.Vector3();
  const C = new THREE.Vector3();
  const E = new THREE.Vector3();
  const P = new THREE.Vector3();

  function draw() {
    // Agents with two trail dots each.
    agentsCloud.begin();
    for (const a of agents) {
      const f = firms[a.firm];
      const alpha = (f.hollow && f.mode === "rush" ? 0.28 : 0.9) * (0.35 + 0.65 * f.energy);
      c3.copy(f.tint).lerp(white, 0.3);
      agentsCloud.push(a.p.x, a.p.y, a.p.z, c3, a.size, alpha);
      for (let i = 0; i < TRAIL; i++) {
        const t = a.trail[i];
        const k = 1 - (i + 1) / (TRAIL + 1);
        agentsCloud.push(t.x, t.y, t.z, f.tint, a.size * (0.55 + 0.35 * k), alpha * 0.5 * k);
      }
    }
    agentsCloud.end();

    decoCloud.begin();
    for (const f of firms) {
      // Ground ring (dotted, rotating) and a stem from the ground to the core.
      ringGround.set(f.anchor.x, duneHeight(f.anchor.x, f.anchor.z) + 0.05, f.anchor.z);
      const ringR = 2.1 + f.pulse * 1.6;
      const dots = 40;
      for (let i = 0; i < dots; i++) {
        const ang = (i / dots) * TAU + clock * 0.15 * (f.index % 2 ? 1 : -1);
        const gap = i % 10 < 8 ? 1 : 0;
        const a = (0.2 + 0.5 * f.pulse) * gap * (0.4 + 0.6 * f.energy);
        c3.copy(f.tint).lerp(f.pulseColor, f.pulse);
        decoCloud.push(ringGround.x + Math.cos(ang) * ringR, ringGround.y, ringGround.z + Math.sin(ang) * ringR, c3, 1.0, a);
      }
      const stemTop = f.anchor.y - 0.6;
      for (let i = 0; i < 9; i++) {
        const y = lerp(ringGround.y, stemTop, i / 8);
        decoCloud.push(f.anchor.x, y, f.anchor.z, f.tint, 0.8, 0.1 + 0.08 * f.energy);
      }
      // Ownership tether after a takeover.
      if (f.owner !== null) {
        const o = firms[f.owner];
        C.copy(f.anchor).lerp(o.anchor, 0.5);
        C.y += f.anchor.distanceTo(o.anchor) * 0.12 + 1;
        for (let i = 0; i <= 36; i++) {
          bezier(P, f.anchor, C, o.anchor, i / 36);
          const a = 0.22 + 0.25 * Math.max(0, Math.sin(i * 0.5 - clock * 3));
          decoCloud.push(P.x, P.y, P.z, o.baseTint, 1.2, a);
        }
      }
    }

    // Bid beams: dotted arcs; sealed beams flicker, revealed ones hold, the winner's carries a bright head.
    for (const b of beams) {
      endpoints(b, A, C, E);
      const age = clock - b.born;
      const grow = clamp01(age / 0.9);
      const dots = isMobile ? 70 : 120;
      const fade = 1 - b.fade;
      for (let i = 0; i <= dots; i++) {
        const t = (i / dots) * grow;
        bezier(P, A, C, E, t);
        // Marching dashes travel from the firm to the job.
        const dash = Math.sin(t * 60 - clock * 7) > -0.2 ? 1 : 0.25;
        let a;
        let size = 1.5;
        if (b.state === "sealed") a = 0.42 * dash * (0.6 + 0.4 * Math.sin(i * 1.7 + clock * 11));
        else if (b.state === "revealed") a = 0.72 * dash;
        else if (b.state === "win") {
          a = 0.65 + 0.35 * Math.exp(-Math.pow((t - ((clock * 0.6) % 1)) * 7, 2));
          size = 2.0;
        } else a = 0.4 * dash;
        c3.copy(b.color).lerp(white, b.state === "win" ? 0.35 : 0.08);
        decoCloud.push(P.x, P.y, P.z, c3, size, a * fade);
      }
    }

    // Job: a rotating shell of dots, condensing out of the data sky, with radar rings.
    if (job.on > 0.01) {
      const n = isMobile ? 70 : 140;
      const spin = clock * 0.6;
      c3.copy(white).lerp(job.flashColor, job.flash);
      for (let i = 0; i < n; i++) {
        const y = 1 - (i / (n - 1)) * 2;
        const rr = Math.sqrt(1 - y * y);
        const th = i * 2.399963 + spin;
        const r = 1.25 * (1 + (1 - job.on) * 6) + job.flash * 0.7;
        decoCloud.push(job.pos.x + Math.cos(th) * rr * r, job.pos.y + y * r, job.pos.z + Math.sin(th) * rr * r, c3, 1.3, 0.8 * job.on);
      }
      for (let k = 0; k < 2; k++) {
        const ph = ((clock * 0.35 + k * 0.5) % 1);
        const r = 1.6 + ph * 5;
        for (let i = 0; i < 48; i++) {
          const th = (i / 48) * TAU;
          decoCloud.push(job.pos.x + Math.cos(th) * r, job.pos.y + Math.sin(th) * r * 0.35, job.pos.z + Math.sin(th) * r, c3, 1.2, 0.3 * (1 - ph) * job.on);
        }
      }
    }

    // Sparks: payments, dividends, slashes.
    for (const s of sparks) {
      if (clock - s.born < s.delay) continue;
      const t = easeInOut(clamp01(s.t));
      bezier(P, s.a, s.c, s.b, t);
      const a = s.fadeOut ? (1 - s.t) * Math.min(1, s.t * 6) : Math.min(1, s.t * 6) * Math.min(1, (1 - s.t) * 5);
      decoCloud.push(P.x, P.y, P.z, s.color, s.size * 1.5, a * 0.95);
    }
    decoCloud.end();

    // Firm cores and the job core: large soft glows (a bloom without postprocessing).
    glowCloud.begin();
    for (const f of firms) {
      c3.copy(f.tint).lerp(f.pulseColor, f.pulse * 0.8);
      glowCloud.push(f.anchor.x, f.anchor.y, f.anchor.z, c3, 9 + f.pulse * 9, (0.16 + 0.22 * f.pulse) * f.energy);
      glowCloud.push(f.anchor.x, f.anchor.y, f.anchor.z, white, 1.3, 0.95 * Math.max(0.3, f.energy));
    }
    if (job.on > 0.01) {
      c3.copy(white).lerp(job.flashColor, job.flash);
      glowCloud.push(job.pos.x, job.pos.y, job.pos.z, c3, 14 + job.flash * 18, (0.22 + 0.5 * job.flash) * job.on);
      glowCloud.push(job.pos.x, job.pos.y, job.pos.z, white, 1.8, job.on);
    }
    glowCloud.end();
  }

  // ------------------------------------------------------------------ camera

  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

  function onPointer(e) {
    const r = canvas.getBoundingClientRect();
    pointer.tx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1));
    pointer.ty = Math.max(-1, Math.min(1, ((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1));
  }
  window.addEventListener("pointermove", onPointer, { passive: true });

  function updateCamera(dt) {
    pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 2.2);
    pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 2.2);
    explore += (exploreTarget - explore) * Math.min(1, dt * 1.6);
    const ndcY = 1 - 2 * HORIZON;
    const basePitch = Math.atan(ndcY * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    camera.position.set(BASE.x + Math.sin(clock * 0.07) * 0.6, BASE.y, BASE.z);
    placeAnchors();
    camera.rotation.y = -pointer.x * 0.035 + Math.sin(clock * 0.05) * 0.012;
    camera.rotation.x = -basePitch - pointer.y * 0.018;
    camera.updateMatrixWorld();
  }

  // ------------------------------------------------------------------ loop

  let raf = 0;
  let last = performance.now();
  let slowFrames = 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    let dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    // Adaptive quality: drop the pixel ratio if frames stay slow.
    if (dt > 0.028) slowFrames++;
    else slowFrames = Math.max(0, slowFrames - 1);
    if (slowFrames > 90 && pixelRatio > 1) {
      pixelRatio = Math.max(1, pixelRatio - 0.5);
      slowFrames = 0;
      layout();
    }
    step(dt);
  }

  function step(dt) {
    clock += dt;
    if (mode === "replay") runStory(dt);
    updateCamera(dt);
    simulate(dt);
    draw();
    skyUniforms.uTime.value = clock;
    duneUniforms.uTime.value = clock;
    terrainUniforms.uTime.value = clock;
    shared.uCalmStrength.value = calmStrength * (1 - explore);
    const showSwarm = swarmInHero || explore > 0.02;
    for (const c of [decoCloud, agentsCloud, glowCloud]) c.points.visible = showSwarm;
    tagsLayer.style.visibility = showSwarm ? "" : "hidden";
    updateTags();
    renderer.render(scene, camera);
  }

  let pausedByUser = false;
  function onVisibility() {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf && !reducedMotion && !pausedByUser) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }
  document.addEventListener("visibilitychange", onVisibility);

  layout();
  // Settle the swarm before the first visible frame.
  for (const a of agents) {
    a.p.copy(firms[a.firm].anchor);
    for (const t of a.trail) t.copy(a.p);
  }
  for (let i = 0; i < 90; i++) {
    clock += 1 / 60;
    simulate(1 / 60);
  }
  // QA helpers: ?t=12 jumps to second 12 of the replay, &still renders one frame and stops.
  const query = new URLSearchParams(debugQuery ? location.search : "");
  if (query.has("still")) reducedMotion = true;
  if (query.has("debug")) window.__tontine = { beams, sparks, firms, job, decoCloud, agentsCloud, camera, get clock() { return clock; } };
  const forward = Number(query.get("t"));
  if (forward > 0) {
    for (let i = 0; i < forward * 30; i++) {
      clock += 1 / 30;
      runStory(1 / 30);
      updateCamera(1 / 30);
      simulate(1 / 30);
    }
  }
  if (query.has("still")) {
    step(0);
  } else if (reducedMotion) {
    skyUniforms.uRain.value = 0.6;
    step(0);
  } else {
    raf = requestAnimationFrame(frame);
  }

  return {
    resize() {
      layout();
      if (reducedMotion) step(0);
    },
    /** Live mode: play one story step ({ do: "commit", firm: "Cost Plus Ltd" }, ...). */
    act(storyStep) {
      ACTIONS[storyStep.do]?.(storyStep);
      if (reducedMotion) step(0);
    },
    setCalmRect(rect) {
      setCalmRect(rect);
      if (reducedMotion) step(0);
    },
    setHorizon(fraction) {
      if (!(fraction > 0.12 && fraction < 0.7) || Math.abs(fraction - HORIZON) < 0.004) return;
      HORIZON = fraction; // only the camera pitch changes: the ground geometry stays
      layout();
      if (reducedMotion) step(0);
    },
    setPaused(paused) {
      if (paused) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (!raf && !reducedMotion) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
      pausedByUser = paused;
    },
    setExplore(on) {
      exploreTarget = on ? 1 : 0;
      if (reducedMotion) {
        explore = exploreTarget;
        step(0);
      }
    },
    dispose() {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onPointer);
      for (const t of tags.values()) t.el.remove();
      renderer.dispose();
    },
  };
}
