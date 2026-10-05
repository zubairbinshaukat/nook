// Nook's stage wallpaper: bundles of thin silk ribbons sweeping up from the lower left,
// twisting as they go, lit by a soft key light and a coloured rim light. Every ribbon is
// a ruled surface (a centre curve, a width and a twist angle along x) drawn back to front
// in one fragment shader: each one shades itself (satin highlight, back face in another
// hue, bright cut edge) and casts a soft shadow on what lies behind it. Deterministic:
// the same theme and seed give the same pixels on the same renderer.
//
// The page sets `window.__wallpaper = { done, jpeg(q) }` for scripts/make-wallpaper.mjs.

const q = new URLSearchParams(location.search);
const THEME = q.get("theme") === "light" ? "light" : "dark";
const SEED = Number.isFinite(Number(q.get("seed"))) && q.get("seed") !== null ? Math.trunc(Number(q.get("seed"))) : 1;
const W = Math.min(8192, Math.max(200, Number(q.get("w")) || 3840));
const H = Math.min(8192, Math.max(200, Number(q.get("h")) || 2400));
if (q.get("fit") === "1") document.body.classList.add("fit");

/** mulberry32, as the stage's rng. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(0x6e6f6f6b ^ (SEED * 2654435761));
const jit = (amount) => (SEED === 1 ? 0 : (rand() - 0.5) * 2 * amount);

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

// ── Palette ─────────────────────────────────────────────────────────────────
// Nook's accents: mint #3ddc97, blue #5aa9ff, violet #a98bfa, amber #ffb547.
const PAL = {
  dark: {
    bg: hex("#06080b"), glow: hex("#142352"), glow2: hex("#251a52"), glowMint: hex("#0b3134"),
    ambient: 0.06, key: 1.05, rim: hex("#a98bfa"), rimAmt: 0.9, spec: 0.85, fog: 0.5, shadow: 0.78, exposure: 1.15,
  },
  light: {
    bg: hex("#d6d3ec"), glow: hex("#f5f3fd"), glow2: hex("#d8cdf5"), glowMint: hex("#cfe6f3"),
    ambient: 0.55, key: 0.7, rim: hex("#ffffff"), rimAmt: 0.6, spec: 0.6, fog: 0.22, shadow: 0.4, exposure: 1.0,
  },
}[THEME];

// Ribbon colours: front at the start of the sweep, front at its end, back face.
const COL = {
  dark: {
    main: [hex("#0f8c9c"), hex("#2a50e0"), hex("#6236d0")],
    mint: [hex("#1fb884"), hex("#1f86c8"), hex("#2457d0")],
    violet: [hex("#6a48e8"), hex("#a07cff"), hex("#3434b8")],
  },
  light: {
    main: [hex("#3cc6dc"), hex("#5b8dff"), hex("#9b7cf7")],
    mint: [hex("#5fe3b0"), hex("#63b6ff"), hex("#6d8cf5")],
    violet: [hex("#ad92ff"), hex("#c6b0ff"), hex("#8a92f7")],
  },
}[THEME];

// ── The ribbons, back to front ──────────────────────────────────────────────
// Centre: y = c0 + c1·x + a1·sin(f1·x + p1) + a2·sin(f2·x + p2)   (x, y in units of the height, y up)
// Half width: w·(1 + wv·sin(fw·x + pw));  twist angle: t0 + t1·x + ta·sin(ft·x + pt)
const ribbons = [];
function bundle(base, n, step, colours, opts = {}) {
  const j = { p1: jit(0.25), p2: jit(0.25), pt: jit(0.3), c0: jit(0.02) };
  let c = 0;
  for (let k = 0; k < n; k++) {
    const f = n > 1 ? k / (n - 1) : 0;
    // Irregular spacing between the sheets: a stack, not a set of stripes.
    if (k) c += step.dc * (1 + 0.55 * Math.sin(k * 2.3 + 0.7));
    ribbons.push({
      c0: base.c0 + j.c0 - c, c1: base.c1 + k * (step.dc1 ?? 0),
      a1: base.a1 * (1 + k * (step.da ?? 0)), f1: base.f1, p1: base.p1 + j.p1 + k * (step.dp ?? 0),
      a2: base.a2, f2: base.f2, p2: base.p2 + j.p2 + k * (step.dp2 ?? 0),
      w: base.w * (1 - k * (step.dw ?? 0)), wv: base.wv ?? 0.15, fw: base.fw ?? 1.7, pw: (base.pw ?? 0) + k * 0.2,
      t0: base.t0 + k * (step.dt ?? 0), t1: base.t1, ta: base.ta, ft: base.ft, pt: base.pt + j.pt + k * (step.dpt ?? 0),
      curl: base.curl ?? 0.6, depth: (opts.depth ?? 0) + f * (opts.depthSpan ?? 0),
      amber: opts.amber && k === n - 1 ? 1 : 0, halo: k === n - 1 ? opts.halo ?? 1 : 0, soft: opts.soft ?? 0,
      cols: colours, hue: f,
    });
  }
}

// A mint bundle far behind and a little higher, out of focus: the depth behind the hero.
bundle(
  { c0: 0.33, c1: 0.1, a1: 0.27, f1: 1.75, p1: -0.35, a2: 0.02, f2: 3.6, p2: 0.4, w: 0.075, wv: 0.3, t0: 1.0, t1: -1.3, ta: 0.4, ft: 2.3, pt: 0.6, curl: 1.3 },
  3, { dc: 0.02, dp: 0.07, dt: 0.16, dpt: 0.2 }, COL.mint, { depth: 0.55, depthSpan: -0.1, soft: 0.006 },
);
// The main bundle: wide sheets, stacked, rising in one arc from the lower left to a crest right
// of centre, pinching edge-on and flipping to their violet back as they twist away.
bundle(
  { c0: 0.17, c1: 0.12, a1: 0.3, f1: 1.6, p1: -0.4, a2: 0.025, f2: 4.1, p2: 1.9, w: 0.16, wv: 0.22, fw: 2.0, pw: 0.6, t0: -0.7, t1: 1.75, ta: 0.25, ft: 2.0, pt: 0.9, curl: 1.6 },
  7, { dc: 0.018, dp: 0.06, dt: 0.12, dpt: 0.14, dw: 0.045, da: 0.03 }, COL.main, { depth: 0.3, depthSpan: -0.3 },
);
// A narrow violet ribbon in front, lower, with the one warm (amber) edge.
bundle(
  { c0: 0.03, c1: 0.1, a1: 0.22, f1: 1.6, p1: -0.6, a2: 0.018, f2: 4.6, p2: 0.3, w: 0.05, wv: 0.3, t0: 0.5, t1: 1.0, ta: 0.6, ft: 2.8, pt: 2.2, curl: 1.0 },
  3, { dc: 0.01, dp: 0.07, dt: 0.15, dpt: 0.18 }, COL.violet, { depth: 0.0, depthSpan: 0, amber: true },
);

const N = ribbons.length;

// ── Shader ───────────────────────────────────────────────────────────────────
const VS = `attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;

const FS = `
precision highp float;
#define MAXR 16
uniform vec2 uRes;
uniform int uN;
uniform vec4 uA[MAXR]; // c0 c1 a1 f1
uniform vec4 uB[MAXR]; // p1 a2 f2 p2
uniform vec4 uC[MAXR]; // w wv fw pw
uniform vec4 uD[MAXR]; // t0 t1 ta ft
uniform vec4 uE[MAXR]; // pt curl depth amber
uniform vec4 uF[MAXR]; // front colour (start), hue offset
uniform vec3 uG[MAXR]; // front colour (end)
uniform vec3 uK[MAXR]; // back colour
uniform vec2 uX[MAXR];  // halo, edge softness (depth of field)
uniform vec3 uBg, uGlow, uGlow2, uGlowMint, uRim;
uniform vec4 uLight;   // ambient key rimAmt spec
uniform vec4 uMisc;    // fog shadow exposure light(0/1)

vec3 lin(vec3 c){ return pow(c, vec3(2.2)); }
float hash(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }

vec3 background(vec2 p, float A){
  vec3 c = lin(uBg);
  float light = uMisc.w;
  // The main glow sits behind the sweep, right of centre and below the middle: the top stays calm.
  float g1 = exp(-pow(length((p - vec2(A * 0.68, 0.45)) * vec2(0.8, 1.0)) / 0.55, 2.0));
  float g2 = exp(-pow(length((p - vec2(A * 0.95, 0.12)) * vec2(0.9, 1.0)) / 0.55, 2.0));
  float g3 = exp(-pow(length((p - vec2(A * 0.18, 0.08)) * vec2(0.9, 1.0)) / 0.45, 2.0));
  c = mix(c, lin(uGlow), g1 * (light > 0.5 ? 0.9 : 0.95));
  c = mix(c, lin(uGlow2), g2 * 0.55);
  c = mix(c, lin(uGlowMint), g3 * 0.45);
  if (light > 0.5) {
    // A cool, slightly brighter sky at the top.
    c = mix(c, lin(vec3(0.89, 0.905, 0.965)), smoothstep(0.5, 1.0, p.y) * 0.7);
  } else {
    // The top falls off to near black: calm under the island and the icons.
    c *= mix(1.0, 0.45, smoothstep(0.45, 1.0, p.y));
  }
  // Vignette
  vec2 q = (p - vec2(A * 0.5, 0.5)) / vec2(A * 0.5, 0.5);
  float v = smoothstep(0.55, 1.6, length(q * vec2(0.85, 1.0)));
  c *= 1.0 - v * (light > 0.5 ? vec3(0.2, 0.17, 0.08) : vec3(0.55));
  return c;
}

void main(){
  vec2 fc = gl_FragCoord.xy;
  float A = uRes.x / uRes.y;
  vec2 p = fc / uRes.y;
  float px = 1.0 / uRes.y;
  float light = uMisc.w;

  vec3 col = background(p, A);
  vec3 fogCol = col;
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 L = normalize(vec3(-0.45, 0.65, 0.62));   // key: upper left, in front
  vec3 L2 = normalize(vec3(0.75, 0.15, -0.35));  // rim: right, behind
  vec3 Hk = normalize(L + V);

  for (int i = 0; i < MAXR; i++) {
    if (i >= uN) break;
    vec4 a = uA[i]; vec4 b = uB[i]; vec4 cc = uC[i]; vec4 d4 = uD[i]; vec4 e = uE[i];
    float x = p.x;
    float yc = a.x + a.y * x + a.z * sin(a.w * x + b.x) + b.y * sin(b.z * x + b.w);
    float dy = a.y + a.z * a.w * cos(a.w * x + b.x) + b.y * b.z * cos(b.z * x + b.w);
    float w = cc.x * (1.0 + cc.y * sin(cc.z * x + cc.w));
    float th = d4.x + d4.y * x + d4.z * sin(d4.w * x + e.x);
    float dth = d4.y + d4.z * d4.w * cos(d4.w * x + e.x);

    float sl = inversesqrt(1.0 + dy * dy);
    vec2 tan2 = vec2(1.0, dy) * sl;
    vec2 perp = vec2(-dy, 1.0) * sl;
    float dist = (p.y - yc) * sl;                 // signed distance across the ribbon
    float ct = cos(th), st = sin(th);
    float thick = 0.0016;
    float wp = w * abs(ct) + thick;               // projected half width

    // Shadow and contact darkening on what lies behind (before this ribbon covers it).
    vec2 off = vec2(0.018, -0.026);               // the key light comes from the upper left
    float dS = abs(dist - dot(off, perp)) - wp;
    float sh = 1.0 - smoothstep(-0.01, 0.075, dS);
    float ao = exp(-max(abs(dist) - wp, 0.0) / 0.012);
    float shade = clamp(sh * 0.65 + ao * 0.45, 0.0, 1.0) * uMisc.y;
    vec3 shTint = light > 0.5 ? vec3(0.80, 0.80, 0.93) : vec3(0.35, 0.38, 0.55);
    col *= mix(vec3(1.0), shTint * (light > 0.5 ? 1.0 : 0.6), shade);

    // Colour along the sweep, and the back face in its own hue (blended through the edge-on pinch).
    float t = clamp(x / A * 1.1 - 0.05 + uF[i].w * 0.08, 0.0, 1.0);
    vec3 alb = mix(lin(uF[i].rgb), lin(uG[i]), smoothstep(0.0, 1.0, t));
    alb = mix(alb, lin(uK[i]), 0.75 * smoothstep(0.2, -0.2, ct));

    // A faint luminous halo: the silk lights the air around it.
    float halo = exp(-max(abs(dist) - wp, 0.0) / 0.09) * uX[i].x;
    col += alb * halo * (light > 0.5 ? 0.0 : 0.045);

    float soft = max(px * 1.2, uX[i].y);
    float cover = smoothstep(soft, -soft, abs(dist) - wp);
    if (cover <= 0.0) continue;

    // Where on the real (unprojected) ribbon this pixel is: s in [-1, 1] across.
    float s = clamp(dist / max(w * abs(ct), 1e-4), -1.0, 1.0) * sign(ct);
    // The cross-section bows a little (silk is never flat): the angle drifts across the width.
    float thl = th + e.y * s * 0.9;
    vec3 across = vec3(perp * cos(thl), sin(thl));
    vec3 along = normalize(vec3(tan2, s * w * cos(th) * dth));
    vec3 N = normalize(cross(along, across));
    if (N.z < 0.0) N = -N;

    float ndl = dot(N, L);
    float diff = max(ndl * 0.8 + 0.2, 0.0);        // lightly wrapped: soft, like cloth
    diff = diff * diff;
    float amb = uLight.x;
    // Satin: an anisotropic (Ward) highlight stretched along the ribbon, plus a broad sheen.
    vec3 T = normalize(cross(across, N));
    vec3 B = normalize(cross(N, T));
    float hT = dot(Hk, T), hB = dot(Hk, B), hN = max(dot(Hk, N), 1e-3);
    float aniso = exp(-((hT * hT) / 0.25 + (hB * hB) / 0.006) / (hN * hN));
    float spec = pow(max(dot(N, Hk), 0.0), 90.0) * 0.5 + aniso * 0.75;
    float sheen = pow(max(dot(N, Hk), 0.0), 8.0) * 0.08;
    float fres = pow(1.0 - clamp(N.z, 0.0, 1.0), 3.0);
    float rim = pow(max(dot(N, L2), 0.0), 1.5) * (0.35 + 0.65 * fres);

    vec3 c = alb * (amb + uLight.y * diff);
    c += (spec * uLight.w + sheen) * mix(vec3(1.0), alb * 2.0 + 0.3, 0.35);
    c += lin(uRim) * rim * uLight.z * 0.55;
    c += alb * fres * 0.35;
    // The cut edge of the sheet catches the light.
    float edge = exp(-(wp - abs(dist)) / (0.0016 + soft)) * (0.35 + 0.65 * abs(st)) * (soft > 0.004 ? 0.3 : 1.0);
    float warm = e.w * step(0.0, dist) * exp(-pow((x - A * 0.78) / 0.16, 2.0)) * 0.7;  // one warm glint, not a wire
    vec3 edgeCol = mix(alb * 1.8 + 0.12, lin(vec3(1.0, 0.71, 0.28)) * 1.2, warm);
    c += edgeCol * edge * (light > 0.5 ? 0.45 : 0.6);

    // Self-shadow where the ribbon turns away, and depth haze for the ribbons further back.
    c *= mix(1.0, light > 0.5 ? 0.8 : 0.55, smoothstep(0.75, 0.0, abs(ct)) * 0.6);
    c = mix(c, fogCol, e.z * uMisc.x);

    col = mix(col, c, cover);
  }

  // Tone: exposure, a soft shoulder, sRGB.
  col *= uMisc.z;
  col = col / (1.0 + col * 0.18);
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  // Triangular dither: no banding in the long gradients.
  float n = hash(fc) + hash(fc + 37.13) - 1.0;
  col += n * (1.6 / 255.0);
  gl_FragColor = vec4(col, 1.0);
}
`;

// ── Render ───────────────────────────────────────────────────────────────────
const canvas = document.getElementById("c");
canvas.width = W;
canvas.height = H;
const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, antialias: false, alpha: false });
const state = { done: false, error: null };
window.__wallpaper = state;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

try {
  if (!gl) throw new Error("no WebGL");
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const u = (name) => gl.getUniformLocation(prog, name);
  const pack = (fn, size) => {
    const out = new Float32Array(16 * size);
    ribbons.forEach((r, i) => out.set(fn(r), i * size));
    return out;
  };
  gl.uniform2f(u("uRes"), W, H);
  gl.uniform1i(u("uN"), N);
  gl.uniform4fv(u("uA"), pack((r) => [r.c0, r.c1, r.a1, r.f1], 4));
  gl.uniform4fv(u("uB"), pack((r) => [r.p1, r.a2, r.f2, r.p2], 4));
  gl.uniform4fv(u("uC"), pack((r) => [r.w, r.wv, r.fw, r.pw], 4));
  gl.uniform4fv(u("uD"), pack((r) => [r.t0, r.t1, r.ta, r.ft], 4));
  gl.uniform4fv(u("uE"), pack((r) => [r.pt, r.curl, r.depth, r.amber], 4));
  gl.uniform4fv(u("uF"), pack((r) => [...r.cols[0], r.hue], 4));
  gl.uniform3fv(u("uG"), pack((r) => r.cols[1], 3));
  gl.uniform3fv(u("uK"), pack((r) => r.cols[2], 3));
  gl.uniform2fv(u("uX"), pack((r) => [r.halo, r.soft], 2));
  gl.uniform3fv(u("uBg"), PAL.bg);
  gl.uniform3fv(u("uGlow"), PAL.glow);
  gl.uniform3fv(u("uGlow2"), PAL.glow2);
  gl.uniform3fv(u("uGlowMint"), PAL.glowMint);
  gl.uniform3fv(u("uRim"), PAL.rim);
  gl.uniform4f(u("uLight"), PAL.ambient, PAL.key, PAL.rimAmt, PAL.spec);
  gl.uniform4f(u("uMisc"), PAL.fog, PAL.shadow, PAL.exposure, THEME === "light" ? 1 : 0);

  // In strips, so a software renderer never sits on one huge draw.
  gl.viewport(0, 0, W, H);
  gl.enable(gl.SCISSOR_TEST);
  const STRIP = 200;
  let y = 0;
  const step = () => {
    gl.scissor(0, y, W, Math.min(STRIP, H - y));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.finish();
    y += STRIP;
    if (y < H) setTimeout(step, 0);
    else state.done = true;
  };
  step();
} catch (e) {
  state.error = String(e && e.message ? e.message : e);
  state.done = true;
  console.error(state.error);
}

/** A JPEG of the canvas as a data URL (for make-wallpaper.mjs). */
state.jpeg = (quality) => canvas.toDataURL("image/jpeg", quality);
