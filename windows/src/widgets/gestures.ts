// What a press on the row of small cards turns out to be.
//
// One press is exactly one of four things, decided by how far it travels and
// how long it is held:
//
//   tap         released within TAP_SLOP px of where it went down. The browser's
//               own `click` goes on: to the control under it, or, on a card's
//               header or empty area, to the card (which expands).
//   drag        travelled more than TAP_SLOP px, mostly along the row
//               (sideways; up or down when the row is a column, on a side
//               dock): the row scrolls with the pointer. The `click` that
//               follows is swallowed, whatever was under the pointer, so a
//               swipe never presses a control and never expands a card.
//   stray       travelled more than TAP_SLOP px, mostly across the row (or
//               inside a text field, where a drag selects text): nothing, and no click.
//   long press  held within TAP_SLOP px for `longPressMs`, on a card's header or
//               empty area (never on a control): the card lifts and is carried
//               to a new place. No click.
//
// Wheel and trackpad scrolling never come through here: a `wheel` event makes no
// `click`, so it cannot activate anything. Nothing here runs between presses.

export interface GestureOptions {
  row: HTMLElement;
  /** The row runs up and down (a column), not sideways: asked as each press begins. */
  upright?(): boolean;
  /** What a card is, and what inside it is a control. */
  card: string;
  control: string;
  longPressMs: number;
  /** The cards' ids in their new order, after a drop that moved something. */
  onReorder(ids: string[]): void;
  /** The row is about to follow the pointer; then it has been let go. */
  onScrollStart(): void;
  onScrollEnd(): void;
}

/** A press that travels further than this is not a tap, and not a long press. */
export const TAP_SLOP = 6;
/** Within this distance of the row's edge, a carried card scrolls the row. */
const EDGE = 36;
const EDGE_SPEED = 7;

type Phase = "idle" | "press" | "scroll" | "stray" | "carry";

