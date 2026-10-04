// Draws the Nook bot's face into the PNG/ICO set Tauri needs. No dependencies:
// the icons are rasterised here and encoded with node:zlib, so the app icon
// stays "drawn in code" like the character itself.
//
//   node scripts/gen-icons.mjs

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

// ── The Nook bot ──────────────────────────────────────────────────────────────
// Nook Buddy's face, as src/bot/engine.ts draws it at rest: the cream gumdrop,
// two bead eyes, the cheeks and the smile, and the sprout on its head in the
// green of idle. Same proportions and colours; like the engine, a small icon
// is simplified rather than shrunk (no arms or toes, bigger eyes and sprout,
// no light in the eyes).

const SKIN_A = [255, 248, 238]; // #FFF8EE, the cream theme
const SKIN_B = [235, 211, 188]; // #EBD3BC
const SHADE = [120, 70, 40];
const INK = [43, 30, 26]; // #2B1E1A
const INK_LIGHT = [83, 57, 47]; // #53392F
const CHEEK = [255, 128, 150];
const GREEN = [143, 211, 160]; // #8FD3A0, the idle state
const STEM_GREEN = [70, 110, 80];
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const RIM = [0, 0, 0];
/** How bright the sprout is: the engine's glow level. */
const GLOW = 0.9;

const SS = 4; // supersampling factor

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Half the gumdrop's width at height `yc` from its widest line (the engine's bodyPoint, solved for x). */
function bodyHalfWidth(yc, rw, ht, hb) {
  if (yc < -ht || yc > hb) return -1;
  const s = yc < 0 ? -Math.pow(-yc / ht, 1.1) : Math.pow(yc / hb, 1.8);
  const c = Math.sqrt(Math.max(0, 1 - s * s));
  return rw * Math.pow(c, s < 0 ? 2 / 2.25 : 2 / 3.2) * (1 + 0.05 * s);
}

/** Signed distance to a vertical stroke from (0, y0) to (0, y1), `hw` thick each side. */
function sdStem(x, y, y0, y1, hw) {
  return Math.hypot(x, y - clamp(y, y0, y1)) - hw;
}

/** How far inside an ellipse a point is: 0 at its centre, 1 on its edge. */
const inEllipse = (x, y, rx, ry) => Math.hypot(x / rx, y / ry);

