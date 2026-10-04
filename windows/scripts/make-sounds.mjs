// Writes windows/sounds/*.wav: Nook's own short, soft sounds, made here from
// sine and triangle tones with an attack and a decay. Nothing is sampled or
// taken from anywhere. Run it from windows/: `node scripts/make-sounds.mjs`.
//
// Every file keeps the name the app already loads and about the length the old
// one had, so the code does not change. 48 kHz, 16-bit PCM, two channels, and no
// peak above half scale (-6 dBFS).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 48000;
const PEAK = 0.5;
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "sounds");

// Notes, in Hz.
const N = {
  G4: 392, A4: 440, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, B5: 987.77,
  C6: 1046.5, E6: 1318.5,
};

/**
 * One tone: starts at `at` s and lasts `len` s, glides from `f` to `to` (same
 * pitch when omitted), `wave` is "sine" or "tri", `vib` a [hz, depth] wobble,
 * `noise` a share of hiss mixed in, `gain` its loudness against the others.
 */
const tone = (at, len, f, o = {}) => ({ at, len, f, to: o.to ?? f, wave: o.wave ?? "sine", vib: o.vib, noise: o.noise ?? 0, gain: o.gain ?? 1, attack: o.attack ?? 0.006 });

// name: [total length in s, tones]
const SOUNDS = {
  blip: [0.102, [tone(0, 0.09, 880, { gain: 0.8 })]],
  tick: [0.072, [tone(0, 0.05, 2000, { gain: 0.6, attack: 0.002 })]],
  hover: [0.084, [tone(0, 0.07, 1200, { gain: 0.4, attack: 0.004 })]],
  wink: [0.213, [tone(0, 0.09, 1000), tone(0.09, 0.12, 1400)]],
  pop: [0.38, [tone(0, 0.3, 900, { to: 300, attack: 0.002 })]],
  work: [0.376, [tone(0, 0.3, 350, { wave: "tri", gain: 0.7 })]],
  close: [0.429, [tone(0, 0.2, N.G5, { gain: 0.8 }), tone(0.14, 0.28, N.C5)]],
  think: [0.44, [tone(0, 0.22, 400, { vib: [9, 0.02], gain: 0.7 }), tone(0.2, 0.22, 440, { vib: [9, 0.02], gain: 0.7 })]],
  sleep: [0.453, [tone(0, 0.42, 300, { to: 200, gain: 0.7 })]],
  search: [0.457, [tone(0, 0.2, 500, { to: 700, wave: "tri", gain: 0.7 }), tone(0.2, 0.24, 700, { to: 500, wave: "tri", gain: 0.7 })]],
  peek: [0.446, [tone(0, 0.18, 500, { to: 800, gain: 0.8 }), tone(0.18, 0.26, 800, { to: 600, gain: 0.8 })]],
  send: [0.479, [tone(0, 0.4, 500, { to: 1000, wave: "tri", gain: 0.6, noise: 0.15 })]],
  open: [0.503, [tone(0, 0.45, 400, { to: 800, gain: 0.8 })]],
  annoyed: [0.592, [tone(0, 0.25, 200, { wave: "tri" }), tone(0.26, 0.32, 170, { wave: "tri" })]],
  approve: [0.596, [tone(0, 0.22, N.C5), tone(0.18, 0.4, N.G5)]],
  slap: [0.602, [tone(0, 0.5, 160, { to: 60, attack: 0.002, gain: 1 }), tone(0, 0.03, 900, { noise: 1, attack: 0.001, gain: 0.5 })]],
  rate: [0.674, [tone(0, 0.2, N.E5), tone(0.15, 0.2, N.G5), tone(0.3, 0.36, N.C6, { gain: 0.8 })]],
  question: [0.704, [tone(0, 0.3, N.D5), tone(0.28, 0.42, N.A5)]],
  yawn: [0.73, [tone(0, 0.7, 400, { to: 200, noise: 0.12, gain: 0.7 })]],
  greet: [0.751, [tone(0, 0.25, N.G4), tone(0.2, 0.25, N.C5), tone(0.4, 0.34, N.E5)]],
  gulp: [0.749, [tone(0, 0.3, 300, { to: 150 }), tone(0.32, 0.4, 150, { to: 250 })]],
  love: [0.791, [tone(0, 0.4, N.A5, { gain: 0.8 }), tone(0.2, 0.58, N.E6, { gain: 0.6, vib: [6, 0.01] })]],
  error: [0.838, [tone(0, 0.3, 140, { to: 80, attack: 0.004 }), tone(0.3, 0.52, 120, { to: 65, attack: 0.004, gain: 0.8 })]],
  proud: [0.864, [tone(0, 0.8, N.C5, { gain: 0.8 }), tone(0.08, 0.76, N.G5, { gain: 0.6 }), tone(0.16, 0.7, N.C6, { gain: 0.5 })]],
  approval: [0.877, [tone(0, 0.4, N.E5), tone(0.3, 0.57, N.B5, { gain: 0.9 })]],
  attach: [0.903, [tone(0, 0.3, N.A4, { wave: "tri" }), tone(0.25, 0.65, N.E5, { wave: "tri" })]],
  dizzy: [0.982, [tone(0, 0.95, 330, { vib: [7, 0.06], wave: "tri", gain: 0.7 })]],
  finish: [1.159, [tone(0, 0.5, N.C5), tone(0.15, 0.5, N.E5), tone(0.3, 0.5, N.G5), tone(0.45, 0.7, N.C6, { gain: 0.9 })]],
};

/** A small repeatable hiss (a linear congruential generator): the same file every run. */
function hiss() {
  let s = 12345;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2147483648 - 1;
  };
}

function render(length, tones) {
  const n = Math.round(length * RATE);
  const buf = new Float32Array(n);
  const rand = hiss();
  for (const t of tones) {
    const start = Math.round(t.at * RATE);
    const count = Math.min(Math.round(t.len * RATE), n - start);
    // Falls about 50 dB over the note, then a few ms to nothing so it ends clean.
    const k = Math.log(316) / t.len;
    let phase = 0;
    for (let i = 0; i < count; i++) {
      const x = i / RATE;
      const glide = t.f + (t.to - t.f) * (i / count);
      const hz = t.vib ? glide * (1 + t.vib[1] * Math.sin(2 * Math.PI * t.vib[0] * x)) : glide;
      phase += (2 * Math.PI * hz) / RATE;
      const wave = t.wave === "tri" ? (2 / Math.PI) * Math.asin(Math.sin(phase)) : Math.sin(phase) + 0.15 * Math.sin(2 * phase);
      const tail = Math.min(1, (count - i) / (0.008 * RATE));
      const env = Math.min(1, x / t.attack) * Math.exp(-k * x) * tail;
      buf[start + i] += ((1 - t.noise) * wave + t.noise * rand()) * env * t.gain;
    }
  }
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const scale = peak > 0 ? PEAK / peak : 1;
  return buf.map((v) => v * scale);
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 4);
  samples.forEach((v, i) => {
    const s = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    data.writeInt16LE(s, i * 4);
    data.writeInt16LE(s, i * 4 + 2);
  });
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(2, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 4, 28);
  head.writeUInt16LE(4, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

mkdirSync(out, { recursive: true });
for (const [name, [length, tones]] of Object.entries(SOUNDS)) {
  writeFileSync(join(out, `${name}.wav`), wav(render(length, tones)));
}
console.log(`wrote ${Object.keys(SOUNDS).length} sounds to ${out}`);
