// The island: DOM shell, sizing animation, bot placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp, mixColor } from "../core/anim";
import { Bridge, IS_TAURI } from "../core/bridge";
import { wipe } from "../core/canvas";
import {
  Display, EAR_COMPACT, EAR_EXPANDED, EXPANDED_CORNER, EXPANDED_W, LARGE_H, LARGE_W, NOTCH_W, OVERSHOOT_H, OVERSHOOT_W, PANEL_H, PANEL_W,
  ROUNDED_CORNER, Room, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition,
  islandSize, shelfWidth,
  type BotStateName, type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound, type SoundName } from "../core/sound";
import { CLAUDE_ID, State, foldedAutoHide, nextRequest, nextUsageReset, quietAt, type ClaudeSession, type SessionRequest, type SessionStep } from "../core/state";
import { BOT_THEMES, BotEngine, hexToRGB, type BotTheme, type RGB } from "../bot/engine";
import { Greeting } from "../bot/greeting";
import { leaveMiniBots, miniBotManners, miniBotsLively, miniBotsNextDue, pointMiniBots, tickMiniBots } from "../bot/minibots";
import { GulluReactions, type GulluCue } from "../bot/reactions";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { enterSessionPanel, leaveSubagent } from "../views/session";
import { ensureMorphCurve, scrollRow, settleRow, type MorphNames, type ShelfHost } from "../views/shelf";
import { widgetsSettingsChanged } from "../widgets";
import { ShelfHooks } from "../widgets/core";
import { widgetOn, type ShelfWidgetId } from "../widgets/defs";
import { h } from "../views/dom";
import { isActive, overallState, roster } from "../views/roster";
import { buildCompact, compactPlan, type CompactStrip } from "./compact";
import { IslandStateMachine } from "./fsm";
import { createNotch, type NotchShape } from "./notch";
import { PagePan, ROW_SETTLE_MS, TailGuard, canScroll, type PanEnd } from "./swipe";

const BOT_OVERHANG = 40;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

/**
 * What the large panel leaves free of the page, where there is no window of
 * the island's own to say (a plain browser): as src-tauri/src/island.rs does
 * of the display.
 */
const PAGE_MARGIN_W = 32;
const PAGE_MARGIN_H = 24;

/** True for something typed in: Escape there is the field's own business. */
const isField = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * Where a double click toggles the panel's size: the island's bar and the
 * panel's own empty space — the bare containers, never a control, a row, a
 * chip, a line of a journal or of the sidebar, or words. Matched against the
 * very element clicked, so anything drawn in one of these is not one of them.
 */
const EMPTY_SPACE = [
  "#island", "#island-clip", "#content", "#views", "#header", "#header .tabs", "#header .header-actions",
  ".session-view", ".session-view .gh-card", ".sess-rail", ".sess-rail-head", ".sess-tree",
  ".session-view .gh-main", ".session-view .gh-list", ".session-view .gh-head", ".sess-filters", ".sess-crumb",
  ".sess-filters > .grow", ".sess-crumb > .grow", ".session-view .gh-head > .grow",
].join(", ");

/** The keys that zoom a page with Ctrl: the island is not a page to zoom. */
const ZOOM_KEYS: ReadonlySet<string> = new Set(["+", "=", "-", "_", "0"]);

/**
 * A pinch on a trackpad comes as wheel events with Ctrl held, a few pixels
 * each: this much of them, summed, is a pinch meant. One gesture toggles once:
 * the rest of it is let go by, until the events have stopped for a moment and
 * the toggle is this old.
 */
const PINCH_THRESHOLD = 30;
const PINCH_GAP_MS = 220;
const PINCH_COOLDOWN_MS = 600;

