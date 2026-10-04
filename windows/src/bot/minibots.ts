// Mini bots (pills + compact grid) — port of MiniBotCanvasView.
// Each canvas owns a BotEngine; the island's frame loop ticks every live one.

//
// A session's mini (`createStateBot`) also answers the cursor, through the
// reaction layer (reactions.ts) and by its rules for a small bot: its eyes
// follow, it perks up, and a hover makes it happy. Its controller is made the
// first time the cursor comes by, and is only ever ticked while the cursor is
// there or a reaction plays: one at rest goes back to costing no frame.

import { Ease } from "../core/anim";
import { BotEngine, hexToRGB } from "./engine";
import { GulluReactions, type GulluZone } from "./reactions";
import { wipe } from "../core/canvas";
import type { BotStateName } from "../core/layout";
import type { AgentTask } from "../core/state";

interface MiniBot {
  canvas: HTMLCanvasElement;
  engine: BotEngine;
  cssSize: number;
  taskId: string;
  /** Not drawn any more past this time (`performance.now()`): it stands for something at rest. Infinity while it is lively. */
  stillAt: number;
  /** It answers the cursor: a session's mini does, the others do not. */
  reacts: boolean;
  /** Its reactions, once the cursor has come by. */
  ctl: GulluReactions | null;
  /** The status its reactions were last told of: the engine's state, which whoever made the mini sets. */
  status: BotStateName | null;
  /** Drawn until then whatever else: the cursor was beside it a moment ago, or a reaction has just played. */
  wakeUntil: number;
  /** Its eyes are the reaction layer's, until the cursor has gone. */
  attended: boolean;
  /** A mini that is lively (a session at work) does not play for ever: it plays a beat now and then, staggered with the others. */
  beatDue: number;
  beatUntil: number;
  /** Drawn until then whatever else: its state has changed, and the change has to play out. */
  drawUntil: number;
}

/** How long a lively mini's beat is drawn, and how far apart two of its beats are (ms). */
const BEAT_MS = 900;
const BEAT_EVERY_MS: readonly [number, number] = [3_500, 6_000];

/** How long a mini bot put to rest goes on being drawn: its last state's entrance has played out by then. */
const SETTLE_MS = 1_400;
/** How close the cursor comes before a mini at rest is given its reactions: where the layer's "near" begins for a small bot. */
const NOTICE_PX = 90;
/** How long a reaction's way back to rest, and a mini's own after the cursor has gone, are drawn for. */
const LET_GO_MS = 500;

const live = new Map<HTMLCanvasElement, MiniBot>();

/** Settings → Appearance, as the island last said: playful reactions, and reduced motion (null follows the system). */
let playful = true;
let reduce: boolean | null = null;

const isClose = (zone: GulluZone) => zone === "on" || zone === "near";

/**
 * Creates a mini bot whose **body** is about `bodySize` CSS pixels across.
 *
 * The engine draws the body at some 60 % of its canvas, so the canvas is
 * `bodySize / 0.6` and is centred in a `bodySize` slot, overflowing it — the
 * same thing SwiftUI does with a `.frame(width: 22/0.6)` inside a
 * `.frame(width: 22)`. Sizing the canvas itself to `bodySize` would shrink the
 * whole drawing to 60 %, which is what used to happen.
 *
 * At these sizes — a 13 px slot in the compact grid, 24 px in a pill — the
 * engine draws its simplified bot: see `detailFor` and `faceFor` in engine.ts.
 * Its plush is dyed in the task's colour; its sprout keeps the state's.
 */
export function createMiniBot(task: AgentTask, bodySize: number): HTMLElement {
  const { slot, engine } = mount(bodySize, task.id);
  engine.bodyColor = hexToRGB(task.color);
  engine.setState(task.state, true);
  if (task.emote) engine.setPermanentEmote(task.emote);
  if (task.miniEye) {
    engine.permanentEye = task.miniEye;
    engine.eyeOverride = task.miniEye;
    engine.eyeOverrideUntil = Number.POSITIVE_INFINITY;
  }
  return slot;
}

