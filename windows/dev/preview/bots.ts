// Preview only: the real BotEngine mounted the way island.ts draws its own bot
// (a slot of `diameter`, a canvas of `diameter / 0.6`, the glow under it), and
// one frame loop for a page's bots and minis. The drawing is the engine's.

import { wipe } from "../../src/core/canvas";
import { botGlowColor, botGlowOpacity, type BotStateName } from "../../src/core/layout";
import { BotEngine } from "../../src/bot/engine";
import { createFreeBot, releaseMiniBot, tickMiniBots } from "../../src/bot/minibots";
import { h } from "../../src/views/dom";

/** As in island.ts: room above the body for what flies out of it. */
const OVERHANG = 40;
const DPR = Math.min(2, window.devicePixelRatio || 1);

export interface BigBot {
  el: HTMLElement;
  engine: BotEngine;
  setState(state: BotStateName): void;
}

interface Mounted {
  engine: BotEngine;
  canvas: HTMLCanvasElement;
  slot: HTMLElement;
  size: number;
}

const bigs: Mounted[] = [];

/** The island's bot at `diameter`; `glow` as the open island has it, none as the folded one. */
export function mountBot(diameter: number, glow: boolean): BigBot {
  const size = Math.round(diameter / 0.6);
  const height = size + OVERHANG;
  const slot = h("div", { class: "pv-bot", style: `width:${diameter}px;height:${diameter}px` });

  const glowEl = h("div", { class: "pv-bot-glow" });
  glowEl.style.width = glowEl.style.height = `${diameter * 2.2}px`;
  glowEl.style.left = glowEl.style.top = `${diameter / 2 - diameter * 1.1}px`;

  const canvas = h("canvas");
  canvas.width = Math.round(size * DPR);
  canvas.height = Math.round(height * DPR);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${height}px`;
  // The body's middle sits on the slot's middle, as botPosition has it.
  canvas.style.left = `${diameter / 2 - size / 2}px`;
  canvas.style.top = `${diameter / 2 - OVERHANG / 2 - height / 2}px`;
  if (glow) slot.append(glowEl);
  slot.append(canvas);

  const engine = new BotEngine();
  engine.particleOverhang = OVERHANG;
  bigs.push({ engine, canvas, slot, size });

  return {
    el: slot,
    engine,
    setState(state) {
      engine.setState(state);
      glowEl.style.background = `radial-gradient(circle, ${botGlowColor(state)} 0%, transparent 62%)`;
      glowEl.style.opacity = String(botGlowOpacity(state));
    },
  };
}

export interface MiniBot {
  el: HTMLElement;
  engine: BotEngine;
  release(): void;
}

/** A real mini bot in its own cream: the state is read on its eyes and antenna. */
export function mountMini(state: BotStateName, bodySize: number): MiniBot {
  const bot = createFreeBot("#000000", state, bodySize);
  bot.engine.bodyColor = null;
  return {
    el: bot.el,
    engine: bot.engine,
    release() {
      const canvas = bot.el.querySelector("canvas");
      if (canvas) releaseMiniBot(canvas);
    },
  };
}

/** This page's frame loop: every bot and mini, and the eyes after the mouse. */
export function startBots() {
  const mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  window.addEventListener("mousemove", (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });

  let last = performance.now();
  const frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - last) / 1000);
    last = nowMs;
    for (const b of bigs) {
      const r = b.slot.getBoundingClientRect();
      // island.ts lookX / lookY
      b.engine.lookX = Math.tanh((mouse.x - (r.left + r.width / 2)) / 260);
      b.engine.lookY = -Math.tanh((mouse.y - (r.top + r.height / 2)) / 200);
      b.engine.update(dt);
      const ctx = b.canvas.getContext("2d");
      if (!ctx) continue;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      wipe(ctx);
      b.engine.draw(ctx, b.size, b.size + OVERHANG);
    }
    tickMiniBots(dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