export function enableGestures(opts: GestureOptions) {
  const { row } = opts;

  let phase: Phase = "idle";
  let card: HTMLElement | null = null;
  let onControl = false;
  let inField = false;
  let pointerId = -1;
  /** The row is a column for this press: what follows is measured up and down. */
  let upright = false;
  /** Where the press began and is now, along the row; and where it began across it. */
  let startAlong = 0;
  let startAcross = 0;
  let lastAlong = 0;
  let pressTimer = 0;
  let swallowClick = false;
  let startScroll = 0;

  // The row's axis: sideways, or up and down in a column.
  const along = (e: PointerEvent) => (upright ? e.clientY : e.clientX);
  const across = (e: PointerEvent) => (upright ? e.clientX : e.clientY);
  const getScroll = () => (upright ? row.scrollTop : row.scrollLeft);
  const setScroll = (at: number) => {
    if (upright) row.scrollTop = at;
    else row.scrollLeft = at;
  };
  const offset = (el: HTMLElement) => (upright ? el.offsetTop : el.offsetLeft);
  const shiftBy = (px: number) => `translate${upright ? "Y" : "X"}(${px}px)`;
  const startOf = (rect: DOMRect) => (upright ? rect.top : rect.left);

  // While carrying a card
  let cards: HTMLElement[] = [];
  let from = 0;
  let to = 0;
  let pitch = 0;
  let edgeLoop = 0;

  const closest = (target: EventTarget | null, selector: string) =>
    target instanceof Element ? (target.closest(selector) as HTMLElement | null) : null;

  function clearPress() {
    if (pressTimer) window.clearTimeout(pressTimer);
    pressTimer = 0;
  }

  function lift() {
    pressTimer = 0;
    if (!card || phase !== "press") return;
    phase = "carry";
    swallowClick = true;
    cards = [...row.querySelectorAll<HTMLElement>(opts.card)];
    from = to = cards.indexOf(card);
    pitch = cards.length > 1 ? offset(cards[1]) - offset(cards[0]) : upright ? card.offsetHeight : card.offsetWidth;
    startScroll = getScroll();
    row.classList.add("reordering");
    card.classList.add("lifted");
    try {
      card.setPointerCapture(pointerId);
    } catch {
      /* the pointer is already gone: pointerup will not come, the drop does nothing */
    }
    edgeLoop = requestAnimationFrame(edgeScroll);
  }

  /** Where the lifted card is, and the gap the others leave for it. */
  function place() {
    if (!card) return;
    const travel = lastAlong - startAlong + (getScroll() - startScroll);
    card.style.transform = shiftBy(travel);
    to = Math.max(0, Math.min(cards.length - 1, Math.round((from * pitch + travel) / pitch)));
    cards.forEach((other, k) => {
      if (other === card) return;
      let shift = 0;
      if (from < to && k > from && k <= to) shift = -pitch;
      else if (to < from && k >= to && k < from) shift = pitch;
      other.style.transform = shift ? shiftBy(shift) : "";
    });
  }

  /** Only while a card is carried: a frame a time, and none otherwise. */
  function edgeScroll() {
    if (phase !== "carry") return;
    const box = row.getBoundingClientRect();
    const [first, last] = upright ? [box.top, box.bottom] : [box.left, box.right];
    if (lastAlong < first + EDGE) setScroll(getScroll() - EDGE_SPEED);
    else if (lastAlong > last - EDGE) setScroll(getScroll() + EDGE_SPEED);
    place();
    edgeLoop = requestAnimationFrame(edgeScroll);
  }

  function drop(commit: boolean) {
    cancelAnimationFrame(edgeLoop);
    const moved = card;
    if (!moved) return;
    const before = startOf(moved.getBoundingClientRect());
    const scroll = getScroll();

    // The others already stand where they will: their shifts come off at once,
    // with the page reordered under them in the same breath.
    row.classList.add("no-shift");
    for (const other of cards) other.style.transform = "";
    const changed = commit && to !== from;
    if (changed) {
      const rest = cards.filter((t) => t !== moved);
      row.insertBefore(moved, rest[to] ?? null);
      setScroll(scroll);
    }
    // The lifted one glides from where it was let go to its place.
    const after = startOf(moved.getBoundingClientRect());
    moved.style.transform = shiftBy(before - after);
    void moved.offsetWidth;
    row.classList.remove("no-shift");
    moved.classList.remove("lifted");
    moved.style.transform = "";
    window.setTimeout(() => row.classList.remove("reordering"), 260);

    if (changed) opts.onReorder([...row.querySelectorAll<HTMLElement>(opts.card)].map((t) => t.dataset.id ?? ""));
  }

  row.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // A press that never ended (the pointer was lost): it is over now, so that the row is never stuck.
    if (phase !== "idle") {
      clearPress();
      if (phase === "carry") drop(false);
      else if (phase === "scroll") {
        row.classList.remove("dragging");
        opts.onScrollEnd();
      }
      phase = "idle";
    }
    card = closest(e.target, opts.card);
    onControl = closest(e.target, opts.control) != null;
    inField = closest(e.target, "input, textarea, select") != null;
    phase = "press";
    pointerId = e.pointerId;
    upright = opts.upright?.() ?? false;
    startAlong = lastAlong = along(e);
    startAcross = across(e);
    startScroll = getScroll();
    swallowClick = false;
    clearPress();
    // A reorder starts from a card's header or empty area only: a control held down is a control held down.
    if (card && !onControl) pressTimer = window.setTimeout(lift, opts.longPressMs);
  });

  row.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointerId) return;
    lastAlong = along(e);
    if (phase === "carry") {
      place();
      return;
    }
    if (phase === "scroll") {
      setScroll(startScroll - (lastAlong - startAlong));
      return;
    }
    if (phase !== "press") return;
    // Along the row, and across it.
    const dx = lastAlong - startAlong;
    const dy = across(e) - startAcross;
    if (Math.hypot(dx, dy) <= TAP_SLOP) return;

    // It moved: whatever it becomes, it is no longer a tap.
    clearPress();
    swallowClick = true;
    if (!inField && Math.abs(dx) >= Math.abs(dy)) {
      phase = "scroll";
      opts.onScrollStart();
      row.classList.add("dragging");
      try {
        row.setPointerCapture(pointerId);
      } catch {
        /* the pointer is already gone */
      }
      setScroll(startScroll - dx);
    } else {
      phase = "stray";
    }
  });

  const end = (commit: boolean) => (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    clearPress();
    if (phase === "carry") {
      drop(commit);
    } else if (phase === "scroll") {
      row.classList.remove("dragging");
      opts.onScrollEnd();
    }
    phase = "idle";
    card = null;
    pointerId = -1;
    // The click, if one comes, comes right after pointerup: after that the flag is stale.
    window.setTimeout(() => (swallowClick = false), 0);
  };
  row.addEventListener("pointerup", end(true));
  row.addEventListener("pointercancel", end(false));

  // Before the cards' and the controls' own click handlers.
  row.addEventListener(
    "click",
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );

  // A drag must not pick up an image or a selection on the way.
  row.addEventListener("dragstart", (e) => e.preventDefault());

  // A long press on a touch screen or a pen would otherwise open the context menu.
  row.addEventListener("contextmenu", (e) => {
    if (phase === "carry") e.preventDefault();
  });
}