/** The slot, its canvas and its engine, ticked from now on by the island's loop. */
function mount(bodySize: number, taskId: string): { slot: HTMLElement; engine: BotEngine } {
  const slot = document.createElement("span");
  slot.className = "mini";
  slot.style.width = `${bodySize}px`;
  slot.style.height = `${bodySize}px`;

  const canvas = document.createElement("canvas");
  const engineSize = bodySize / 0.6;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(engineSize * dpr);
  canvas.height = Math.round(engineSize * dpr);
  canvas.style.width = `${engineSize}px`;
  canvas.style.height = `${engineSize}px`;
  slot.append(canvas);

  const engine = new BotEngine();
  engine.isMini = true;
  live.set(canvas, {
    canvas, engine, cssSize: engineSize, taskId, stillAt: Number.POSITIVE_INFINITY,
    reacts: false, ctl: null, status: null, wakeUntil: 0, attended: false,
    // Staggered: each starts its first beat at its own time.
    beatDue: performance.now() + 400 + Math.random() * 3_000, beatUntil: 0, drawUntil: 0,
  });
  return { slot, engine };
}

/**
 * A mini bot that stands for something other than a task — a job of a CI
 * run. Nothing in State drives it: it comes with its engine, and whoever made
 * it changes its state.
 *
 * It appears already in `state`, without that state's entrance (the finished
 * hop, the error shake): arriving on a run that passed an hour ago is not the
 * moment it passed. `engine.setState` plays the entrance later, when the state
 * really changes, as for any other bot.
 *
 * `eyes` scales his eyes. A mini's are drawn big so they still read at the
 * grid's 13 px; drawn bigger than that, the same eyes crowd the face and their
 * shapes — happy, flat, closed — run into each other.
 */
export function createFreeBot(
  color: string, state: BotStateName, bodySize: number, eyes = 1,
): { el: HTMLElement; engine: BotEngine } {
  const { slot, engine } = mount(bodySize, "");
  engine.bodyColor = hexToRGB(color);
  engine.adopt(state);
  engine.es = eyes;
  engine.tgEs = eyes;
  return { el: slot, engine };
}

/**
 * A mini bot in its own cream, for a session: what it is at is read on its
 * eyes and its sprout, not on its body. Nothing in State drives it either.
 */
export function createStateBot(state: BotStateName, bodySize: number): { el: HTMLElement; engine: BotEngine } {
  const { slot, engine } = mount(bodySize, "");
  engine.adopt(state);
  // Drawn once now: one made at rest, on an island at rest, is ticked by nothing.
  const canvas = slot.querySelector("canvas");
  const mb = canvas ? live.get(canvas) : undefined;
  if (mb) {
    mb.reacts = true;
    paint(mb, 0);
  }
  return { el: slot, engine };
}

/**
 * Puts a mini bot to rest, or wakes it. One at rest is drawn a moment longer —
 * the time its state takes to settle — and then left as it stands: a session
 * that has finished costs no frame. With `changed`, one already at rest has a
 * new state to settle into, and is given the time again. `el` is what
 * `createMiniBot`, `createFreeBot` or `createStateBot` gave.
 */
export function restMiniBot(el: HTMLElement, resting: boolean, changed = false) {
  const canvas = el.querySelector("canvas");
  const mb = canvas ? live.get(canvas) : undefined;
  if (!mb) return;
  const now = performance.now();
  if (changed) mb.drawUntil = now + SETTLE_MS;
  if (!resting) {
    // Back from rest: its state is drawn once more, and its beats begin.
    if (mb.stillAt !== Number.POSITIVE_INFINITY) {
      mb.drawUntil = now + SETTLE_MS;
      mb.beatDue = now + 600 + Math.random() * 2_400;
    }
    mb.stillAt = Number.POSITIVE_INFINITY;
  } else if (changed || mb.stillAt === Number.POSITIVE_INFINITY) mb.stillAt = performance.now() + SETTLE_MS;
}

/** On show: in the document, and in a view that is the one on show (or in none). */
function shown(mb: MiniBot): boolean {
  if (!mb.canvas.isConnected) return false;
  const view = mb.canvas.closest(".view");
  return view == null || view.classList.contains("on");
}

/** Lively, and its state is one that moves: it plays beats. */
const beats = (mb: MiniBot) => mb.stillAt === Number.POSITIVE_INFINITY && mb.engine.beatable;

