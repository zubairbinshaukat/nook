// Media: what is playing in any player that tells Windows (Spotify, a browser,
// the Media Player), and its controls. Small: the title, the artist, previous /
// play-pause / next. Expanded: the album art, the progress, the volume and the
// player's name.
//
// All of it is local: the system's media controls are asked through Rust
// (src-tauri/src/media.rs). There is nothing to subscribe to and nothing runs
// on its own: the Shelf asks once a second while a Media card is on show — the
// small card on the row, or the expanded one — and never otherwise. The album
// art is held in memory, as a data URL, while it is on show, and let go of the
// moment the Shelf is off the screen; it is never written anywhere.

import type { MediaInfo } from "../core/bridge";
import { clear, h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { ShelfBackend } from "./backend";
import { notifyShelf } from "./core";
import { frame, mark, mini, setIcon, shared, type Widget, type WidgetContext } from "./ui";

const PLAY = "M7 4.5v15l12-7.5z";
const PAUSE = "M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z";
const PREVIOUS = "M6 5h2.2v14H6zM19 5v14L9 12z";
const NEXT = "M15.8 5H18v14h-2.2zM5 5v14l10-7z";

/** The volume slider is told to the system at most this often while it is dragged. */
const VOLUME_EVERY_MS = 90;

const media = {
  info: null as MediaInfo | null,
  /** When `info` was asked for (Unix ms): the position moves on from there while it plays. */
  at: 0,
  /** The current track's album art, while it is on show. */
  cover: null as string | null,
  coverKey: "",
  volume: null as number | null,
  /** The system has been asked at least once. */
  asked: false,
};

/** A player has something on (playing or paused): the Shelf keeps a silent Media card at the end of its row. */
export const mediaOn = () => media.info?.kind === "session";

let busy = false;
let volumeTimer = 0;
let volumeSaid = -1;

const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Where the track is now: as last said, moved on by the time since while it plays. */
function position(now = Date.now()): number {
  const info = media.info;
  if (!info || info.kind !== "session") return 0;
  const moved = info.playing ? now - media.at : 0;
  const at = info.positionMs + moved;
  return info.durationMs > 0 ? Math.min(info.durationMs, at) : at;
}

/** Asks the system what is playing, once. `expanded`: the art and the volume are wanted too. */
async function refresh(expanded: boolean) {
  if (busy) return;
  busy = true;
  try {
    const info = await ShelfBackend.media.state();
    media.info = info;
    media.asked = true;
    media.at = Date.now();
    if (expanded && info?.kind === "session") {
      if (media.coverKey !== info.trackKey) {
        const key = info.trackKey;
        media.coverKey = key;
        media.cover = null;
        void ShelfBackend.media.cover().then((url) => {
          if (media.coverKey === key) {
            media.cover = url;
            notifyShelf();
          }
        });
      }
      // What is being dragged is not overwritten by what the system last said.
      if (!volumeTimer) media.volume = await ShelfBackend.media.volume();
    }
  } finally {
    busy = false;
  }
  notifyShelf();
}

async function press(action: "previous" | "toggle" | "next", expanded: boolean) {
  // At once on the card, then as the player says it is.
  const info = media.info;
  if (action === "toggle" && info?.kind === "session") {
    info.positionMs = position();
    info.playing = !info.playing;
    media.at = Date.now();
    notifyShelf();
  }
  await ShelfBackend.media.control(action);
  await refresh(expanded);
}

/** The volume, as the slider has it: told to the system at most every VOLUME_EVERY_MS, and once more at the end. */
function setVolume(percent: number) {
  media.volume = percent;
  if (volumeTimer) return;
  const send = () => {
    volumeTimer = 0;
    if (media.volume != null && media.volume !== volumeSaid) {
      volumeSaid = media.volume;
      void ShelfBackend.media.setVolume(media.volume);
      volumeTimer = window.setTimeout(send, VOLUME_EVERY_MS);
    }
  };
  send();
}

export function buildMedia(ctx: WidgetContext): Widget {
  let expandedOn: () => boolean = () => false;

  const controls = (playSize: number, skipSize: number) => {
    const prev = shared(h("button", { class: "media-skip", title: "Previous", "aria-label": "Previous track", onclick: () => void press("previous", expandedOn()) }, svg(PREVIOUS, skipSize)), "media-prev");
    const play = shared(h("button", { class: "media-play", title: "Play / pause", "aria-label": "Play or pause", onclick: () => void press("toggle", expandedOn()) }), "media-play");
    const next = shared(h("button", { class: "media-skip", title: "Next", "aria-label": "Next track", onclick: () => void press("next", expandedOn()) }, svg(NEXT, skipSize)), "media-next");
    return { row: h("div", { class: "media-ctl" }, prev, play, next), play, prev, next, playSize };
  };

  // Small: song, artist, previous / play / next.
  const sTitle = shared(h("div", { class: "media-title" }), "media-song", "text");
  const sArtist = shared(h("div", { class: "media-artist" }), "media-artist", "text");
  const sCtl = controls(14, 13);
  const small = mini("media", h("div", { class: "wbody-media" }, h("div", { class: "media-now" }, sTitle, sArtist), sCtl.row));

  // Expanded: the same, with the album art, the progress and the volume.
  const cover = h("div", { class: "media-cover" }, mark("media", 34));
  const picture = h("img", { class: "media-art", alt: "", draggable: "false" });
  picture.style.display = "none";
  cover.append(picture);
  const title = shared(h("div", { class: "media-title" }), "media-song", "text");
  const artist = shared(h("div", { class: "media-artist" }), "media-artist", "text");
  const fill = h("i");
  const bar = h("div", { class: "media-bar" }, fill);
  const times = h("div", { class: "media-times" }, h("span"), h("span"));
  const ctl = controls(18, 16);
  const volume = h("input", { class: "media-vol", type: "range", min: 0, max: 100, step: 1, title: "Volume", "aria-label": "Volume" });
  volume.addEventListener("input", () => setVolume(Number(volume.value)));
  const volumeIcon = h("span", { class: "media-vol-icon" });
  const volumeBox = h("div", { class: "media-volume" }, volumeIcon, volume);
  const state = h("span", { class: "fc-aside" });

  const body = h("div", { class: "media" },
    cover,
    h("div", { class: "media-side" }, title, artist, bar, times, h("div", { class: "media-foot" }, ctl.row, volumeBox)));
  const card = frame("media", body, ctx.back, state);
  expandedOn = () => card.classList.contains("on");

  let lastCover: string | null = null;

  function paint() {
    const info = media.info;
    const session = info?.kind === "session" ? info : null;
    const unavailable = info == null || info.kind === "unavailable";
    const words = session ? session.title || "Unknown title" : !media.asked ? "Checking…" : unavailable ? "Not available" : "Nothing playing";
    const by = session ? session.artist : !media.asked ? "" : unavailable ? (info?.reason ?? "Media controls could not be reached.") : "Start something in any player.";
    for (const el of [sTitle, title]) if (el.textContent !== words) el.textContent = words;
    for (const el of [sArtist, artist]) if (el.textContent !== by) el.textContent = by;

    const playing = session?.playing === true;
    for (const c of [sCtl, ctl]) {
      setIcon(c.play, playing ? PAUSE : PLAY, c.playSize);
      (c.play as HTMLButtonElement).disabled = !session;
      (c.prev as HTMLButtonElement).disabled = !session;
      (c.next as HTMLButtonElement).disabled = !session;
    }
    state.textContent = session ? `${session.app || "Player"} · ${playing ? "Playing" : "Paused"}` : "";
    small.classList.toggle("paused", !playing);

    // Album art: the player's own, or the widget's mark where there is none.
    if (media.cover !== lastCover) {
      lastCover = media.cover;
      if (media.cover) picture.src = media.cover;
      else picture.removeAttribute("src");
      picture.style.display = media.cover ? "" : "none";
    }

    const pos = position();
    const length = session?.durationMs ?? 0;
    bar.style.visibility = length > 0 ? "" : "hidden";
    times.style.visibility = length > 0 ? "" : "hidden";
    fill.style.width = length > 0 ? `${(pos / length) * 100}%` : "0";
    (times.firstChild as HTMLElement).textContent = mmss(pos);
    (times.lastChild as HTMLElement).textContent = mmss(length);

    // The volume is the system's; where it cannot be read there is no slider.
    volumeBox.style.display = media.volume == null ? "none" : "";
    if (media.volume != null) {
      if (document.activeElement !== volume && !volumeTimer) volume.value = String(media.volume);
      setIcon(volumeIcon, media.volume === 0 ? ICONS.speakerOff : ICONS.speakerOn, 13);
    }
  }

  return {
    id: "media",
    small,
    card,
    paint,
    // Once a second while a Media card is on show: the system is asked, and nothing else.
    tick: () => void refresh(expandedOn()),
    // The Shelf is off the screen: the art is let go of, and nothing is held.
    stop: () => {
      media.cover = null;
      media.coverKey = "";
      lastCover = null;
      picture.removeAttribute("src");
      picture.style.display = "none";
      clear(volumeIcon);
      volumeIcon.removeAttribute("data-icon");
    },
  };
}