/** Settings can turn reduced motion on or off; left on "system", the OS decides. */
const reducedMotion = () => {
  const wanted = State.settings.reduceMotion;
  if (wanted === "on") return true;
  if (wanted === "off") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

/** The same choice, as the bot's reactions take it: true, false, or null to follow the system. */
const reduceMotionChoice = (): boolean | null => {
  const wanted = State.settings.reduceMotion;
  return wanted === "on" ? true : wanted === "off" ? false : null;
};

/**
 * The sound of each of the bot's cues (bot/reactions.ts): only what the user
 * did — a hover, a click — has one. What it does by itself (the yawn, the nap,
 * a look around) is silent. A click's reaction that has none takes the slap, so
 * that no click is silent; every other cue is quiet.
 */
const CUE_SOUNDS: Partial<Record<GulluCue, SoundName>> = {
  love: "love", dizzy: "dizzy", annoyed: "annoyed", hover: "hover",
  gasp: "slap", giggle: "slap", laugh: "slap", boop: "slap", whee: "slap", raspberry: "slap",
};

/** How fast the bot's shell goes to a new colour, per second: about 90 % of the way in 0.4 s. */
const TINT_RATE = 5.5;
/** Closer than this on every channel (0…1), the body has its colour: a unit of 8-bit colour. */
const TINT_SETTLED = 0.004;
/**
 * The gap between frames while nothing but the bot's own loop is moving: about
 * 20-24 frames a second open, 12 folded, where the bot is 20 px wide. (The
 * wait is followed by the next display frame, so these land a little above the
 * gap itself.)
 */
const AMBIENT_MS = 36;
const AMBIENT_FOLDED_MS = 76;
/** The longest step one frame may take: a folded frame's gap, and a little. */
const MAX_STEP = 0.11;

/**
 * Writes an inline style only when it differs from what this module wrote last.
 * The frame loop sets a dozen of them each frame, most of them the same as the
 * frame before, and each write is style work for the page.
 */
const written = new WeakMap<HTMLElement, Map<string, string>>();
function put(el: HTMLElement, prop: string, value: string) {
  let seen = written.get(el);
  if (!seen) written.set(el, (seen = new Map()));
  if (seen.get(prop) === value) return;
  seen.set(prop, value);
  el.style.setProperty(prop, value);
}

/**
 * What only the time passing changes on the home view — a session at rest
 * leaving it, "updated 3 min ago", when a limit starts again — is drawn again
 * this often, by one timer that runs only while the home view is on show.
 */
const HOME_TICK_MS = 30_000;

/** How long after the shortcut the window has the keyboard, if it is going to have it at all. */
const SUMMON_FOCUS_MS = 600;

/** The views that show one session — its panel, its cards: Tab goes from one session to the next there. */
const ABOUT_SESSION: ReadonlySet<IslandViewName> = new Set(["session", "approval", "question", "finished", "error"]);

/** The views where the island's bot speaks for every session, not for the one in front. */
const SPEAKS_FOR_ALL: ReadonlySet<IslandViewName> = new Set(["overview", "empty", "settings", "shelf"]);

/**
 * The views of the island's two tabs: Home — the home view, or "empty" with
 * nothing to show — and the Shelf, to its right. A swipe and the arrow keys go
 * from one tab to the other on these views, and on no other.
 */
const TAB_VIEWS: ReadonlySet<IslandViewName> = new Set(["overview", "empty", "shelf"]);

/** The cards: views that come up over whatever was on show, and are done with once answered or read. */
const CARD_VIEWS: ReadonlySet<IslandViewName> = new Set(["approval", "question", "finished", "error", "confused"]);

/** The views Backspace leaves for the home view: every one but Home itself, a card that asks, and what plays by itself. */
const BACK_HOME: ReadonlySet<IslandViewName> = new Set(["session", "shelf", "settings", "finished", "error"]);

/**
 * The cards that only tell something: with a full-screen app in front they wait, where a request never does.
 * The Shelf, opened on a timer that ran out or a reminder that is due, is one of them.
 */
const NOTICE_VIEWS: ReadonlySet<IslandViewName> = new Set(["finished", "error", "shelf"]);

/** A page this close to where it is going is there, for a swipe that comes now. */
const PAGE_NEAR_PX = 16;
/** The island's side padding (style.css `#content`): a view is this much narrower than the island, each side. */
const PAGE_SIDE_PAD = 10;
/** A swipe to the right, summed over one gesture, that takes an expanded widget back to the row (px), and the pause after it. */
const BACK_SWIPE_PX = 60;
const BACK_SWIPE_COOLDOWN_MS = 450;

/** A wheel that counts in lines (a mouse's, on some systems) rather than pixels: one line is this many. */
const WHEEL_LINE_PX = 16;

/** A notch of a mouse's wheel with Shift: one page, however many events it makes, this far apart at least. */
const NOTCH_COOLDOWN_MS = 260;
/** The fastest the page may be thrown at the moment of release, px/s. */
const PAGE_MAX_VELOCITY = 3000;

/** True when a point of the page is on, or in, a rectangle of it. */
const within = (rect: DOMRect, x: number, y: number) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private shape!: NotchShape;
  private compact!: CompactStrip;
  private countdown!: HTMLElement;
  private wakeStrip!: HTMLElement;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  /** The Shelf's own host: what only it can answer — the expanded widget, its size, whether it ticks. */
  private shelf!: ShelfHost;
  /** A field of the Shelf has the keyboard and the island is kept open for it, though the pointer has gone. */
  private typingPin = false;
  /** The swipe to the right that takes an expanded widget back: what it has added up to, when the last event came, and when it may count again. */
  private backSwipe = { sum: 0, last: 0, until: 0, peak: 0 };
  /** What is left of the swipe that closed a widget — its momentum — which is not a tab's; a new push in it is. */
  private backTail = new TailGuard();
  /** The shared-element transition in flight, if one is: how to end it at once. */
  private morphEnd: (() => void) | null = null;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  /** The ears' radius: with the island's size, on the same spring. */
  private ear = new Tracked(0);
  /** The folded island's width, as it was last asked for: it follows what the island holds. */
  private compactW = 0;
  /** The state of the most urgent session: what the bot wears folded, and on the home view. */
  private overall: BotStateName = "idle";
  /** The home view's slow timer: see HOME_TICK_MS. */
  private homeTimer: number | null = null;
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  private engine = new BotEngine();
  /**
   * What the bot does about the cursor, a click and nothing happening
   * (bot/reactions.ts): it is told where the bot is, where the cursor is and
   * what the status is, and drives the engine. This is its host.
   */
  private gullu = new GulluReactions(this.engine);
  /** The one timer of a bot at rest: to the next thing it does by itself (`gullu.nextDue()`). None while the loop runs, or hidden. */
  private idleTimer: number | null = null;
  private greeting = new Greeting();

  /** The colour the bot's shell is drawn in, eased towards what it should be. */
  private bodyRGB: RGB | null = null;

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  private homeCollapseAt: number | null = null;

  /**
   * Why the island has the keyboard, while it has it. Its window never
   * activates (WS_EX_NOACTIVATE), so no key reaches the page unless it was
   * asked for: by a text field being typed in, or by the session panel — the
   * large one, for its Escape, and the sidebar once it was clicked, for its
   * arrows. Given back the moment nothing wants it any more.
   */
  private keyboard = new Set<"field" | "panel" | "cards" | "kept">();
  /** Tab went from the large panel to a session's card: the next panel it reaches is large again. */
  private stepLarge = false;

  /** The global shortcut opened the large panel: it stays open until it is shrunk or left. */
  private summoned = false;
  /** The look, a moment after the shortcut, at whether the window really got the keyboard. */
  private summonCheck: number | null = null;

  /** The pinch under way: what it has added up to, when its last event came, and whether it has toggled already. */
  private pinch = { sum: 0, last: 0, toggledAt: -Infinity, spent: false };

  /** The two-finger swipe between the tabs: where the page is under the fingers, and where it settles (island/swipe.ts). */
  private pan = new PagePan((line) => void Bridge.log(line));
  /** The one timer of a gesture: to when it may have ended. Armed only while one is under way. */
  private panTimer: number | null = null;
  /**
   * The two tabs side by side on the stage — under the fingers, or on their
   * way to a page. `pos` is how far along from Home (0) to the Shelf (the
   * island's width), px; with `springing` it is the island's spring that moves it.
   */
  private paging = false;
  private springing = false;
  private pos = 0;
  private pageSpring = new Spring(0, 0.5, 0.72);
  private pageTarget: 0 | 1 = 0;
  private pageClear: number | null = null;
  private lastNotch = -Infinity;
  /** Set when the island's rectangle must be told to Rust again though it looks unchanged: a page has settled. */
  private forceRect = false;
  /** How far the bot is carried sideways with Home's page, px (zero unless paging). */
  private pageShift = 0;
  /** The Shelf's row comes to rest on a card once the swipe that moves it has paused: the one timer of it. */
  private rowSettle: number | null = null;
  /**
   * The card on show came up over the Shelf: once it is answered or read, the
   * island goes back there, where the user was. Kept from one card to the next,
   * and let go when anything else is shown or the island folds.
   */
  private overShelf = false;

  /** The one timer that says a session at work has gone quiet: armed for the nearest of them, only while the island is on show. */
  private quietTimer: number | null = null;
  private quietDue = 0;
  /** The one timer to the next reset of a usage window: what is shown changes then, with nobody saying so. Only while the island is on show. */
  private resetTimer: number | null = null;
  private resetDue = 0;

  /**
   * A full-screen app is in front on the island's display, as Rust last said:
   * on its poll while the island is on show (the `fullscreen` event), and when
   * asked at the moment of a wake. Never polled for while the island is hidden.
   */
  private fullscreen = false;
  /** Something on the island is at work or asking, as last drawn: what holds the folded island when Settings say so. */
  private active = false;

  /** The one timer of the dizzy face worn after three slaps (Playful reactions off): it ends it. */
  private dizzyRecovery: number | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireInput();
    // A timer that ran out, a reminder that is due: the island comes up on its widget.
    ShelfHooks.alert = (id) => this.widgetDue(id);
    // Playful reactions off, a click is the engine's slap, and three of them its dizzy.
    this.engine.onDizzy = () => this.handleDizzy();
    this.gullu.onCue = (cue) => {
      const sound = CUE_SOUNDS[cue];
      if (sound) Sound.play(sound);
    };
    this.gullu.onChange = () => {
      this.ensureRunning();
      this.armIdle();
    };
    this.seatBot();
    this.greeting.onComplete = () => this.fsm.greetComplete();
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
    // New usage has other reset times.
    State.onGauges(() => this.watchUsageReset());
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      collapse: () => this.collapse(),
      leaveCard: (fold) => {
        if (this.overShelf) this.setView("shelf");
        else if (fold) this.collapse();
        else this.setView(State.defaultView());
      },
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
        // A request that came in while another pill had the front only left a
        // badge: bringing Claude's pill forward is asking for its card.
        if (id !== CLAUDE_ID) return;
        if (State.pendingQuestion) this.setView("question");
        else if (State.pendingApproval) this.setView("approval");
        // No card for the session in front, but one behind it is waiting: its turn.
        else if (State.waiting.length > 0) this.afterRequest(true);
      },
      openTerminal: () => this.openClient(),
      // The ↗ button: where the Claude pill's session runs. Another agent's pill has nowhere to go.
      openTarget: () => {
        if (State.focusTask?.id === CLAUDE_ID) this.openClient();
      },
      decide: (d) => {
        const req = State.pendingApproval;
        void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"}`);
        if (!req) return;
        Sound.play(d === "deny" ? "blip" : "approve");
        void Bridge.approvalDecision(req.requestId, d);
        this.noteOutcome(req, (step) => (step.permission = d === "deny" ? "denied" : "allowed"));
        this.settleRequest();
      },
      answer: (answers) => {
        const req = State.pendingQuestion;
        if (!req) return;
        Sound.play("approve");
        void Bridge.approvalAnswer(req.requestId, answers);
        this.noteOutcome(req, (step) => (step.answers = answers));
        this.settleRequest();
      },
      skipQuestion: () => {
        const req = State.pendingQuestion;
        if (!req) return;
        Sound.play("blip");
        void Bridge.approvalDecision(req.requestId, "skip");
        this.noteOutcome(req, (step) => (step.state = "failed"));
        this.settleRequest();
      },
      passQuestion: () => {
        const req = State.pendingQuestion;
        if (!req) return;
        Sound.play("blip");
        // Declined, not denied: Claude Code asks it in its own window at once.
        void Bridge.approvalDecline(req.requestId);
        this.settleRequest();
      },
      keyboard: (on) => {
        this.wantKeyboard("field", on);
        this.holdWhileTyping(on);
      },
      panelKeyboard: () => this.wantKeyboard("panel", true),
      reducedMotion: () => reducedMotion(),
      morph: (change, names, open) => this.morph(change, names, open),
      resized: (shrinking) => {
        this.syncBare();
        this.wantKeyboard("panel", this.shelf.focused != null);
        if (reducedMotion()) this.jumpGeometry();
        else this.animateGeometry(shrinking);
        State.notify();
      },
      setLarge: (on) => this.setLarge(on),
      showRequest: () => this.showRequest(),
      openSession: (changes) => {
        State.session.unseen = false;
        // "Read reply": what Claude said, whole — a very long reply is not cut for whoever asked to read it.
        enterSessionPanel(changes ? "changes" : "journal", !changes);
        this.setView("session");
      },
      openSessions: () => {
        enterSessionPanel("sessions");
        this.setView("session");
      },
      pickSession: (id) => this.pickSession(id),
      goToSession: (id) => {
        const session = State.sessions.find((s) => s.id === id);
        if (session) this.openClient(session);
      },
      openSessionOf: (id) => this.openSessionOf(id),
      reviewRequest: (id) => this.openSessionOf(id),
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setAutoClose: (s) => {
        State.settings.autoCloseInterval = s;
        this.fsm.homeToPetitDelay = s;
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => void Bridge.openSettingsWindow(),
      blip: () => Sound.play("blip"),
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.shape = createNotch();
    this.compact = buildCompact();
    this.countdown = h("div", { id: "countdown" });

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.shelf = this.views.get("shelf") as ShelfHost;
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.contentEl,
      this.compact.el,
    );
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.countdown,
    );
    // The outline goes first: everything else is drawn on it.
    this.islandEl.prepend(this.shape.el);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.wakeStrip, this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    // The greeting is short (bot/greeting.ts): it folds right after its last beat.
    this.fsm.greetAutoCollapseDelay = 0.1;
    this.fsm.petitToHiddenDelay = foldedAutoHide(State.settings);
    this.fsm.holds = () => State.settings.hideOnlyWhenIdle && this.active;
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "greeting") this.greeting.interrupt();
          else if (from === "hidden") Sound.play("peek");
          this.setMode("compact");
          if (from === "greeting") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home": {
          // Opened by hand while a request of the session in front still waits
          // (the island was folded on the way to its window): its card is back.
          const waiting = State.focusId !== CLAUDE_ID ? null : State.pendingQuestion ? "question" : State.pendingApproval ? "approval" : null;
          if (waiting) {
            State.isPinned = true;
            this.fsm.pinned = true;
          }
          this.expand(waiting ?? State.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        }
        case "greeting":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
    };
  }

  launch() {
    // Motion reduced: no greeting — the island simply appears folded.
    if (reducedMotion()) {
      this.fsm.forcePetit();
      return;
    }
    this.fsm.launch();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    this.abortPaging();
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      State.isPinned = false;
      this.leavePanel();
      this.releaseKeyboard();
      // The Shelf is remembered for one opening: the island opens on Home again.
      this.overShelf = false;
      this.endMorph();
      this.shelf.leave();
      if (this.typingPin) {
        this.typingPin = false;
        this.fsm.pinned = false;
      }
    }
    this.updateWindowCollapsed();
    // Hidden, nothing is to wake the island: not the timer of a session going
    // quiet, and not the bot's own either.
    this.watchQuiet();
    this.seatBot();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    // Back from hidden: what the island holds — the folded slots, the state the
    // bot wears — is drawn now, with the mode, and not left to the first frame
    // after it. A hidden island draws nothing, so nothing of it is assumed to
    // be up to date.
    if (prev === "hidden") {
      this.syncDom();
      this.logWake();
    }
    State.notify();
  }

  /**
   * One line in the log each time the island comes back from hidden, once it
   * has settled: what the folded island should hold and what is drawn. A wake
   * that shows the bot and nothing else has been reported and not reproduced;
   * this says, the next time it happens, which half is wrong.
   */
  private logWake() {
    window.setTimeout(() => {
      const plan = compactPlan();
      const strip = document.getElementById("compact");
      const drawn = (sel: string) => strip?.querySelectorAll(sel).length ?? -1;
      void Bridge.log(
        `wake mode=${State.mode} view=${State.view} sessions=${State.sessions.length} live=${plan.live.length} ` +
        `plan=${plan.dots}dots+${plan.kinds.join("/") || "no-metrics"} planW=${plan.width} screen=${Display.w} ` +
        `drawn=${drawn(".ci-dots > *")}dots+${drawn(".ci-metrics > *")}cells ` +
        `strip=${strip ? `${getComputedStyle(strip).opacity}@${Math.round(strip.getBoundingClientRect().width)}px` : "none"} ` +
        `island=${Math.round(this.width.value)}x${Math.round(this.height.value)} bot=${State.effectiveState}`,
      );
    }, 700);
  }

  expand(view: IslandViewName) {
    const wasLarge = State.large;
    // A request (or anything else that is shown) in the middle of a swipe: the swipe is dropped, the view is shown.
    this.abortPaging();
    if (State.mode !== "expanded" || State.view !== view) this.views.get(view)?.arm?.();
    this.show(view);
    this.leaveSessions(view);
    if (view !== "session") this.leavePanel();
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(wasLarge && !State.large);
    State.lastActivity = performance.now();
    this.homeCollapseAt = null;
    State.notify();
  }

  setView(view: IslandViewName) {
    if (State.mode !== "expanded") {
      this.abortPaging();
      this.fsm.forceHome();
      this.views.get(view)?.arm?.();
      this.show(view);
      this.animateGeometry(false);
      State.notify();
      return;
    }
    // Another tab is asked for while a widget is expanded: it goes back to the row, unseen, first.
    if (State.view === "shelf" && view !== "shelf" && TAB_VIEWS.has(view)) {
      this.endMorph();
      this.shelf.leave();
    }
    // From one tab to the other — or back to the one a swipe is on its way from —
    // the page slides on the island's spring, from where it is.
    if (TAB_VIEWS.has(State.view) && TAB_VIEWS.has(view) && !reducedMotion()) {
      if (this.paging || (State.view === "shelf") !== (view === "shelf")) {
        this.pageTo(view === "shelf" ? 1 : 0);
        State.lastActivity = performance.now();
        return;
      }
    }
    this.abortPaging();
    // The large panel is the largest shape there is: leaving it is always shrinking.
    const grew = !State.large && VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    // A card that asks something has just come on show: whatever click brought it up does not answer it.
    if (view !== State.view) this.views.get(view)?.arm?.();
    const tabbed = this.show(view);
    this.leaveSessions(view);
    if (view !== "session") this.leavePanel();
    State.lastActivity = performance.now();
    // From one tab to the other with motion reduced: the island is at its new height at once.
    if (tabbed && reducedMotion()) this.jumpGeometry();
    else this.animateGeometry(!grew);
    State.notify();
  }

  /**
   * Puts a view on show in place of the one that was. Between the two tabs the
   * views slide (`slideTabs`); a card that comes up over the Shelf is
   * remembered as such, for the way back. True when it went from one tab to
   * the other.
   */
  private show(view: IslandViewName): boolean {
    const from = State.view;
    const open = State.mode === "expanded";
    // Off the Shelf — to a card that asks, to the panel: what ticks there stops now, and the camera with it. The expanded widget is kept, for the way back.
    if (from === "shelf" && view !== "shelf") this.shelf.visible(false);
    this.overShelf = CARD_VIEWS.has(view) && open && (from === "shelf" || (this.overShelf && CARD_VIEWS.has(from)));
    const tabbed = open && TAB_VIEWS.has(from) && TAB_VIEWS.has(view) && (from === "shelf") !== (view === "shelf");
    this.crossFade(tabbed && reducedMotion() ? from : null, view);
    State.view = view;
    return tabbed;
  }

  /**
   * With motion reduced nothing travels between the tabs: the two cross-fade,
   * briefly (`.view.tab-cut`). With motion, the tabs page (`pageTo`, and the
   * swipe) and any other change of view is the views' own.
   */
  private crossFade(from: IslandViewName | null, to: IslandViewName) {
    for (const view of this.views.values()) view.el.classList.remove("tab-cut");
    if (!from) return;
    this.views.get(from)?.el.classList.add("tab-cut");
    this.views.get(to)?.el.classList.add("tab-cut");
  }

  /** The view a card gives the island back to: the Shelf when it came up over it, the home view otherwise. */
  private restView(): IslandViewName {
    return this.overShelf ? "shelf" : State.defaultView();
  }

  /**
   * To the next tab (1) or the one before (-1): what a swipe and the arrow
   * keys do. Only from a tab's own view, and only when there is a tab that
   * way. True when the tab changed.
   */
  private stepTab(by: 1 | -1): boolean {
    if (State.mode !== "expanded" || !TAB_VIEWS.has(State.view) || this.shelf.focused) return false;
    const onShelf = State.view === "shelf";
    if (onShelf === (by > 0)) return false;
    Sound.play("blip");
    this.setView(by > 0 ? "shelf" : State.defaultView());
    return true;
  }

  /**
   * A wheel event with no Ctrl: a two-finger swipe sideways goes from one tab
   * to the other (island/swipe.ts) — on a tab's own view, with the pointer on
   * the island. An event that is more up-and-down than sideways is none of
   * this, and scrolls whatever is under it as it always did. On the Shelf
   * the row scrolls first, and a gesture that scrolls it stops at its end: the
   * tab changes with another gesture, begun with the row already there
   * (island/swipe.ts). Shift with a mouse's wheel comes as a sideways delta
   * too, and is one.
   *
   * Where the pointer is decides, never what the event says it is over: after
   * a change of view under a pointer that has not moved, the browser goes on
   * aiming wheel events at what was there before — the home view, on the
   * Shelf — until the pointer moves. So the Shelf's row is found by the
   * pointer's place, and moved here, by the travel of each event.
   */
  private swipeTabs(e: WheelEvent) {
    if (State.mode !== "expanded" || !TAB_VIEWS.has(State.view)) return;
    if (!within(this.islandEl.getBoundingClientRect(), e.clientX, e.clientY)) return;
    const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? this.pageW() : 1;
    const dx = e.deltaX * unit;
    if (Math.abs(dx) <= Math.abs(e.deltaY * unit)) return;
    State.lastActivity = performance.now();
    const now = performance.now();
    // Everything of a sideways swipe is the island's: never the page's scroll, never "back".
    e.preventDefault();
    // An expanded widget: a swipe to the right takes it back to the row, once a gesture; the rest is not a tab's.
    if (State.view === "shelf" && this.shelf.focused) {
      this.swipeBack(dx, now);
      return;
    }
    // What is left of the swipe that closed a widget (its momentum too) is not a tab's: it ends with a
    // pause, a turn, or a push that ramps up again — a swipe begun while the momentum still runs.
    if (this.backTail.absorbs(dx, now)) return;
    // The page is all but there, on its way to rest: a swipe now is for what it shows, not for the page.
    if (this.paging && this.springing && Math.abs(this.pageTarget * this.pageW() - this.pos) < PAGE_NEAR_PX) this.commitPaging(this.pageTarget);
    const row = this.shelfRow(e.clientX, e.clientY);

    // A mouse's wheel (lines, or Shift with it): one notch, one page — no dragging.
    if (e.shiftKey || e.deltaMode !== 0) {
      const v = dx !== 0 ? dx : e.deltaY * unit;
      if (v === 0) return;
      if (row && canScroll(row, v)) this.scrollShelf(row, v);
      else if (now - this.lastNotch >= NOTCH_COOLDOWN_MS && this.stepTab(v > 0 ? 1 : -1)) this.lastNotch = now;
      return;
    }

    const scrolls = row != null && canScroll(row, dx);
    const step = this.pan.feed(dx, now, { scrolls, pos: this.pagePos(), width: this.pageW(), deltaMode: e.deltaMode });
    if (step.ended) this.panEnded(step.ended);
    if (step.kind === "scroll" && row) this.scrollShelf(row, dx);
    else if (step.kind === "drag" && !reducedMotion()) this.dragTo(step.pos);
    this.armPan();
  }

  /** Where the page is: under the fingers or on its way while paging, else at the tab on show. */
  private pagePos(): number {
    return this.paging ? this.pos : State.view === "shelf" ? this.pageW() : 0;
  }

  /** The gesture's one timer: to when its fingers may be up, then to when its tail may be over. */
  private armPan() {
    if (this.panTimer != null) window.clearTimeout(this.panTimer);
    this.panTimer = null;
    const due = this.pan.due();
    if (due == null) return;
    this.panTimer = window.setTimeout(() => {
      this.panTimer = null;
      const end = this.pan.poll(performance.now());
      if (end) this.panEnded(end);
      this.armPan();
    }, Math.max(0, due - performance.now()) + 4);
  }

  /** The fingers are up: the page goes where the gesture said, on the island's spring, from where it is. */
  private panEnded(end: PanEnd) {
    if (State.mode !== "expanded" || !TAB_VIEWS.has(State.view)) return;
    if (end.decision === "row-scroll") return;
    if (end.decision === "page") Sound.play("blip");
    if (this.paging) {
      this.settleTo(end.target, clamp(end.velocity * 1000, -PAGE_MAX_VELOCITY, PAGE_MAX_VELOCITY));
    } else if (end.decision === "page") {
      // Motion reduced: it was not followed; the tab changes now, with a short cross-fade.
      this.setView(end.target === 1 ? "shelf" : State.defaultView());
    }
  }

  /** The Shelf's row, when the Shelf is at rest on show and the pointer is anywhere on its view: what a sideways swipe there scrolls. */
  private shelfRow(x: number, y: number): HTMLElement | null {
    if (State.view !== "shelf" || this.paging || !within(this.viewsEl.getBoundingClientRect(), x, y)) return null;
    return this.views.get("shelf")?.el.querySelector<HTMLElement>(".shelf-row") ?? null;
  }

  /** Moves the row by one event's travel; once the events have paused, it comes to rest on a card. */
  private scrollShelf(row: HTMLElement, dx: number) {
    scrollRow(row, dx);
    if (this.rowSettle != null) window.clearTimeout(this.rowSettle);
    this.rowSettle = window.setTimeout(() => {
      this.rowSettle = null;
      settleRow(row, reducedMotion());
    }, ROW_SETTLE_MS);
  }

  // ── The Shelf's widgets ─────────────────────────────────────────────────────

  /** A swipe to the right over an expanded widget: back to the row — once for a gesture, and not again for a moment. */
  private swipeBack(dx: number, now: number) {
    const s = this.backSwipe;
    if (now < s.until) return;
    // The events stopped for a moment: another gesture.
    if (now - s.last > 180) {
      s.sum = 0;
      s.peak = 0;
    }
    s.last = now;
    s.sum += dx;
    s.peak = Math.max(s.peak, Math.abs(dx));
    // Either way: a sideways swipe over an expanded widget closes it, and does nothing else.
    if (Math.abs(s.sum) < BACK_SWIPE_PX) return;
    this.backTail.start(Math.sign(s.sum), s.peak, now);
    s.sum = 0;
    s.peak = 0;
    s.until = now + BACK_SWIPE_COOLDOWN_MS;
    this.pan.cancel();
    this.closeWidget();
  }

  /** Back from an expanded widget to the row, with the morph. False when none was expanded. */
  private closeWidget(): boolean {
    if (State.mode !== "expanded" || State.view !== "shelf" || !this.shelf.focused) return false;
    Sound.play("blip");
    State.lastActivity = performance.now();
    return this.shelf.closeWidget();
  }

  /**
   * A timer ran out, a reminder is due: the island comes up on that widget,
   * expanded. A card that asks something is never covered by it — a request
   * always wins: the widget is made ready, and is there when the card is done
   * with (`overShelf`); nothing of it approves or answers anything.
   */
  private widgetDue(id: ShelfWidgetId) {
    if (!widgetOn(id)) return;
    this.shelf.showWidget(id);
    const over = State.mode === "expanded" && (CARD_VIEWS.has(State.view) || State.pendingApproval != null || State.pendingQuestion != null);
    if (over) {
      this.overShelf = this.overShelf || CARD_VIEWS.has(State.view);
      return;
    }
    this.alert("shelf");
  }

  /**
   * The bar steps aside for an expanded widget, which is the whole island:
   * written with the view, and again at once when a morph changes the page.
   */
  private syncBare() {
    this.contentEl.classList.toggle("bare", State.mode === "expanded" && State.view === "shelf" && this.shelf.bare);
  }

  /**
   * A text field of the Shelf has the keyboard: the island is kept open for
   * it, as a card that asks is, so that it does not fold under what is being
   * typed when the pointer has gone. Given up when the field lets go — and
   * never while a request or the panel the shortcut opened holds it open itself.
   */
  private holdWhileTyping(on: boolean) {
    if (on && (State.mode !== "expanded" || State.view !== "shelf")) return;
    if (on === this.typingPin) return;
    this.typingPin = on;
    const holds = State.pendingApproval != null || State.pendingQuestion != null || this.summoned;
    if (holds) return;
    State.isPinned = on;
    this.fsm.pinned = on;
    if (!on && !this.wasInIsland && State.mode === "expanded") this.fsm.mouseLeft();
  }

  /**
   * A change of the Shelf drawn as a shared-element transition (views/shelf.ts
   * has the elements that are shared). The browser draws the in-between from
   * its snapshots of the old page and the new; the page itself is already in
   * its final state, and so is the island's size — which is why the island's
   * own boxes (`#island`) are one of the shared elements: the browser moves
   * and grows that box, on the island's spring, as the island grows between
   * views. False where it cannot be done (no View Transitions, motion reduced).
   */
  private morph(change: () => void, names: MorphNames, open: boolean): boolean {
    const start = (document as Document & { startViewTransition?: (update: () => void) => { finished: Promise<unknown>; skipTransition(): void } }).startViewTransition;
    if (typeof start !== "function" || reducedMotion() || State.mode !== "expanded") return false;
    this.endMorph();
    ensureMorphCurve();
    const root = document.documentElement;
    root.classList.toggle("vt-open", open);
    root.classList.toggle("vt-back", !open);
    this.islandEl.style.setProperty("view-transition-name", "island");
    names.before();

    let applied = false;
    const apply = () => {
      if (applied) return;
      applied = true;
      this.islandEl.classList.add("no-anim");
      change();
      // The island is at its new size now, not on its way: the transition draws the way.
      this.syncBare();
      // Expanded by a tap: Escape is the way back, and the window hears no key unless it is asked for (as the large panel does).
      this.wantKeyboard("panel", this.shelf.focused != null);
      this.jumpGeometry();
      this.applyGeometry();
      names.after();
    };
    const transition = start.call(document, apply);
    const end = () => {
      if (this.morphEnd !== end) return;
      this.morphEnd = null;
      apply(); // if the browser had not got to it yet
      try {
        transition.skipTransition();
      } catch {
        /* it was over already */
      }
      names.clear();
      this.islandEl.style.removeProperty("view-transition-name");
      this.islandEl.classList.remove("no-anim");
      root.classList.remove("vt-open", "vt-back");
      State.notify();
    };
    this.morphEnd = end;
    transition.finished.catch(() => {}).then(end);
    // The island's size is moved by the browser from here: no frame of ours is wanted for it.
    return true;
  }

  /** A transition in flight is finished at once: the island folds, another view is asked for. */
  private endMorph() {
    this.morphEnd?.();
  }

  // ── Paging between the tabs ─────────────────────────────────────────────────

  private homeName(): IslandViewName {
    return State.view === "shelf" ? State.defaultView() : State.view;
  }

  /** How far the page travels between the tabs, px: the Shelf's width, so that it follows the fingers 1:1. */
  private pageW(): number {
    return shelfWidth();
  }

  /** Both tabs on the stage, side by side, at `pos`: what the page follows the fingers with. */
  private beginPaging(pos: number) {
    if (this.paging) return;
    if (this.pageClear != null) window.clearTimeout(this.pageClear);
    this.pageClear = null;
    this.paging = true;
    this.springing = false;
    this.pos = pos;
    this.viewsEl.classList.add("pg");
    const other = State.view === "shelf" ? this.homeName() : "shelf";
    const incoming = this.views.get(other);
    incoming?.arm?.();
    incoming?.sync();
    this.ensureRunning();
  }

  /** The fingers move the page: it is at `pos`, now. */
  private dragTo(pos: number) {
    this.beginPaging(this.pagePos());
    this.springing = false;
    this.pos = pos;
    this.ensureRunning();
  }

  /** A click, a key: to the page, from where it is, on the same spring. */
  private pageTo(target: 0 | 1) {
    this.pan.cancel();
    if (this.panTimer != null) window.clearTimeout(this.panTimer);
    this.panTimer = null;
    this.beginPaging(this.pagePos());
    this.settleTo(target, 0);
  }

  private settleTo(target: 0 | 1, velocity: number) {
    this.pageTarget = target;
    this.pageSpring.configure(0.5, 0.72);
    this.pageSpring.value = this.pos;
    this.pageSpring.velocity = velocity;
    this.pageSpring.target = target * this.pageW();
    this.springing = true;
    this.ensureRunning();
  }

  /** Once per frame while paging: the spring, if it is moving the page, then the page itself. */
  private stepPaging(dt: number) {
    if (!this.paging) return;
    if (this.springing) {
      this.pageSpring.step(dt);
      this.pos = this.pageSpring.value;
      // Near enough not to be seen moving: the page is there. The spring's own last
      // hundredths of a pixel took most of a second, and the Shelf's row could not be
      // scrolled until they were over.
      const close = Math.abs(this.pageSpring.target - this.pos) < 0.5 && Math.abs(this.pageSpring.velocity) < 20;
      if (close || this.pageSpring.settled) {
        this.pos = this.pageTarget * this.pageW();
        this.commitPaging(this.pageTarget);
        return;
      }
    }
    this.applyPaging();
  }

  /** The two views at their places, the island as tall and wide as the page between them says, the bot with Home. */
  private applyPaging() {
    // The page is `pos` px along: the views follow it 1:1, and the island is as wide as the two
    // widths say for how far along it is. Each view is laid out once, at its own final width —
    // a view as wide as the island would be laid out again on every frame, and the paging
    // would stutter. Home's edge and the Shelf's meet at the island's width at that moment.
    const p = clamp(this.pos / this.pageW(), 0, 1);
    const home = this.homeName();
    const hv = this.views.get(home);
    const sv = this.views.get("shelf");
    const a = this.sizeFor(home);
    const b = this.sizeFor("shelf");
    const w = a.w + (b.w - a.w) * p;
    if (hv) hv.el.style.transform = `translateX(${-this.pos}px)`;
    if (sv) sv.el.style.transform = `translateX(${w - this.pos}px)`;
    for (const [v, size] of [[hv, a], [sv, b]] as const) {
      if (!v) continue;
      v.el.style.opacity = "1";
      v.el.style.right = "auto";
      v.el.style.width = `${size.w - 2 * PAGE_SIDE_PAD}px`;
    }
    this.width.jump(w);
    this.height.jump(a.h + (b.h - a.h) * p);
  }

  /** The page has come to rest on `page`: that tab is the view, the stage is cleared, and Rust is told the shape. */
  private commitPaging(page: 0 | 1) {
    const view = page === 1 ? "shelf" : State.defaultView();
    this.endStage();
    if (view !== State.view) {
      this.views.get(view)?.arm?.();
      this.show(view);
    }
    this.animateGeometry(false);
    // The shape may be as it was (a snap back) or taller or shorter: Rust decides click-through again either way.
    this.forceRect = true;
    State.lastActivity = performance.now();
    State.notify();
  }

  /** The stage is cleared: each view back to the stylesheet's. Transitions stay off a moment, so nothing fades back in. */
  private endStage() {
    this.paging = false;
    this.springing = false;
    for (const v of this.views.values()) {
      v.el.style.transform = "";
      v.el.style.opacity = "";
      v.el.style.right = "";
      v.el.style.width = "";
    }
    if (this.pageClear != null) window.clearTimeout(this.pageClear);
    this.pageClear = window.setTimeout(() => {
      this.pageClear = null;
      this.viewsEl.classList.remove("pg");
    }, 80);
  }

  /** Something else is to be shown, or the island folds: a swipe under way is dropped, the view stays as it was. */
  private abortPaging() {
    this.pan.cancel();
    if (this.panTimer != null) window.clearTimeout(this.panTimer);
    this.panTimer = null;
    if (!this.paging) return;
    this.endStage();
    // No view to wait for: the stage is clear at once.
    if (this.pageClear != null) window.clearTimeout(this.pageClear);
    this.pageClear = null;
    this.viewsEl.classList.remove("pg");
  }

  // ── The session panel: its size, and the keyboard ───────────────────────────

  /**
   * The session panel at its large size, or back at its normal one. Going
   * large takes the keyboard: Escape is the way back, and the island's window
   * hears no key otherwise.
   */
  setLarge(on: boolean) {
    const large = on && State.mode === "expanded" && State.view === "session";
    if (large === State.large) return;
    State.large = large;
    Sound.play("blip");
    State.lastActivity = performance.now();
    this.wantKeyboard("panel", large);
    // With motion reduced, the panel is at its new size at once.
    if (reducedMotion()) this.jumpGeometry();
    else this.animateGeometry(!large);
    if (!large) this.releaseSummon();
    State.notify();
  }

  /**
   * The panel's other size: what its button does, and so what a double click
   * on its empty space, a pinch and Space do — one way through `setLarge`,
   * one animation. Nothing happens unless the panel is the view on show.
   */
  togglePanel() {
    if (State.mode === "expanded" && State.view === "session") this.setLarge(!State.large);
  }

  /**
   * The global shortcut, from anywhere: the panel large — the island revealed
   * and opened on the session in front if it was hidden, folded or on another
   * view — or, large already, back to its normal size.
   */
  summonPanel() {
    const onPanel = State.mode === "expanded" && State.view === "session";
    if (onPanel && State.large) {
      this.setLarge(false);
      return;
    }
    // Called from the keyboard, the pointer is likely elsewhere: the island
    // stays open for as long as it has the keyboard, rather than folding on
    // its own a few seconds later. It ends when the panel is shrunk or left,
    // and when the user goes elsewhere — another window, a click outside the
    // island (`dismissSummoned`).
    if (!onPanel) {
      if (State.focusId !== CLAUDE_ID) State.setFocus(CLAUDE_ID);
      enterSessionPanel("journal");
      this.alert("session");
    }
    this.summoned = true;
    State.isPinned = true;
    this.fsm.pinned = true;
    this.fsm.cancelTimers();
    this.homeCollapseAt = null;
    this.setLarge(true);
    // The keyboard could not be taken (the window did not come forward): there
    // will be no blur to end this by, so the island closes on its usual timer
    // instead of staying up for good.
    if (this.summonCheck != null) window.clearTimeout(this.summonCheck);
    this.summonCheck = window.setTimeout(() => {
      this.summonCheck = null;
      if (this.summoned && !document.hasFocus()) this.releaseSummon();
    }, SUMMON_FOCUS_MS);
  }

  /**
   * The second global shortcut, from anywhere: the session panel at its NORMAL
   * size, with the keyboard taken (Space expands it, Tab steps, Escape folds).
   * Hidden, folded or on another view, the island is revealed and opened on the
   * session in front; on the panel at its normal size it is pressed again to
   * fold the island away, as `summonPanel` shrinks a large one; on the large
   * panel it shrinks it, keeping the keyboard. A request waiting on the user is
   * never covered: its card is shown instead and the panel is not opened.
   */
  summonPanelNormal() {
    const waiting = State.pendingQuestion ? "question" : State.pendingApproval ? "approval" : null;
    if (waiting) {
      if (State.focusId !== CLAUDE_ID) State.setFocus(CLAUDE_ID);
      if (State.mode !== "expanded" || State.view !== waiting) {
        State.isPinned = true;
        this.alert(waiting);
      }
      return;
    }
    const onPanel = State.mode === "expanded" && State.view === "session";
    if (onPanel && !State.large) {
      // Already there, at its normal size: the island is let go and folds.
      this.releaseSummon();
      this.wantKeyboard("panel", false);
      this.stepAside();
      return;
    }
    if (onPanel) {
      // Large: back to normal. It gives the keyboard and the summon up on the
      // way (`setLarge`), and both are taken again below.
      this.setLarge(false);
    } else {
      if (State.focusId !== CLAUDE_ID) State.setFocus(CLAUDE_ID);
      enterSessionPanel("journal");
      this.alert("session");
    }
    // As `summonPanel`: held open for as long as it has the keyboard.
    this.summoned = true;
    State.isPinned = true;
    this.fsm.pinned = true;
    this.fsm.cancelTimers();
    this.homeCollapseAt = null;
    this.wantKeyboard("panel", true);
    if (this.summonCheck != null) window.clearTimeout(this.summonCheck);
    this.summonCheck = window.setTimeout(() => {
      this.summonCheck = null;
      if (this.summoned && !document.hasFocus()) {
        this.releaseSummon();
        this.wantKeyboard("panel", false);
      }
    }, SUMMON_FOCUS_MS);
  }

  /**
   * The user went elsewhere while the panel the shortcut opened was up — the
   * island's window lost the keyboard, or a click landed outside the island:
   * the island retracts, as one left alone does in the end. Never with a
   * request waiting on it: that keeps the island open, as it always does.
   */
  private dismissSummoned() {
    if (!this.summoned) return;
    const waits = State.pendingApproval != null || State.pendingQuestion != null;
    this.releaseSummon();
    if (waits || State.mode === "hidden") return;
    State.isPinned = false;
    this.fsm.pinned = false;
    this.fsm.forceHidden();
    if (reducedMotion()) this.jumpGeometry();
  }

  /** The panel the shortcut opened is shrunk or left: the island closes on its own again, unless a request keeps it open. */
  private releaseSummon() {
    if (!this.summoned) return;
    this.summoned = false;
    const waits = State.pendingApproval != null || State.pendingQuestion != null;
    State.isPinned = waits;
    this.fsm.pinned = waits;
    if (!waits && !this.wasInIsland) this.fsm.mouseLeft();
  }

  /** A view that is about no session comes on show: what Tab held from one session to the next is let go. */
  private leaveSessions(view: IslandViewName) {
    if (ABOUT_SESSION.has(view)) return;
    this.stepLarge = false;
    this.wantKeyboard("cards", false);
  }

  /** The panel is no longer the view on show: it is not large any more, and wants no key. */
  private leavePanel() {
    State.large = false;
    this.wantKeyboard("panel", false);
    this.releaseSummon();
  }

  /** Takes the keyboard for one more reason, or lets go of that reason: the window is told only when it changes hands. */
  private wantKeyboard(why: "field" | "panel" | "cards" | "kept", on: boolean) {
    const had = this.keyboard.size > 0;
    if (on) this.keyboard.add(why);
    else this.keyboard.delete(why);
    const has = this.keyboard.size > 0;
    if (has !== had) void Bridge.focusWindow(has);
  }

  /** The island folds, or the user went to another window: whatever wanted the keyboard, it is given back. */
  private releaseKeyboard() {
    const had = this.keyboard.size > 0;
    this.keyboard.clear();
    // Told even when nothing was held: it only makes sure the window does not activate.
    if (had || State.mode !== "expanded") void Bridge.focusWindow(false);
  }

  /** From the session panel, back to the card of the request its session is waiting on. */
  private showRequest() {
    const session = State.session;
    if (!session.question && !session.approval) return;
    Sound.play("blip");
    State.isPinned = true;
    this.fsm.pinned = true;
    this.setView(session.question ? "question" : "approval");
  }

  /** Writes what was decided on the island in the journal, on the step that was waiting for it. */
  private noteOutcome(request: SessionRequest, write: (step: SessionStep) => void) {
    if (request.step) write(request.step);
  }

  /**
   * The request on the card got its answer: the next one of its session takes
   * the card, or the session is back at work.
   */
  private settleRequest() {
    nextRequest(State.session);
    this.afterRequest(true);
  }

  /**
   * The request of the session in front is done with. Another session waiting
   * for an answer comes forward with its own; with none, the island is free
   * to close again. `show` moves the view too: to that card, or back to the
   * overview.
   */
  afterRequest(show: boolean) {
    const next = State.pendingApproval || State.pendingQuestion ? State.session : State.waiting[0];
    if (next) State.bringForward(next.id);
    State.isPinned = next != null;
    this.fsm.pinned = next != null;
    State.setPillBadge(CLAUDE_ID, next && State.focusId !== CLAUDE_ID ? "approval" : null);
    State.present();
    // With no request left, back to where the user was: the Shelf, when the card came up over it.
    if (show) this.setView(next ? (next.question ? "question" : "approval") : this.restView());
  }

  /**
   * Puts another session in front, at the user's asking: its card if it is
   * waiting for an answer, and never the card of the one that was there.
   */
  private pickSession(id: string) {
    if (id === State.frontId) return;
    Sound.play("blip");
    // The list of sessions is reached whatever pill is in front: picking one is asking for Claude's.
    if (State.focusId !== CLAUDE_ID) State.setFocus(CLAUDE_ID);
    State.bringForward(id);
    const session = State.session;
    const waits = session.question != null || session.approval != null;
    State.isPinned = waits;
    this.fsm.pinned = waits;
    if (waits) this.setView(session.question ? "question" : "approval");
    else if (State.view === "approval" || State.view === "question") this.setView(State.defaultView());
  }

  /**
   * Tab and Shift+Tab: the next session, or the one before, in the sidebar's
   * order — which never reshuffles — round and round. In the panel it is
   * picked as a click on its line picks it (the panel's own `step`); a session
   * that is waiting for an answer shows its card instead, and Tab goes on from
   * that card to the next session all the same. The keyboard stays the
   * island's across the step, and a panel the shortcut opened stays one.
   */
  private stepSession(by: number) {
    const all = State.sessions;
    if (all.length < 2) return;
    const summoned = this.summoned;
    const large = State.large || this.stepLarge;
    // Held across the step: leaving the panel for a card must not hand the keyboard back in between.
    if (this.keyboard.size > 0) this.wantKeyboard("cards", true);
    if (State.view === "session") this.views.get("session")?.step?.(by);
    else {
      const at = all.findIndex((s) => s.id === State.frontId);
      this.openSessionOf(all[(Math.max(0, at) + by + all.length) % all.length].id);
    }
    // The panel keeps the size it had, through a card on the way too.
    this.stepLarge = large && State.view !== "session";
    if (large && State.view === "session" && !State.large) this.setLarge(true);
    if (summoned && !this.summoned && State.mode === "expanded") {
      this.summoned = true;
      State.isPinned = true;
      this.fsm.pinned = true;
      this.fsm.cancelTimers();
    }
  }

  /**
   * From the home view, a session picked by its mini bot: it comes in front,
   * and its panel opens — or, when it is waiting for an answer, the card that
   * asks, which is what it needs. Its result, if it had one waiting, is seen.
   * The card arms its buttons as it comes on show (`setView`): the click that
   * opened it is never the click that answers it.
   */
  private openSessionOf(id: string) {
    const session = State.sessions.find((s) => s.id === id);
    if (!session) return;
    Sound.play("blip");
    if (State.focusId !== CLAUDE_ID) State.setFocus(CLAUDE_ID);
    if (id !== State.frontId) State.bringForward(id);
    session.unseen = false;
    const waits = session.question != null || session.approval != null;
    State.isPinned = waits;
    this.fsm.pinned = waits;
    if (waits) {
      this.setView(session.question ? "question" : "approval");
      return;
    }
    // One whose last reply waits on a decision is opened to read it: whole.
    enterSessionPanel("journal", session.decision);
    this.setView("session");
    // Opened by hand: the panel takes the keyboard, so that Space and Escape
    // work at once. It is given back when the panel is left or the island folds.
    this.wantKeyboard("panel", true);
  }

  /**
   * Where the session in front runs: its editor's window, its terminal's, the
   * Claude app. Only the session is named: Nook knows where each one runs, and
   * one it knows nothing of has no button to get here by.
   */
  private openClient(session: ClaudeSession = State.session) {
    if (!session.id || session.target.kind === "unknown") return false;
    // Once the window is in front the user is there, not here: the island
    // folds at once. With no window to go to, it stays, so that nothing
    // having happened can be seen.
    void Bridge.focusSession(session.id).then((went) => {
      if (went) this.stepAside();
      else this.nowhere();
    });
    return true;
  }

  /**
   * The global shortcut, from anywhere: to the window of the session that most
   * needs the user — one that is asking, the one that has waited longest
   * first; else one that stopped on an error; else the one in front — and the
   * island out of the way, as its ↗ does. With nowhere to go, nothing but a
   * quiet cue on the island, and a line in the log.
   */
  goToNeedy() {
    const asked = (s: ClaudeSession) => (s.approval ?? s.question)?.askedAt ?? 0;
    const asking = State.sessions.filter((s) => s.approval != null || s.question != null).sort((a, b) => asked(a) - asked(b))[0];
    const failed = State.sessions.find((s) => s.state === "error" || s.news === "error");
    const session = asking ?? failed ?? (State.session.id ? State.session : null);
    if (session && this.openClient(session)) return;
    void Bridge.log(session ? "go to session: nothing known of where it runs" : "go to session: no session");
    this.nowhere();
  }

  /** There was nowhere to go: the island, if it is on show, says so with a blink and nothing else — no sound, no card. */
  private nowhere() {
    if (State.mode === "hidden") return;
    this.clipEl.classList.remove("nowhere");
    // Read, so that taking the class off and putting it back plays the blink again.
    void this.clipEl.offsetWidth;
    this.clipEl.classList.add("nowhere");
    window.setTimeout(() => this.clipEl.classList.remove("nowhere"), 500);
  }

  /**
   * Out of the way of the window the user just went to: the panel leaves its
   * large size, the keyboard is given back, and the island folds — now, on its
   * usual closing curve (at once with motion reduced). Even with a request
   * waiting: it is being gone to, to be answered where it was asked. Nothing
   * of it is declined or dropped — it is still the session's, its card is back
   * when the island is opened again, and it clears as any other does when it
   * is answered in Claude Code.
   */
  private stepAside() {
    if (State.mode !== "expanded") return;
    this.collapse();
    if (reducedMotion()) this.jumpGeometry();
  }

  collapse() {
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
    // Folded over a full-screen app — a request was just answered there: out of its way.
    this.yieldToFullscreen();
  }

  /**
   * Alert from the hook server: open on this view. Pinned alerts never auto-close.
   * A request — a permission, a question — always shows, whatever is in front:
   * it must be answerable. A card that only tells something (a turn's end, an
   * error) does not bring a hidden island up over a full-screen app.
   */
  alert(view: IslandViewName) {
    const open = () => {
      this.fsm.pinned = State.isPinned;
      this.fsm.forceHome();
      this.expand(view);
    };
    if (State.mode === "hidden" && NOTICE_VIEWS.has(view)) this.wake(open);
    else open();
  }

  /** A work event: the hidden island shows folded — unless a full-screen app is in front. */
  reveal() {
    if (this.fsm.state === "hidden") this.wake(() => this.fsm.reveal());
  }

  // ── Full-screen apps (Settings → Island → Visibility) ───────────────────────

  /**
   * Brings the hidden island up, by `how` — unless Settings say to stay out of
   * full-screen apps and one is in front on the island's display. Rust is
   * asked at this moment, and at no other while the island is hidden: nothing
   * polls behind a hidden island. Off in Settings, or in a plain browser, it
   * is `how` at once.
   */
  private wake(how: () => void) {
    if (!State.settings.hideInFullscreen || !IS_TAURI) {
      how();
      return;
    }
    void Bridge.fullscreenNow().then((full) => {
      this.fullscreen = full === true;
      if (!this.fullscreen) how();
    });
  }

  /** Rust's poll, while the island is on show: a full-screen app came in front, or left. */
  onFullscreen(full: boolean) {
    this.fullscreen = full;
    this.yieldToFullscreen();
  }

  /**
   * The island gets out of the way of a full-screen app that is in front —
   * never while a request waits for an answer, on any session: that card stays
   * until it is answered. It leaves on its usual closing curve.
   */
  private yieldToFullscreen() {
    if (!this.fullscreen || !State.settings.hideInFullscreen || State.mode === "hidden") return;
    if (State.sessions.some((s) => s.approval != null || s.question != null)) return;
    State.isPinned = false;
    this.fsm.pinned = false;
    this.releaseSummon();
    this.fsm.forceHidden();
    if (reducedMotion()) this.jumpGeometry();
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  /** The island's size on show for a view, open. */
  private sizeFor(view: IslandViewName): { w: number; h: number } {
    const proposal = State.pendingApproval?.proposal != null;
    const fitted = this.views?.get(view)?.height ?? null;
    const fittedW = this.views?.get(view)?.width ?? null;
    return islandSize("expanded", view, proposal, fitted, State.large, this.compactW, fittedW);
  }

  private targetSize(): { w: number; h: number; r: number; ear: number } {
    const proposal = State.pendingApproval?.proposal != null;
    // A view that knows how tall its content is has the last word.
    const fitted = this.views?.get(State.view)?.height ?? null;
    const fittedW = this.views?.get(State.view)?.width ?? null;
    // Folded, the island is as wide as what it holds: its slots, each of a fixed width, under the cap.
    if (State.mode === "compact") this.compactW = compactPlan().width;
    const { w, h } = islandSize(State.mode, State.view, proposal, fitted, State.large, this.compactW, fittedW);
    const expanded = State.mode === "expanded";
    const r = expanded ? EXPANDED_CORNER : ROUNDED_CORNER;
    // Retracted, there is no island to flare into the edge.
    const ear = State.mode === "hidden" ? 0 : expanded ? EAR_EXPANDED : EAR_COMPACT;
    return { w, h, r, ear };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r, ear } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
      this.ear.curveTowards(ear);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
      this.ear.springTo(ear);
    }
    this.ensureRunning();
  }

  /** The island at its size at once, the bot in its place: what stands for the spring when motion is reduced. */
  private jumpGeometry() {
    const { w, h, r, ear } = this.targetSize();
    this.width.jump(w);
    this.height.jump(h);
    this.radius.jump(r);
    this.ear.jump(ear);
    const p = botPosition(State.mode, State.view, h, State.large);
    this.botCx.set(p.cx);
    this.botCy.set(p.cy);
    this.botSize.set(p.diameter / 0.6);
    this.ensureRunning();
  }

  /**
   * The island's body as it is drawn: on whole pixels of the screen. Its
   * middle is the window's, on a whole pixel; its width an even number of
   * them, so both upright edges land on one too; and so does its lower edge.
   * At 125 % scaling a width or a place left as the spring gives it would fall
   * between two pixels, and the outline's edges would be drawn soft.
   *
   * `translateX(-50%)` used to put the island on a fraction of a pixel for as
   * long as its width was animating, and whatever was painted then in a layer
   * of its own — a scrolling list, say — kept that fraction once the island
   * had settled: its text stayed smeared until it was drawn again.
   */
  private snapped(): { x: number; w: number; h: number; shift: number; dpr: number } {
    const real = window.devicePixelRatio || 1;
    const dpr = real * Display.zoom;
    const half = Math.round((this.width.value / 2) * dpr);
    const w = (2 * half) / dpr;
    const hh = Math.round(this.height.value * dpr) / dpr;
    const centre = (this.windowW * dpr) / 2;
    // From `left: 50%` to the island's left edge.
    const shift = (Math.round(centre) - centre - half) / dpr;
    return { x: this.windowW / 2 + shift, w, h: hh, shift, dpr };
  }

  private applyGeometry() {
    const { x, w, h: hh, shift, dpr } = this.snapped();
    const r = this.radius.value;
    put(this.islandEl, "width", `${w}px`);
    put(this.islandEl, "height", `${hh}px`);
    put(this.islandEl, "border-radius", `0 0 ${r}px ${r}px`);
    put(this.islandEl, "transform", `translateX(${shift}px)`);
    // The outline: the body, and an ear on each side where it meets the top
    // edge — never wider than what the window has beside the island.
    // An ear at rest ends on a whole pixel too: 11 px is 13.75 at 125 %, and
    // its tip would be drawn a soft quarter of a pixel past the island.
    const ear = this.ear.animating ? this.ear.value : Math.round(this.ear.value * dpr) / dpr;
    this.shape.draw({ w, h: hh, ear: Math.min(ear, Math.max(0, x)), corner: r });
    // This follows the island as it resizes, so it belongs here rather than in
    // the state-driven DOM sync.
    put(this.greetingCanvas, "left", `${(w - EXPANDED_W) / 2}px`);

    // What takes the mouse is the body. The ears are decoration, and are not
    // counted: Rust takes the mouse a few pixels around the rectangle anyway
    // (HIT_MARGIN), which covers all of a folded island's ears and most of an
    // open one's — and a click on one does nothing, like a click on the rest
    // of that margin.
    const rect = { x, y: 0, w, h: hh };
    const p = this.pushedRect;
    if (this.forceRect || Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.forceRect = false;
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Island rect in window coordinates (origin top-left of the full window). */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const { x, w, h: hh } = this.snapped();
    return { x, y: 0, w, h: hh };
  }

  /**
   * The width the island is centred in: its window's, at full size — the size
   * Rust gave it, not what the page measures, which is the wake strip's while
   * the island is hidden. In a plain browser, the page's.
   */
  private get windowW(): number {
    return IS_TAURI ? Room.w : window.innerWidth / Display.zoom;
  }

  /**
   * The display's logical width, from Rust: at boot, and when the display
   * changes. It caps the folded island (layout.ts `compactCap`).
   */
  setScreenWidth(width: number) {
    if (!(width > 0) || width === Display.w) return;
    Display.w = width;
    State.notify();
  }

  /**
   * The window's size on this display, from Rust: at boot, and again when the
   * display changes. The island is centred in it, and the large panel fills it.
   */
  setRoom(width: number, height: number) {
    Room.w = Math.max(PANEL_W, width);
    Room.h = Math.max(PANEL_H, height);
    // Whatever was pushed was centred in the window as it was.
    this.pushedRect = { x: -1, y: -1, w: -1, h: -1 };
    if (State.large) this.animateGeometry(false);
    this.dirty = true;
    this.ensureRunning();
  }

  /** In a plain browser the page stands for the window: the large panel is cut to what it shows. */
  private followPageSize() {
    const fit = () =>
      this.setRoom(
        Math.min(LARGE_W + OVERSHOOT_W, window.innerWidth - PAGE_MARGIN_W),
        Math.min(LARGE_H + OVERSHOOT_H, window.innerHeight - PAGE_MARGIN_H),
      );
    window.addEventListener("resize", fit);
    fit();
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting, then drop the window to the wake strip:
      // from there the OS delivers no cursor events, so nothing polls at all.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setCollapsed(true);
      }, 420);
    } else if (this.collapsed) {
      // Grow the window back before the island animates open.
      this.collapsed = false;
      // The first frames of a wake are drawn in a window that is still the
      // strip: once it has grown, the island is drawn again, whole.
      void Bridge.setCollapsed(false).then(() => this.redrawGrown());
      // The window's new size reaches the page a little after Rust has answered.
      window.addEventListener("resize", () => this.redrawGrown(), { once: true });
    }
  }

  /** The window is whole again: the folded slots are built anew in it, and the island drawn again. */
  private redrawGrown() {
    if (State.mode === "hidden") return;
    this.compact.redraw(compactPlan());
    this.dirty = true;
    this.ensureRunning();
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is hidden.
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      if (State.mode === "hidden") this.wake(() => this.fsm.mouseEntered());
    });

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      if (State.mode !== "expanded") {
        this.fsm.click();
        return;
      }
      // The user went to another window and came back to the large panel: its
      // Escape works again from the first click on it.
      if (State.large || (State.view === "shelf" && this.shelf.focused)) this.wantKeyboard("panel", true);
      this.clickBot(e.clientX / Display.zoom, e.clientY / Display.zoom);
    });

    // Escape, in one place, for whatever is on show — the innermost thing
    // first: a text field being typed in closes itself; then the large panel
    // goes back to its normal size; then a subagent's view to its session;
    // then the island folds. On the window and on the way down, so that no
    // view drawn again and no element taking or losing the focus can leave a
    // key unheard: a listener on something the panel rebuilds would go with it.
    // None of it fires unless the window has the keyboard (see `keyboard`).
    //
    // Every key the island acts on goes through here, in this order: Ctrl with
    // a zoom key is swallowed (the island is never zoomed); a key typed in a
    // text field is the field's; Escape, as above; then Space, which toggles
    // the panel's size — always, whatever in the panel has the focus: a line
    // of the sidebar's tree does not use it (Enter opens a line), and a button
    // never keeps the focus a click gave it (see the mouse-down below). It is
    // taken here, on the way down, before whatever has the focus could.
    window.addEventListener("keydown", (e) => {
      State.lastActivity = performance.now();
      if ((e.ctrlKey || e.metaKey) && ZOOM_KEYS.has(e.key)) {
        e.preventDefault();
        return;
      }
      if (isField(e.target) || State.mode !== "expanded") return;
      if (e.key === "Escape") {
        if (State.large) this.setLarge(false);
        else if (State.view === "session" && leaveSubagent()) Sound.play("blip");
        // An expanded widget goes back to the row first; only then does Escape fold the island.
        else if (this.closeWidget()) { /* done */ }
        // Pinned only by the panel the shortcut opened (and no request): Escape folds it.
        else if (!State.isPinned || (this.summoned && State.pendingApproval == null && State.pendingQuestion == null)) this.collapse();
        else return;
        e.preventDefault();
        return;
      }
      // Backspace goes back to the home view: from the session panel (which
      // leaves its large size on the way), a subagent's view, the Shelf, the
      // settings card, a card that only tells something. The island stays
      // open and keeps the keyboard. Never from a card that asks: a request
      // is answered, not walked away from by a key. Always taken, so the
      // webview never goes "back".
      if (e.key === "Backspace" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        // An expanded widget goes back to the row first; the Shelf itself goes back to Home.
        if (this.closeWidget()) return;
        if (!BACK_HOME.has(State.view)) return;
        Sound.play("blip");
        // Held across the change: leaving the panel must not hand the keyboard back.
        this.wantKeyboard("kept", true);
        this.setView(State.defaultView());
        return;
      }
      // Tab is the next session, Shift+Tab the one before: taken here, so the
      // browser's own walk through what can hold the focus never runs inside
      // the island. In the panel it moves through the sidebar's sessions; on
      // the home view it opens the panel on the one that most needs attention.
      if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        if (ABOUT_SESSION.has(State.view)) this.stepSession(e.shiftKey ? -1 : 1);
        else if (State.view === "overview" && !e.repeat) {
          const urgent = roster().live.find((entry) => entry.session != null);
          if (urgent) this.openSessionOf(urgent.id);
        }
        // On the Shelf, Tab does nothing: it is kept for the widgets.
        return;
      }
      // Left and Right go from one tab to the other — on a tab's own view
      // only: in the session panel the arrows are the sidebar's, on a card
      // they are nobody's, and in a text field they never get this far.
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && TAB_VIEWS.has(State.view)) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) this.stepTab(e.key === "ArrowRight" ? 1 : -1);
        return;
      }
      if (e.key !== " " || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || State.view !== "session") return;
      // Held down, it toggles once; and it never scrolls the journal, nor
      // reaches what has the focus.
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) this.togglePanel();
    }, true);
    // A button with the focus is clicked when Space comes back up: not in the panel, where Space is its size.
    window.addEventListener("keyup", (e) => {
      if (e.key !== " " || isField(e.target) || State.mode !== "expanded" || State.view !== "session") return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    // A click on a button does not leave it with the focus: the next key is
    // the island's — Space, Escape — not that button's. The click itself is
    // untouched.
    this.islandEl.addEventListener("mousedown", (e) => {
      if (e.target instanceof Element && e.target.closest("button")) e.preventDefault();
    });

    // A double click on the island's bar, or on the panel's empty space,
    // toggles its size. Not on anything in it: a control, a row, a line of the
    // journal or words have clicks of their own, and a double click there is
    // two of those and nothing more.
    const onEmpty = (target: EventTarget | null) => target instanceof Element && target.matches(EMPTY_SPACE);
    this.islandEl.addEventListener("dblclick", (e) => {
      if (!onEmpty(e.target)) return;
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      this.togglePanel();
    });
    // The second press of a double click selects the nearest words: not from empty space.
    this.islandEl.addEventListener("mousedown", (e) => {
      if (e.detail > 1 && onEmpty(e.target)) e.preventDefault();
    });

    // A pinch on a trackpad: out for the large panel, in for the normal one.
    // It comes as wheel events with Ctrl held (and so does Ctrl with a mouse's
    // wheel): each is stopped here, wherever it lands, so the page is never
    // zoomed — which takes a listener that is not passive.
    // Without Ctrl, a swipe sideways goes from one tab to the other (`swipeTabs`).
    window.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) {
        this.swipeTabs(e);
        return;
      }
      e.preventDefault();
      if (State.mode !== "expanded" || State.view !== "session") return;
      const p = this.pinch;
      const now = performance.now();
      // The events stopped for a moment, and the last toggle is old enough: another gesture.
      if (now - p.last > PINCH_GAP_MS && now - p.toggledAt > PINCH_COOLDOWN_MS) {
        p.sum = 0;
        p.spent = false;
      }
      p.last = now;
      if (p.spent) return;
      p.sum += e.deltaY;
      if (Math.abs(p.sum) < PINCH_THRESHOLD) return;
      // Fingers apart scroll up, as zooming in does.
      const out = p.sum < 0;
      p.spent = true;
      p.toggledAt = now;
      p.sum = 0;
      if (out !== State.large) this.togglePanel();
    }, { passive: false, capture: true });

    // The user clicked another window: the keyboard is theirs, and the island's
    // window goes back to never taking it.
    // A panel the shortcut opened ends there too.
    window.addEventListener("blur", () => {
      this.releaseKeyboard();
      this.dismissSummoned();
    });
    // A click that lands outside the island (where the page takes it at all:
    // in the app the window lets it through, and the blur above says it).
    window.addEventListener("mousedown", (e) => {
      if (this.summoned && e.target instanceof Node && !this.islandEl.contains(e.target)) this.dismissSummoned();
    }, true);

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) {
      this.followPageCursor();
      this.followPageSize();
    }
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used where the OS has no global cursor position (Wayland): the events only
   * fire while the pointer is over the island, so leaving the window is
   * reported as a cursor far away, which is what the poll would have said.
   */
  followPageCursor() {
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX / Display.zoom, e.clientY / Display.zoom));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000, true);
    });
  }

  /** Cursor in window-logical coordinates. `gone`: it has no position any more (it left the page, with no global cursor). */
  onCursor(x: number, y: number, gone = false) {
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;

    if (inIsland && !this.wasInIsland) {
      if (this.fsm.state === "greeting") this.greeting.hover();
      // Hidden, the pointer at the top edge is a wake like the strip's: asked of Rust first.
      if (this.fsm.state === "hidden") this.wake(() => this.fsm.mouseEntered());
      else this.fsm.mouseEntered();
      this.homeCollapseAt = null;
    }
    if (!inIsland && this.wasInIsland) {
      this.fsm.mouseLeft();
      if (this.fsm.state === "home" && !State.isPinned) {
        this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
      }
    }
    this.wasInIsland = inIsland;

    // The bot: its eyes, and what it does about a cursor that comes near, stays, circles or leaves.
    this.seatBot();
    if (gone) this.gullu.pointerLeave();
    else this.gullu.pointerMove(x, y);
    // The home view's mini bots look at it too, while it is on the island.
    if (!gone && inIsland && State.mode === "expanded" && State.view === "overview") pointMiniBots(x * Display.zoom, y * Display.zoom);
    else leaveMiniBots();

    this.ensureRunning();
  }

  /** False on the Shelf, which has no bot: it is not drawn, takes no click, and keeps no frame going. */
  private get botOnShow(): boolean {
    return !(State.mode === "expanded" && State.view === "shelf");
  }

  /**
   * Tells the bot's reactions where it is — the middle of its slot and the
   * slot's diameter, in the cursor's coordinates — and whether it is on show at
   * all: hidden, on the Shelf or under the greeting, they do nothing and ask
   * for nothing.
   */
  private seatBot() {
    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    this.gullu.setVisible(State.mode !== "hidden" && this.botOnShow && !greetingActive);
    const rect = this.islandRect();
    this.gullu.place(rect.x + this.botCx.value, rect.y + this.botCy.value, this.botSize.value * 0.6);
  }

  /** A click on the open island, in the cursor's coordinates: the bot's, if it landed on it. */
  private clickBot(x: number, y: number) {
    this.seatBot();
    if (!this.gullu.visible || !this.gullu.hit(x, y)) return;
    // Five fast clicks make the bot dizzy — its own reaction, and nothing over the content.
    this.gullu.click(x, y);
  }

  /**
   * Playful reactions off, three slaps in a row: the bot wears the engine's
   * dizzy face for 3.3 s, with its sound, and is glad again after. No view
   * comes up for it (with them on, the bot's own dizzy plays the same way).
   */
  private handleDizzy() {
    State.stateOverride = "dizzy";
    this.gullu.setStatus("dizzy");
    Sound.play("dizzy");
    State.notify();
    if (this.dizzyRecovery != null) window.clearTimeout(this.dizzyRecovery);
    this.dizzyRecovery = window.setTimeout(() => {
      this.dizzyRecovery = null;
      State.stateOverride = null;
      this.gullu.setStatus(this.botState());
      this.engine.triggerEmote("happy");
      State.notify();
    }, 3300);
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    // The loop is back: whatever the bot's timer was waiting for is seen by its frames.
    this.armIdle();
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  /**
   * The bot at rest does something by itself now and then — a look around, a
   * yawn, a nap — and a hover that lasts is answered: none of it keeps the loop
   * going in between. With the loop stopped, one timer waits for the next of
   * them and starts it again; with the loop running, or the bot not on show
   * (`nextDue` is null then), there is none.
   */
  private armIdle() {
    if (this.idleTimer != null) window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.running) return;
    const home = State.mode === "expanded" && State.view === "overview";
    const bot = this.gullu.nextDue();
    const minis = home ? miniBotsNextDue() : null;
    const due = bot == null ? minis : minis == null ? bot : Math.min(bot, minis);
    if (due == null) return;
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      this.ensureRunning();
    }, Math.max(0, due - performance.now()) + 4);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(MAX_STEP, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    // The page first: its geometry (and, once settled, the shape to report) is this frame's.
    this.stepPaging(dt);
    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.ear.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.botStale = true;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      this.drawBot(dt);
    }

    // The mini bots are the home view's: they are ticked while it is on show,
    // and one that stands for a session at rest is not ticked at all.
    const home = State.mode === "expanded" && State.view === "overview";
    if (home) tickMiniBots(dt);
    this.views.get(State.view)?.tick?.(nowMs);
    this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. This used to read `... || this.engine.busy || State.mode !==
    // "hidden"`, and engine.busy is permanently true for any state with a
    // looping animation — the sprout's pulse at work, the eyes' sweep, breathing,
    // ratelimit sweat, sleeping z's — so a hidden island went on burning frames in exactly the states it
    // spends most of its life in. Geometry still has to finish retracting.
    const settling =
      this.paging || this.width.animating || this.height.animating || this.radius.animating || this.ear.animating;
    const busy = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.gullu.busy || (this.botOnShow && this.tintSettling) || (home && miniBotsLively());

    if (busy) {
      // Only the bot's own loop left — its pulse at work, its breathing: that
      // does not need every frame the display can give. Each frame redraws a
      // transparent window the size of the largest panel, so the island at work
      // took most of a core; a slower beat costs a fraction and reads the same.
      const moving =
        settling || (this.botOnShow && this.tintSettling) ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled;
      if (moving) requestAnimationFrame(this.frame);
      else window.setTimeout(() => requestAnimationFrame(this.frame), State.mode === "expanded" ? AMBIENT_MS : AMBIENT_FOLDED_MS);
    } else {
      this.running = false;
      Sound.idle();
      this.armIdle();
    }
  };

  private updateBotTargets() {
    // Paging, the bot is Home's: it goes with its page and fades as the page goes.
    const p = botPosition(State.mode, this.paging ? this.homeName() : State.view, this.height.value, State.large);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;
    this.seatBot();
    this.pageShift = this.paging ? -this.pos : 0;
    const fade = this.paging ? clamp(1 - this.pos / this.pageW(), 0, 1) : 1;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    const visible = p.opacity > 0 && !greetingActive;
    put(this.botCanvas, "opacity", visible ? String(fade) : "0");
    // Between the tabs the bot fades with the home view; folding or retracting, it is gone at once, as before.
    this.botCanvas.classList.toggle("fades", State.mode === "expanded" && !this.paging);
    put(this.botGlow, "transition", this.paging ? "none" : "");

    if (State.mode === "expanded" && !greetingActive) {
      const d = p.diameter;
      const state = this.botState();
      const color = botGlowColor(state);
      put(this.botGlow, "display", "block");
      put(this.botGlow, "width", `${d * 2.2}px`);
      put(this.botGlow, "height", `${d * 2.2}px`);
      put(this.botGlow, "left", `${this.botCx.value - d * 1.1 + this.pageShift}px`);
      put(this.botGlow, "top", `${this.botCy.value - d * 1.1}px`);
      put(this.botGlow, "background", `radial-gradient(circle, ${color} 0%, transparent 62%)`);
      put(this.botGlow, "opacity", String(visible ? botGlowOpacity(state) * fade : 0));
    } else {
      put(this.botGlow, "display", "none");
    }
  }

  /** The bot must be drawn once more whatever it is doing: the page changed around it. */
  private botStale = true;
  private botDrawnDpr = 0;

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Resizing a canvas clears it, so it must be drawn again then.
    let fresh = this.botDrawnDpr !== dpr;
    if (this.canvasPx !== w) {
      fresh = true;
      this.canvasPx = w;
      this.botCanvas.width = Math.round(w * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      put(this.botCanvas, "width", `${w}px`);
      put(this.botCanvas, "height", `${hCss}px`);
    }
    // On whole pixels of the screen once it has come to rest: a canvas placed
    // between two of them (at 125 % most places are) is drawn soft.
    const still = this.botCx.settled && this.botCy.settled && !this.paging;
    const scale = (window.devicePixelRatio || 1) * Display.zoom;
    const place = (v: number) => (still ? Math.round(v * scale) / scale : v);
    put(this.botCanvas, "left", `${place(this.botCx.value - w / 2 + this.pageShift)}px`);
    put(this.botCanvas, "top", `${place(this.botCy.value - BOT_OVERHANG / 2 - hCss / 2)}px`);

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    this.engine.bodyColor = this.easeBodyColor(dt);
    this.engine.particleOverhang = BOT_OVERHANG;
    // Where it looks, how it leans, what it is playing: its reactions say, then the engine moves.
    this.gullu.update(dt);
    // A bot at rest looks the same as it did: the frames that are only here for
    // the island's geometry, or for a timer that has just fired, leave the canvas be.
    if (!fresh && !this.botStale && !this.gullu.busy && !this.tintSettling) return;
    this.botStale = false;
    this.botDrawnDpr = dpr;
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    wipe(ctx);
    this.engine.draw(ctx, w, hCss);
  }

  /** The colour the bot's shell should be: its pill's colour. */
  private targetBodyColor(): RGB | null {
    const focus = State.focusTask;
    return focus?.isIntegration ? hexToRGB(focus.color) : null;
  }

  /**
   * Eases the body towards its target rather than jumping, so going from one
   * pill to another reads as the bot changing colour, not flickering: about
   * 90 % of the way in 0.4 s, blended in OKLab so red to green stays bright
   * instead of dipping through brown. Null — its own cream gradient —
   * can't be blended into, and is simply taken.
   */
  private easeBodyColor(dt: number): RGB | null {
    const target = this.targetBodyColor();
    if (!target || !this.bodyRGB) {
      this.bodyRGB = target;
      return target;
    }
    this.bodyRGB = mixColor(this.bodyRGB, target, 1 - Math.exp(-dt * TINT_RATE));
    return this.bodyRGB;
  }

  /** True while the body colour is still on its way — the frame loop keeps going. */
  private get tintSettling(): boolean {
    const target = this.targetBodyColor();
    if (!target || !this.bodyRGB) return false;
    return this.bodyRGB.some((v, i) => Math.abs(v - target[i]) > TINT_SETTLED);
  }

  private updateCountdown(nowMs: number) {
    if (State.mode !== "expanded" || State.isPinned || this.homeCollapseAt == null) {
      put(this.countdown, "width", "0px");
      return;
    }
    const autoClose = State.settings.autoCloseInterval;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (this.homeCollapseAt - nowMs) / 1000;
    put(this.countdown, "width",
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px");
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    this.contentEl.style.opacity = expanded && !greetingActive ? "1" : "0";
    // Folded or hidden, the views are out of sight but still in the page: what
    // moves in them on its own stops (see #content.away), and picks up when the
    // island unfolds.
    this.contentEl.classList.toggle("away", !expanded);
    this.contentEl.style.pointerEvents = expanded && !greetingActive ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }
    // The Shelf ticks, and its camera may run, only while it is what is on show.
    this.syncBare();
    this.shelf.visible(expanded && !greetingActive && State.view === "shelf");

    // Folded: the bot, a dot per session, the metric cells. Its width follows
    // what it holds — which changes rarely — on the island's own spring.
    const plan = compactPlan();
    this.compact.sync(plan);
    this.compact.el.classList.toggle("on", State.mode === "compact");
    if (State.mode === "compact" && Math.abs(plan.width - this.compactW) > 0.5) this.animateGeometry(plan.width < this.compactW);

    this.overall = overallState(plan.live);
    // What may hold the folded island on show: looked at again whenever the sessions' state changes.
    this.active = plan.live.some(isActive);
    this.fsm.refresh();
    // The status always wins: whatever the bot was playing stops for it (bot/reactions.ts).
    this.gullu.setStatus(this.botState());
    this.watchQuiet();
    this.watchUsageReset();
    this.watchHome(expanded && State.view === "overview");
  }

  /**
   * A usage window's reset time passes: its number is of a window that is
   * over, and is shown as reset from that moment (state.ts `usageShown`).
   * One timer to the nearest reset, armed only while the island is on show;
   * when it fires the usage is said again as it is — the cells and the home
   * view's rows write themselves, and no frame is drawn for it. Hidden,
   * nothing is armed: a revealed island reads the time as it draws.
   */
  private watchUsageReset() {
    const now = Date.now();
    const due = State.mode === "hidden" ? 0 : (nextUsageReset(State.usage, now) ?? 0);
    if (due === this.resetDue) return;
    if (this.resetTimer != null) window.clearTimeout(this.resetTimer);
    this.resetTimer = null;
    this.resetDue = due;
    if (due === 0) return;
    this.resetTimer = window.setTimeout(() => {
      this.resetTimer = null;
      this.resetDue = 0;
      State.setUsage(State.usage);
    }, Math.min(due - now + 250, 2_000_000_000));
  }

  /**
   * What the island's bot wears. On a card about one session — a request, a
   * turn's end, the panel — that session's state. Folded, and on the home
   * view, it speaks for them all: the state of the one that most needs attention.
   */
  private botState(): BotStateName {
    if (State.stateOverride) return State.stateOverride;
    return State.mode !== "expanded" || SPEAKS_FOR_ALL.has(State.view) ? this.overall : State.effectiveState;
  }

  /** The home view's one slow timer: running while that view is on show, and at no other time. */
  private watchHome(on: boolean) {
    if (on === (this.homeTimer != null)) return;
    if (on) this.homeTimer = window.setInterval(() => State.notify(), HOME_TICK_MS);
    else {
      window.clearInterval(this.homeTimer!);
      this.homeTimer = null;
    }
  }

  /**
   * "No activity for 10 min": the words are worked out when a session is
   * drawn; this only sees to it that it is drawn again when the time comes.
   * One timer, for the session that will go quiet first, and none while the
   * island is hidden: a hidden island is woken by nothing, and when it is
   * revealed it is drawn — and this is asked — again.
   */
  private watchQuiet() {
    const now = Date.now();
    let due = 0;
    if (State.mode !== "hidden") {
      for (const session of State.sessions) {
        const at = quietAt(session);
        if (at != null && at > now && (due === 0 || at < due)) due = at;
      }
    }
    if (due === this.quietDue) return;
    if (this.quietTimer != null) window.clearTimeout(this.quietTimer);
    this.quietTimer = null;
    this.quietDue = due;
    if (due === 0) return;
    this.quietTimer = window.setTimeout(() => {
      this.quietTimer = null;
      this.quietDue = 0;
      State.notify();
    }, due - now + 50);
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    // Settings → Island → Visibility: applied to an island already folded, from now.
    const hideAfter = foldedAutoHide(State.settings);
    const restart = hideAfter !== this.fsm.petitToHiddenDelay;
    this.fsm.petitToHiddenDelay = hideAfter;
    this.fsm.refresh(restart);
    this.yieldToFullscreen();
    // The plush chosen in Settings, on the island's bot and on every mini made after.
    const theme = State.settings.botTheme;
    if (theme in BOT_THEMES) {
      BotEngine.defaultTheme = theme as BotTheme;
      this.engine.theme = theme as BotTheme;
    }
    // Settings → Appearance: whether the bot plays with the mouse, and how much it may move.
    const playful = State.settings.playfulReactions !== false;
    this.gullu.playful = playful;
    this.gullu.reduceMotion = reduceMotionChoice();
    miniBotManners(playful, reduceMotionChoice());
    // The stylesheet's own reduced-motion rules follow the same choice.
    document.documentElement.dataset.motion = reducedMotion() ? "reduce" : "full";
    // Settings → Shelf: a widget that is off arms nothing.
    widgetsSettingsChanged();
    State.notify();
    this.ensureRunning();
  }

  get panelSize() {
    return { w: PANEL_W, h: PANEL_H };
  }
}