/**
 * True while a mini bot on the page still has something to draw: the loop that
 * ticks them goes on. A lively one is drawn only in its beat, for a change of
 * its state, and while the cursor is at it; one at rest only until it has settled.
 */
export function miniBotsLively(): boolean {
  const now = performance.now();
  for (const mb of live.values()) {
    if (!mb.canvas.isConnected) continue;
    if (now < mb.stillAt && mb.stillAt !== Number.POSITIVE_INFINITY) return true;
    if (now < mb.wakeUntil || now < mb.drawUntil || now < mb.beatUntil) return true;
  }
  return false;
}

/**
 * When the next beat of a lively mini on show is due (`performance.now()`
 * milliseconds), or null: the island arms its one timer for it while the loop
 * is stopped. Never asked while the home view is not on show.
 */
export function miniBotsNextDue(): number | null {
  let due: number | null = null;
  for (const mb of live.values()) {
    if (!beats(mb) || !shown(mb)) continue;
    if (due == null || mb.beatDue < due) due = mb.beatDue;
  }
  return due;
}

// ── The cursor ────────────────────────────────────────────────────────────────

/** Settings → Appearance: off, the minis are as they were before they had reactions; `reduceMotion` is the controller's (null follows the system). */
export function miniBotManners(playfulOn: boolean, reduceMotion: boolean | null) {
  playful = playfulOn;
  reduce = reduceMotion;
  for (const mb of live.values()) {
    if (mb.ctl) mb.ctl.reduceMotion = reduce;
  }
  if (!playful) leaveMiniBots();
}

/** A mini's reactions: to the cursor only — what an idle bot does by itself, and its nap, are the island's bot's. */
function reactions(mb: MiniBot): GulluReactions {
  const ctl = new GulluReactions(mb.engine);
  ctl.beats = false;
  ctl.napAfter = Number.POSITIVE_INFINITY;
  ctl.idleEvery = [1e9, 1e9];
  ctl.reduceMotion = reduce;
  // …and back: the idle behaviour it had planned as it was made is put off with the rest.
  ctl.setVisible(false);
  ctl.setVisible(true);
  return ctl;
}

/** The status is the engine's state, set by whoever made the mini: its reactions are told when it has changed. */
function wearStatus(mb: MiniBot) {
  if (!mb.ctl || mb.status === mb.engine.state) return;
  mb.status = mb.engine.state;
  mb.ctl.setStatus(mb.status);
}

/**
 * The cursor, in the page's coordinates, while it is on the island with the
 * minis on show. The mini nearest to it, within the near radius, reacts: it
 * is woken for as long as the cursor is there.
 */
export function pointMiniBots(x: number, y: number) {
  if (!playful) return;
  const now = performance.now();
  // Only the one nearest the cursor reacts, and only when it is within the near radius: the others stay as they are.
  let nearest: MiniBot | null = null;
  let best = NOTICE_PX;
  const centre = new Map<MiniBot, { cx: number; cy: number; w: number }>();
  for (const mb of live.values()) {
    if (!mb.reacts || !mb.canvas.isConnected) continue;
    const r = mb.canvas.getBoundingClientRect();
    if (r.width === 0) continue;
    const at = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width };
    centre.set(mb, at);
    const dist = Math.hypot(x - at.cx, y - at.cy);
    // Ties go to the first.
    if (dist <= best && (nearest == null || dist < best)) {
      best = dist;
      nearest = mb;
    }
  }
  for (const [mb, at] of centre) {
    if (mb !== nearest) {
      // One that was the nearest a moment ago is let go of; the rest were never in it.
      if (mb.ctl && isClose(mb.ctl.zone)) {
        mb.ctl.pointerLeave();
        mb.wakeUntil = now + SETTLE_MS;
      }
      continue;
    }
    if (!mb.ctl) mb.ctl = reactions(mb);
    const ctl = mb.ctl;
    const was = ctl.zone;
    wearStatus(mb);
    // The canvas is the body's slot over 0.6 (see `createMiniBot`).
    ctl.place(at.cx, at.cy, at.w * 0.6);
    ctl.pointerMove(x, y);
    if (isClose(was) || isClose(ctl.zone)) mb.wakeUntil = now + SETTLE_MS;
    // A hover that is to be answered: nobody arms a timer for a mini, it is drawn until then.
    const due = ctl.nextDue();
    if (due != null && due < now + 5_000) mb.wakeUntil = Math.max(mb.wakeUntil, due + 100);
  }
}

