// Island open/close FSM — port of IslandStateMachine.swift.
// No DOM, no Tauri: it only reports transitions.

export type FsmState = "hidden" | "petit" | "home" | "greeting";

/** What the timers are set with: the window's own, or a clock a self-check moves by hand. */
export interface FsmTimers {
  set(run: () => void, ms: number): number;
  clear(id: number): void;
}

const WINDOW_TIMERS: FsmTimers = {
  set: (run, ms) => window.setTimeout(run, ms),
  clear: (id) => window.clearTimeout(id),
};

export class IslandStateMachine {
  state: FsmState = "hidden";

  constructor(private timers: FsmTimers = WINDOW_TIMERS) {}

  onTransition: ((from: FsmState, to: FsmState) => void) | null = null;

  /** home → petit delay, seconds. */
  homeToPetitDelay = 15;
  /**
   * petit → hidden delay, seconds: Settings → Island, "Auto-hide the folded
   * island after". 0 is "never": the folded island stays on show.
   */
  petitToHiddenDelay = 60;
  /**
   * True while the folded island must not hide whatever the delay says — a
   * session is at work, and Settings say to hide only when none is. The time
   * starts once this is false again (`refresh`).
   */
  holds: () => boolean = () => false;
  /** greeting → petit once the greeting animation ends (no hover). */
  greetAutoCollapseDelay = 0.6;
  /** greeting → petit while the mouse hovers the greeting. */
  greetHoverCollapseDelay = 10;
  /** An alert waiting for an answer stays open, even when the mouse leaves. */
  pinned = false;

  /** The folded island was left alone: it hides when its time is up. Kept while nothing may hide it. */
  private leaving = false;
  private petitHide: number | null = null;
  private homeCollapse: number | null = null;
  private greetCollapse: number | null = null;

  // ── Inputs ──────────────────────────────────────────────────────────────────

  launch() {
    this.cancelTimers();
    this.transition("greeting");
  }

  mouseEntered() {
    switch (this.state) {
      case "hidden":
        this.cancelTimers();
        this.transition("petit");
        break;
      case "petit":
        this.leaving = false;
        this.clear("petitHide");
        break;
      case "home":
        this.clear("homeCollapse");
        break;
      case "greeting":
        this.scheduleGreetCollapse(this.greetHoverCollapseDelay);
        break;
    }
  }

  mouseLeft() {
    switch (this.state) {
      case "hidden":
        break;
      case "petit":
        this.schedulePetitHide();
        break;
      case "home":
        this.scheduleHomeCollapse();
        break;
      case "greeting":
        this.clear("greetCollapse");
        this.transition("petit");
        break;
    }
  }

  click() {
    if (this.state !== "petit") return;
    this.cancelTimers();
    this.transition("home");
  }

  /** Greeting animation finished (T.end). Doesn't override a running hover timer. */
  greetComplete() {
    if (this.state !== "greeting") return;
    if (this.greetCollapse == null) this.scheduleGreetCollapse(this.greetAutoCollapseDelay);
  }

  /** Non-alert work event: show compact from hidden. */
  reveal() {
    if (this.state !== "hidden") return;
    this.cancelTimers();
    this.transition("petit");
    this.schedulePetitHide();
  }

  /** Alert or explicit request: open straight to expanded. */
  forceHome() {
    this.cancelTimers();
    this.transition("home");
  }

  /// Explicit close (OK button, Escape, an alert being answered).
  forcePetit() {
    this.cancelTimers();
    this.transition("petit");
  }

  forceHidden() {
    this.cancelTimers();
    this.transition("hidden");
  }

  // ── Timers ──────────────────────────────────────────────────────────────────

  /**
   * The settings changed, or what the sessions are doing did: the folded
   * island's time to hide is looked at again. Held (never, or a session at
   * work), no timer runs; free again, the time starts from now — and from now
   * too when `restart` says the delay itself is another.
   */
  refresh(restart = false) {
    if (this.state !== "petit" || !this.leaving) return;
    const held = !(this.petitToHiddenDelay > 0) || this.holds();
    if (held) this.clear("petitHide");
    else if (this.petitHide == null || restart) this.armPetitHide();
  }

  private schedulePetitHide() {
    this.leaving = true;
    this.clear("petitHide");
    if (this.petitToHiddenDelay > 0 && !this.holds()) this.armPetitHide();
  }

  private armPetitHide() {
    this.clear("petitHide");
    this.petitHide = this.timers.set(() => {
      this.petitHide = null;
      if (this.state !== "petit") return;
      // Said again when the time is up: nothing hides it while it is held.
      if (!(this.petitToHiddenDelay > 0) || this.holds()) return;
      this.transition("hidden");
    }, this.petitToHiddenDelay * 1000);
  }

  private scheduleHomeCollapse() {
    this.clear("homeCollapse");
    if (this.pinned) return;
    this.homeCollapse = this.timers.set(() => {
      this.homeCollapse = null;
      if (this.state === "home") this.transition("petit");
    }, this.homeToPetitDelay * 1000);
  }

  private scheduleGreetCollapse(delay: number) {
    this.clear("greetCollapse");
    this.greetCollapse = this.timers.set(() => {
      this.greetCollapse = null;
      if (this.state === "greeting") this.transition("petit");
    }, delay * 1000);
  }

  private clear(which: "petitHide" | "homeCollapse" | "greetCollapse") {
    const id = this[which];
    if (id != null) this.timers.clear(id);
    this[which] = null;
  }

  cancelTimers() {
    this.leaving = false;
    this.clear("petitHide");
    this.clear("homeCollapse");
    this.clear("greetCollapse");
  }

  private transition(next: FsmState) {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.onTransition?.(from, next);
  }
}