function renderBot(size) {
  const out = new Uint8Array(size * size * 4);
  // The engine's detailFor: below this the bot is its body, its eyes and its sprout.
  const full = size >= 48;
  const k = full ? 1 : 0;
  const R = size * (full ? 0.335 : 0.375);
  const cx = size / 2;

  const rw = R * 1.18;
  const ht = R;
  const hb = R * 0.84;
  const rim = R * 0.05; // dark outline so the tray icon reads on light themes

  // The sprout: a stem from behind the head, and two leaves at its tip.
  const stemBase = -(ht + hb) + R * 0.12;
  const stemLen = R * lerp(0.5, 0.44, k);
  const stemW = R * lerp(0.07, 0.04, k);
  const tipY = stemBase - stemLen;
  const leaf = R * lerp(0.46, 0.34, k);
  const stemCol = mix(mix(GREEN, STEM_GREEN, 0.35), BLACK, 0.12);

  // From the leaves' tips to the ground (the toes', when it has them), centred on the icon.
  const top = tipY - leaf * 0.9;
  const bottom = full ? R * 0.13 : 0;
  const gy = size / 2 - (top + bottom) / 2;

  const ek = lerp(1.3, 1, k);
  const ew = R * 0.115 * ek;
  const eh = R * 0.15 * ek;
  const ex = R * 0.42;
  const eyeY = -R * 0.86;
  const ms = lerp(1.3, 1, k);
  const mouthY = eyeY + R * 0.21 - R * 0.05 * ms;
  const mouthR = R * 0.085 * ms;
  const mouthW = R * 0.021 * ms * lerp(1.5, 1, k);

  /** A leaf leaning `side` (-1 left, 1 right): how far along it and across it a point is. */
  const leafAt = (x, y, side, grow) => {
    const a = -Math.PI / 2 + side * 0.78;
    const dx = x;
    const dy = y - tipY;
    const u = dx * Math.cos(a) + dy * Math.sin(a);
    const v = -dx * Math.sin(a) + dy * Math.cos(a);
    if (u < -grow || u > leaf + grow) return -1;
    const t = clamp(u / leaf, 0, 1);
    return Math.abs(v) <= t * (1 - t) * leaf + grow ? t : -1;
  };

  /** An arm, as the engine hangs it: an ellipse turned a little outwards. Its inside, 0…1, or -1. */
  const armAt = (x, y, side) => {
    const a = side * 0.42;
    const dx = x - side * rw * 0.93;
    const dy = y + hb * 0.95;
    const u = dx * Math.cos(a) - dy * Math.sin(a);
    const v = dx * Math.sin(a) + dy * Math.cos(a) - R * 0.2;
    const d = inEllipse(u, v, R * 0.16, R * 0.24);
    return d <= 1 ? d : -1;
  };

  const bodyAt = (x, y, grow) => Math.abs(x) <= bodyHalfWidth(y + hb, rw + grow, ht + grow, hb + grow);

  const bodyColor = (x, y) => {
    // The plush: light from the upper left, darker towards the edge and the ground.
    const d = Math.hypot(x + rw * 0.3, y + hb + ht * 0.5);
    const t = clamp((d - R * 0.1) / (R * 1.6), 0, 1);
    const light = mix(SKIN_A, WHITE, 0.5);
    const mid = mix(SKIN_A, SKIN_B, 0.3);
    let col = t < 0.5 ? mix(light, mid, t / 0.5) : mix(mid, SKIN_B, (t - 0.5) / 0.5);
    col = mix(col, SHADE, 0.16 * clamp((y + hb * 0.7) / (hb * 0.7), 0, 1));
    // The sprout's colour, coming up from under it.
    col = mix(col, GREEN, 0.22 * GLOW * clamp(1 - Math.hypot(x, y - R * 0.1) / (R * 1.3), 0, 1));
    const hl = inEllipse(x + rw * 0.4, y + hb + ht * 0.55, R * 0.36, R * 0.22);
    if (hl < 1) col = mix(col, WHITE, 0.6 * (1 - hl));

    for (const side of [-1, 1]) {
      const c = inEllipse(x - side * R * 0.66, y - (eyeY + R * 0.2), R * 0.19, R * 0.12);
      if (c < 1) col = mix(col, CHEEK, 0.34 * (1 - c));
    }
    return col;
  };

  const faceAt = (x, y) => {
    for (const side of [-1, 1]) {
      const px = x - side * ex;
      const py = y - eyeY;
      if (inEllipse(px, py, ew, eh) > 1) continue;
      if (full) {
        if (Math.hypot(px + ew * 0.3, py + eh * 0.36) <= ew * 0.33) return WHITE;
        if (Math.hypot(px - ew * 0.32, py - eh * 0.36) <= ew * 0.14) return WHITE;
      }
      return mix(INK_LIGHT, INK, clamp(Math.hypot(px, py - eh * 0.5) / (eh * 1.2), 0, 1));
    }
    // The smile: the lower arc of a circle, with round ends.
    const px = x;
    const py = y - mouthY;
    const a = Math.atan2(py, Math.abs(px));
    const a0 = Math.PI * 0.22;
    const d = a >= a0
      ? Math.abs(Math.hypot(px, py) - mouthR)
      : Math.hypot(Math.abs(px) - Math.cos(a0) * mouthR, py - Math.sin(a0) * mouthR);
    return d <= mouthW ? INK : null;
  };

  /** The colour of one point of the icon, or null where it is empty. */
  const sample = (x, y) => {
    if (full) {
      for (const side of [-1, 1]) {
        const d = armAt(x, y, side);
        if (d < 0) continue;
        const arm = mix(mix(SKIN_A, SKIN_B, 0.35), SKIN_B, clamp((y + hb * 1.1) / (R * 0.5), 0, 1));
        return d > 0.86 ? mix(arm, SHADE, 0.22) : arm;
      }
    }
    if (bodyAt(x, y, 0)) return faceAt(x, y) ?? bodyColor(x, y);
    if (full) {
      for (const side of [-1, 1]) {
        if (inEllipse(x - side * R * 0.48, y + R * 0.01, R * 0.27, R * 0.14) <= 1) {
          return mix(SKIN_B, BLACK, 0.1);
        }
      }
    }
    for (const side of [-1, 1]) {
      const t = leafAt(x, y, side, 0);
      if (t >= 0) return mix(mix(GREEN, BLACK, 0.08), mix(GREEN, WHITE, 0.35 + 0.2 * GLOW), t);
    }
    if (sdStem(x, y, tipY, stemBase, stemW) <= 0) return stemCol;

    const outlined =
      bodyAt(x, y, rim) ||
      sdStem(x, y, tipY, stemBase, stemW) <= rim ||
      leafAt(x, y, -1, rim) >= 0 || leafAt(x, y, 1, rim) >= 0 ||
      (full && (
        inEllipse(x + R * 0.48, y + R * 0.01, R * 0.27 + rim, R * 0.14 + rim) <= 1 ||
        inEllipse(x - R * 0.48, y + R * 0.01, R * 0.27 + rim, R * 0.14 + rim) <= 1
      ));
    return outlined ? RIM : null;
  };
  const cy = gy;
  const total = SS * SS;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const col = sample(px + (sx + 0.5) / SS - cx, py + (sy + 0.5) / SS - cy);
          if (!col) continue;
          r += col[0];
          g += col[1];
          b += col[2];
          hits++;
        }
      }
      if (hits === 0) continue;
      const o = (py * size + px) * 4;
      out[o] = Math.round(r / hits);
      out[o + 1] = Math.round(g / hits);
      out[o + 2] = Math.round(b / hits);
      out[o + 3] = Math.round((hits / total) * 255);
    }
  }
  return out;
}

// ── PNG ───────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── ICO (PNG-in-ICO, Vista and later) ─────────────────────────────────────────

function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ── Go ────────────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });

const png = (size) => encodePNG(size, renderBot(size));

const files = {
  "32x32.png": png(32),
  "128x128.png": png(128),
  "128x128@2x.png": png(256),
  "icon.png": png(512),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(OUT, name), data);
  console.log(`${name} — ${data.length} bytes`);
}

const ico = encodeICO([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png(size) })));
writeFileSync(join(OUT, "icon.ico"), ico);
console.log(`icon.ico — ${ico.length} bytes`);