/** The cursor is off the island, or the minis are not on show. */
export function leaveMiniBots() {
  for (const mb of live.values()) {
    if (!mb.ctl) continue;
    const was = mb.ctl.zone;
    mb.ctl.pointerLeave();
    if (isClose(was)) mb.wakeUntil = performance.now() + SETTLE_MS;
  }
}

/**
 * True while a mini's reactions drive it: the cursor is beside it or was a
 * moment ago, or a reaction is playing. One that is drawn anyway goes on
 * looking at a cursor that has stopped; one at rest is left as it stands,
 * looking at it, and costs nothing until the cursor moves again.
 */
function attend(mb: MiniBot, now: number): boolean {
  const ctl = mb.ctl;
  if (!ctl) return false;
  if (ctl.reaction != null) mb.wakeUntil = Math.max(mb.wakeUntil, now + LET_GO_MS);
  if (now < mb.wakeUntil || (now < mb.stillAt && isClose(ctl.zone))) {
    mb.attended = true;
    mb.engine.miniFollows = true;
    return true;
  }
  if (mb.attended && !isClose(ctl.zone)) letGo(mb, now);
  return false;
}

/** The cursor has gone: the mini is its own again — its eyes wander, its sprout is as its state alone has it. */
function letGo(mb: MiniBot, now: number) {
  mb.attended = false;
  const e = mb.engine;
  e.miniFollows = false;
  e.lookRange = 1;
  e.lean = 0;
  for (const prop of ["sproutPerk", "sproutDroop", "sproutWiggle"] as const) {
    if (e[prop] !== 0) e.anim(prop, [[0, 300, Ease.inOut]]);
  }
  // One at rest is drawn while that settles.
  if (mb.stillAt !== Number.POSITIVE_INFINITY) mb.stillAt = Math.max(mb.stillAt, now + LET_GO_MS);
}

export function releaseMiniBot(canvas: HTMLCanvasElement) {
  live.delete(canvas);
}

/** Drops every canvas no longer in the document (views are rebuilt wholesale). */
export function pruneMiniBots() {
  for (const [canvas] of live) {
    if (!canvas.isConnected) live.delete(canvas);
  }
}

export function syncMiniBotStates(tasks: AgentTask[]) {
  for (const mb of live.values()) {
    const task = tasks.find((t) => t.id === mb.taskId);
    if (!task) continue;
    if (mb.engine.state !== task.state) mb.drawUntil = performance.now() + SETTLE_MS;
    mb.engine.setState(task.state);
    mb.engine.bodyColor = hexToRGB(task.color);
  }
}

function paint(mb: MiniBot, dt: number, attended = false) {
  const ctx = mb.canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (attended && mb.ctl) {
    wearStatus(mb);
    mb.ctl.update(dt);
  }
  mb.engine.update(dt);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wipe(ctx);
  mb.engine.draw(ctx, mb.cssSize, mb.cssSize);
}

/** One tick for every mini bot on the page that is not at rest. */
export function tickMiniBots(dt: number) {
  const now = performance.now();
  for (const mb of live.values()) {
    // A beat of a lively mini whose time has come: its extras play for a moment, and it goes still again.
    if (now >= mb.beatDue && beats(mb) && shown(mb)) {
      mb.beatUntil = now + BEAT_MS;
      mb.beatDue = now + BEAT_EVERY_MS[0] + Math.random() * (BEAT_EVERY_MS[1] - BEAT_EVERY_MS[0]);
      mb.engine.beat(BEAT_MS / 1000);
    }
    const attended = attend(mb, now);
    const drawn = now < mb.beatUntil || now < mb.drawUntil || (now < mb.stillAt && mb.stillAt !== Number.POSITIVE_INFINITY);
    if (drawn || attended) paint(mb, dt, attended);
  }
}

export const miniBotCount = () => live.size;
