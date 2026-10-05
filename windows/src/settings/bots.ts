// The settings window's bots: the real BotEngine, mounted the way island.ts
// draws its own (a slot of `diameter`, a canvas of `diameter / 0.6` over it),
// and one frame loop for all of them. The drawing is the engine's.

import { wipe } from "../core/canvas";
import type { BotStateName } from "../core/layout";
import { BOT_THEMES, BotEngine, type BotTheme } from "../bot/engine";
import { h } from "../views/dom";

/** As in island.ts: room above the body for what flies out of it. */
const OVERHANG = 40;
const DPR = Math.min(2, window.devicePixelRatio || 1);

export interface Bot {
  el: HTMLElement;
  setState(state: BotStateName): void;
}

interface Mounted {
  engine: BotEngine;
  canvas: HTMLCanvasElement;
  slot: HTMLElement;
  size: number;
  /** Frames still owed while motion is reduced: a change is drawn, then he holds still. */
  owed: number;
}

const bots: Mounted[] = [];
/** Enough frames for a change of state or colour to settle on his face. */
const SETTLE_FRAMES = 45;

/** The island's bot at `diameter`, without the glow the open island puts under him. */
export function mountBot(diameter: number): Bot {
  const size = Math.round(diameter / 0.6);
  const height = size + OVERHANG;
  const slot = h("div", { class: "sp-bot", style: `width:${diameter}px;height:${diameter}px` });
  const canvas = h("canvas");
  canvas.width = Math.round(size * DPR);
  canvas.height = Math.round(height * DPR);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${height}px`;
  // The body's middle sits on the slot's middle, as botPosition has it.
  canvas.style.left = `${diameter / 2 - size / 2}px`;
  canvas.style.top = `${diameter / 2 - OVERHANG / 2 - height / 2}px`;
  slot.append(canvas);

  const engine = new BotEngine();
  engine.particleOverhang = OVERHANG;
  const mounted: Mounted = { engine, canvas, slot, size, owed: SETTLE_FRAMES };
  bots.push(mounted);
  return {
    el: slot,
    setState(state) {
      engine.setState(state);
      wakeBots();
      mounted.owed = SETTLE_FRAMES;
    },
  };
}

export const isBotTheme = (name: string): name is BotTheme => name in BOT_THEMES;

/** Every bot of this window in `name`'s colours; a name the engine does not know leaves them as they are. */
export function wearBotTheme(name: string) {
  if (!isBotTheme(name)) return;
  for (const bot of bots) {
    bot.engine.theme = name;
    bot.owed = SETTLE_FRAMES;
  }
  wakeBots();
}

/**
 * The frame loop: every bot on show, its eyes after the mouse. The webview
 * itself stops handing out frames while the window is hidden — which it is for
 * most of Nook's life — so nothing is drawn then; and with motion reduced, a
 * bot is drawn only until a change has settled.
 */
export function startBots(still: () => boolean) {
  const mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  window.addEventListener("mousemove", (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });

  // The settings window exists, hidden, for all of Nook's life, and a hidden
  // WebView2 window goes on handing out frames: the loop has to stop by itself.
  // It runs while a bot still has something to do, and is woken by what can
  // give it something: the mouse, the window coming back, a bot refreshed.
  // "Hidden" cannot be asked of the page (a hidden Tauri window still says it
  // is visible), so the window having the keyboard stands for it: a settings
  // window nobody is using keeps its bots still.
  const onShow = () => !document.hidden && document.hasFocus();
  let running = false;
  let moved = false;
  const wake = () => {
    if (running || !onShow()) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  };
  wakeBots = wake;
  window.addEventListener("mousemove", () => {
    moved = true;
    wake();
  });
  window.addEventListener("focus", wake);
  window.addEventListener("blur", () => (moved = false));
  document.addEventListener("visibilitychange", wake);

  // The first look is drawn at once, whether the window has the keyboard or
  // not: no bot is an empty square until the mouse comes by.
  for (const b of bots) {
    b.engine.update(0);
    const ctx = b.canvas.getContext("2d");
    if (!ctx) continue;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    wipe(ctx);
    b.engine.draw(ctx, b.size, b.size + OVERHANG);
  }

  let last = performance.now();
  const frame = (nowMs: number) => {
    if (!onShow()) {
      running = false;
      return;
    }
    let lively = moved;
    moved = false;
    const dt = Math.min(0.05, (nowMs - last) / 1000);
    last = nowMs;
    const calm = still();
    for (const b of bots) {
      // One that is not in the page — another section is on show — costs nothing.
      if (!b.slot.isConnected) continue;
      if (calm) {
        if (b.owed <= 0) continue;
        b.owed--;
        b.engine.lookX = 0;
        b.engine.lookY = 0;
      } else {
        const r = b.slot.getBoundingClientRect();
        // island.ts lookX / lookY
        b.engine.lookX = Math.tanh((mouse.x - (r.left + r.width / 2)) / 260);
        b.engine.lookY = -Math.tanh((mouse.y - (r.top + r.height / 2)) / 200);
      }
      b.engine.update(dt);
      if (b.engine.busy || (calm && b.owed > 0)) lively = true;
      const ctx = b.canvas.getContext("2d");
      if (!ctx) continue;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      wipe(ctx);
      b.engine.draw(ctx, b.size, b.size + OVERHANG);
    }
    if (lively) requestAnimationFrame(frame);
    else running = false;
  };
  wake();
}

/** Starts the frame loop again; set by startBots. */
let wakeBots = () => {};

/** A bot shown again after a spell out of the page is drawn afresh, even with motion reduced. */
export function refreshBots() {
  for (const bot of bots) bot.owed = SETTLE_FRAMES;
  wakeBots();
}
