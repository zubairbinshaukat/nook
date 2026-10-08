// The reply box: a line to type to a session at rest, on the card that tells a
// turn's end and under the session panel's journal (core/reply.ts has what it
// keeps and how a reply is sent).
//
// One box, three faces: the field with its send button; "Sending…" until the
// session is heard from; and, in the panel, a line that says the session is
// working on the reply, with the way to stop it. Where a reply cannot reach a
// session — Cursor's, a tool whose command line is not on this machine — the
// box is not there at all.

import { MAX_REPLY_CHARS, Reply } from "../core/reply";
import { State, type ClaudeSession } from "../core/state";
import { h } from "./dom";
import { LUCIDE, lucide } from "./iconset";
import { TOOL_NAME } from "./tool";

/** How long the island's window takes to have the keyboard, once asked for it. */
const FOCUS_MS = 120;
/** The field grows with what is typed, up to this many lines: fewer on a card, which is short. */
const MAX_LINES = { card: 2, panel: 5 } as const;

const SENT_WHERE = "It runs in the background: the window this session was started in won't show it.";

export interface ReplyBoxActions {
  /** A text field wants the keyboard, or gives it back. */
  keyboard(on: boolean): void;
  blip(): void;
}

export interface ReplyBox {
  el: HTMLElement;
  /** Draws the box for this session: null where there is none to reply to. */
  sync(session: ClaudeSession | null): void;
}

/**
 * `where` is the box's scale and how far it grows. `resized` is called when
 * its height has changed, for a card that fits what it holds.
 */
export function buildReplyBox(actions: ReplyBoxActions, where: "card" | "panel", resized: () => void = () => {}): ReplyBox {
  const field = h("textarea", {
    class: "rb-field", rows: "1", maxlength: String(MAX_REPLY_CHARS), autocomplete: "off", spellcheck: "false", "aria-label": "Reply",
  }) as HTMLTextAreaElement;
  const send = h("button", { class: "rb-btn rb-send", type: "button", title: "Send (Enter)", "aria-label": "Send" }, lucide(LUCIDE.arrowUp, 13, 2.6));
  const stop = h("button", { class: "rb-btn rb-stop", type: "button", title: "Stop", "aria-label": "Stop" }, lucide(LUCIDE.square, 9, 3));
  const status = h("span", { class: "rb-status", role: "status" });
  const row = h("div", { class: "rb-row" }, field, status, send, stop);
  const note = h("div", { class: "rb-note", role: "alert" });
  const el = h("div", { class: `reply-box rb-${where}` }, row, note);
  el.hidden = true;

  let session: ClaudeSession | null = null;
  /** A send is on its way to Rust: a second Enter does nothing. */
  let busy = false;
  let wanting = false;
  let lastHeight = 0;

  /** One line tall, growing with what is typed, then scrolling. */
  function grow() {
    // Empty, it is its one line whatever its width: a placeholder that wraps while the island opens must not stretch it.
    field.style.height = "";
    field.style.overflowY = "hidden";
    if (field.value) {
      const style = getComputedStyle(field);
      const line = parseFloat(style.lineHeight) || 17;
      const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) || 0;
      const most = Math.round(line * MAX_LINES[where] + pad);
      field.style.height = "auto";
      const wanted = field.scrollHeight;
      field.style.height = `${Math.min(wanted, most)}px`;
      field.style.overflowY = wanted > most ? "auto" : "hidden";
    }
    if (el.offsetHeight !== lastHeight) {
      lastHeight = el.offsetHeight;
      resized();
    }
  }

  async function submit() {
    const to = session;
    if (!to || busy || !field.value.trim()) return;
    busy = true;
    actions.blip();
    const sent = await Reply.send(to, field.value);
    busy = false;
    // Only the field of the session it was typed for is emptied: another may be in front by now.
    if (sent && session === to) {
      field.value = "";
      field.blur();
    }
    State.notify();
  }

  // The island's window never takes the keyboard by itself: a press on the
  // field asks for it, and the field has the focus once the window does.
  field.addEventListener("mousedown", () => {
    wanting = true;
    actions.keyboard(true);
    window.setTimeout(() => {
      if (wanting && document.activeElement !== field) field.focus();
    }, FOCUS_MS);
  });
  field.addEventListener("blur", () => {
    wanting = false;
    actions.keyboard(false);
  });
  field.addEventListener("input", () => {
    if (session) Reply.setDraft(session, field.value);
    send.disabled = !field.value.trim();
    // An error is answered by typing again: it goes. A warning stays, it is still true.
    if (note.textContent && !note.classList.contains("warn")) {
      note.textContent = "";
      note.hidden = true;
    }
    grow();
  });
  field.addEventListener("keydown", (e) => {
    // What is typed is the field's: none of the island's own keys hears it.
    e.stopPropagation();
    if (e.key === "Escape") field.blur();
    else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submit();
    }
  });
  send.addEventListener("click", () => void submit());
  stop.addEventListener("click", () => {
    if (!session) return;
    actions.blip();
    Reply.stop(session);
  });
  // What is typed wraps differently at another width: the panel at its large size, the island still opening.
  let lastWidth = 0;
  new ResizeObserver(() => {
    if (el.hidden || field.hidden || field.clientWidth === lastWidth) return;
    lastWidth = field.clientWidth;
    grow();
  }).observe(field);
  // A click beside the field, inside the box, is not one on the card behind it.
  el.addEventListener("click", (e) => e.stopPropagation());

  return {
    el,
    sync(next) {
      const to = next && next.id && Reply.offered(next) ? next : null;
      const running = to != null && Reply.running(to);
      const open = to != null && Reply.open(to);
      // On a card only what can be typed in or is being sent shows; the panel also says a reply is being worked on.
      const shown = to != null && (open || (running && (where === "panel" || Reply.starting(to))));
      if (session !== to) {
        if (document.activeElement === field) field.blur();
        session = to;
        field.value = to ? Reply.draft(to) : "";
      }
      if (el.hidden === shown) el.hidden = !shown;
      if (!to || !shown) {
        lastHeight = 0;
        return;
      }
      const name = TOOL_NAME[to.agent];
      field.hidden = !open;
      send.hidden = !open;
      stop.hidden = !running;
      status.hidden = !running;
      el.dataset.state = open ? "open" : Reply.starting(to) ? "starting" : "working";
      if (open) {
        field.placeholder = `Reply to ${name}…`;
        field.title = `Enter sends, Shift+Enter starts a new line. ${SENT_WHERE}`;
        send.disabled = !field.value.trim() || busy;
      } else {
        status.textContent = Reply.starting(to) ? `Sending to ${name}…` : `${name} is working on your reply`;
        status.title = SENT_WHERE;
      }
      // Why the last one was not sent; or, with nothing wrong, what to know before sending this one.
      const error = open ? Reply.error(to) : null;
      const said = error ?? (open ? Reply.warning(to) : null);
      note.textContent = said ?? "";
      note.title = said ?? "";
      note.hidden = !said;
      note.classList.toggle("warn", !error && said != null);
      note.setAttribute("role", error ? "alert" : "note");
      if (open) grow();
      else if (el.offsetHeight !== lastHeight) {
        lastHeight = el.offsetHeight;
        resized();
      }
    },
  };
}
