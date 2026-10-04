// Shelf preview — what a press on the row of cards turns out to be.
//
// One press is exactly one of four things, decided by how far it travels and
// how long it is held:
//
//   tap         released within TAP_SLOP px of where it went down. The browser's
//               own `click` goes on: to the control under it, or, on a card's
//               header or empty area, to the card (which expands).
//   drag        travelled more than TAP_SLOP px, mostly sideways: the row
//               scrolls with the pointer. The `click` that follows is swallowed,
//               whatever was under the pointer, so a swipe never presses a
//               control and never expands a card.
//   stray       travelled more than TAP_SLOP px, mostly up or down (or inside a
//               text field, where a drag selects text): nothing, and no click.
//   long press  held within TAP_SLOP px for `longPressMs`, on a card's header or
//               empty area (never on a control): the card lifts and is carried
//               to a new place. No click.
//
// Wheel and trackpad scrolling never come through here: a `wheel` event makes no
// `click`, so it cannot activate anything.

export interface GestureOptions {
  row: HTMLElement;
  /** What a card is, and what inside it is a control. */
  card: string;
  control: string;
  longPressMs: number;
  /** The cards' ids in their new order, after a drop that moved something. */
  onReorder(ids: string[]): void;
  /** Lifted or put down. */
  onState(dragging: boolean): void;
  /** The row is about to follow the pointer; then it has been let go. */
  onScrollStart(): void;
  onScrollEnd(): void;
  /** What the press was, in words, for the read-out. */
  onVerdict(text: string): void;
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
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let pressTimer = 0;
  let swallowClick = false;
  let startScroll = 0;

  // While carrying a card
  let cards: HTMLElement[] = [];
  let from = 0;
  let to = 0;
  let pitch = 0;
  let edgeLoop = 0;

  const closest = (target: EventTarget | null, selector: string) =>
    target instanceof Element ? (target.closest(selector) as HTMLElement | null) : null;
  const nameOf = (el: HTMLElement | null) => el?.dataset.id ?? "the row";

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
    pitch = cards.length > 1 ? cards[1].offsetLeft - cards[0].offsetLeft : card.offsetWidth;
    startScroll = row.scrollLeft;
    row.classList.add("reordering");
    card.classList.add("lifted");
    try {
      card.setPointerCapture(pointerId);
    } catch {
      /* the pointer is already gone: pointerup will not come, the drop does nothing */
    }
    opts.onState(true);
    opts.onVerdict(`long press on ${nameOf(card)} (held ${opts.longPressMs} ms within ${TAP_SLOP} px): lifted to reorder`);
    edgeLoop = requestAnimationFrame(edgeScroll);
  }

  /** Where the lifted card is, and the gap the others leave for it. */
  function place() {
    if (!card) return;
    const travel = lastX - startX + (row.scrollLeft - startScroll);
    card.style.transform = `translateX(${travel}px)`;
    to = Math.max(0, Math.min(cards.length - 1, Math.round((from * pitch + travel) / pitch)));
    cards.forEach((other, k) => {
      if (other === card) return;
      let shift = 0;
      if (from < to && k > from && k <= to) shift = -pitch;
      else if (to < from && k >= to && k < from) shift = pitch;
      other.style.transform = shift ? `translateX(${shift}px)` : "";
    });
  }

  function edgeScroll() {
    if (phase !== "carry") return;
    const box = row.getBoundingClientRect();
    if (lastX < box.left + EDGE) row.scrollLeft -= EDGE_SPEED;
    else if (lastX > box.right - EDGE) row.scrollLeft += EDGE_SPEED;
    place();
    edgeLoop = requestAnimationFrame(edgeScroll);
  }

  function drop(commit: boolean) {
    cancelAnimationFrame(edgeLoop);
    const moved = card;
    if (!moved) return;
    const before = moved.getBoundingClientRect().left;
    const scroll = row.scrollLeft;

    // The others already stand where they will: their shifts come off at once,
    // with the page reordered under them in the same breath.
    row.classList.add("no-shift");
    for (const other of cards) other.style.transform = "";
    const changed = commit && to !== from;
    if (changed) {
      const rest = cards.filter((t) => t !== moved);
      row.insertBefore(moved, rest[to] ?? null);
      row.scrollLeft = scroll;
    }
    // The lifted one glides from where it was let go to its place.
    const after = moved.getBoundingClientRect().left;
    moved.style.transform = `translateX(${before - after}px)`;
    void moved.offsetWidth;
    row.classList.remove("no-shift");
    moved.classList.remove("lifted");
    moved.style.transform = "";
    window.setTimeout(() => row.classList.remove("reordering"), 260);

    opts.onState(false);
    opts.onVerdict(changed
      ? `long press, then dropped ${nameOf(moved)} at place ${to + 1} (was ${from + 1}); no click`
      : `long press, then dropped ${nameOf(moved)} where it was; no click`);
    if (changed) {
      opts.onReorder([...row.querySelectorAll<HTMLElement>(opts.card)].map((t) => t.dataset.id ?? ""));
    }
  }

  row.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || phase !== "idle") return;
    card = closest(e.target, opts.card);
    onControl = closest(e.target, opts.control) != null;
    inField = closest(e.target, "input, textarea, select") != null;
    phase = "press";
    pointerId = e.pointerId;
    startX = lastX = e.clientX;
    startY = e.clientY;
    startScroll = row.scrollLeft;
    swallowClick = false;
    clearPress();
    // A reorder starts from a card's header or empty area only: a control held down is a control held down.
    if (card && !onControl) pressTimer = window.setTimeout(lift, opts.longPressMs);
  });

  row.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointerId) return;
    lastX = e.clientX;
    if (phase === "carry") {
      place();
      return;
    }
    if (phase === "scroll") {
      row.scrollLeft = startScroll - (e.clientX - startX);
      return;
    }
    if (phase !== "press") return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.hypot(dx, dy) <= TAP_SLOP) return;

    // It moved: whatever it becomes, it is no longer a tap.
    clearPress();
    swallowClick = true;
    // A finger pans the row by itself (touch-action: pan-x) and the browser cancels the press.
    if (!inField && e.pointerType !== "touch" && Math.abs(dx) >= Math.abs(dy)) {
      phase = "scroll";
      opts.onScrollStart();
      row.classList.add("dragging");
      try {
        row.setPointerCapture(pointerId);
      } catch {
        /* the pointer is already gone */
      }
      row.scrollLeft = startScroll - dx;
    } else {
      phase = "stray";
    }
  });

  const end = (commit: boolean) => (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    clearPress();
    const travel = Math.round(Math.hypot(e.clientX - startX, e.clientY - startY));
    if (phase === "carry") {
      drop(commit);
    } else if (phase === "scroll") {
      row.classList.remove("dragging");
      opts.onScrollEnd();
      opts.onVerdict(`drag of ${travel} px (over ${TAP_SLOP} px, sideways): scrolled the row; the click was swallowed`);
    } else if (phase === "stray") {
      opts.onVerdict(inField
        ? `drag of ${travel} px inside a field: the field's own (selects text); no click`
        : `drag of ${travel} px, not sideways: nothing; the click was swallowed`);
    } else if (phase === "press" && commit) {
      const what = closest(e.target, opts.control);
      opts.onVerdict(what?.hasAttribute("data-expand")
        ? `tap (${travel} px) on ${nameOf(card)}'s expand corner: expands`
        : what
        ? `tap (${travel} px) on a control in ${nameOf(card)}: the control acts, the card does not expand`
        : card
          ? `tap (${travel} px) on ${nameOf(card)}'s header or empty area: expands`
          : `tap (${travel} px) between cards: nothing`);
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
