// Mirror: the camera, as a mirror. Small: a button, "Turn camera on", and
// nothing else — there is no camera here, ever. Expanded: a large rounded
// preview, mirrored, with no audio.
//
// The camera runs only while Mirror is expanded. It is stopped — every track
// stopped, the video emptied — the moment Mirror closes, the Shelf is left, the
// island folds or hides, or a card that asks something takes over (the Shelf
// tells every widget `stop`). It does not come back by itself: it is turned on
// again by a press. Nothing is recorded, nothing is saved, no frame is read.

import { h } from "../views/dom";
import { camera, resetCamera, startCamera, stopCamera } from "./camera";
import { notifyShelf } from "./core";
import { frame, mark, mini, shared, type Widget, type WidgetContext } from "./ui";

/** The Mirror's one video element. */
const video = h("video", { class: "mirror-video", muted: true, playsinline: true, "aria-label": "Camera preview" });
video.muted = true;

camera.onChange = () => notifyShelf();
// The page is hidden or closed: whatever the island holds, the camera is let go.
window.addEventListener("pagehide", () => stopCamera(video, "the page was closed"));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopCamera(video, "the page was hidden");
});

const MESSAGES: Record<string, [string, string]> = {
  denied: [
    "Camera access was refused",
    "Allow it for Nook: Windows Settings → Privacy & security → Camera, and let desktop apps use your camera. If you chose Block when asked, that choice is remembered. Then try again.",
  ],
  missing: ["No camera found", "Plug one in, or check that Windows can see it, then try again."],
  busy: ["The camera is busy", "Another app may be using it. Close it, then try again."],
  error: ["The camera could not be started", "Try again; if it keeps failing, check the camera in Windows Settings."],
};

export function buildMirror(ctx: WidgetContext): Widget {
  // Small: one button. It expands Mirror and starts the camera there.
  const sNote = h("div", { class: "wmini-note", text: "Camera off. It only runs while Mirror is open." });
  const sStart = shared(h("button", { class: "btn secondary wmini-btn", text: "Turn camera on", onclick: () => ctx.expand("mirror", { camera: true }) }), "mirror-start");
  const small = mini("mirror", h("div", { class: "wbody-mirror" }, sNote, sStart));

  // Expanded: the large preview.
  const title = h("div", { class: "title" });
  const sub = h("div", { class: "sub" });
  const start = shared(h("button", { class: "btn primary", onclick: () => {
    resetCamera();
    void startCamera(video);
  } }), "mirror-start");
  const placeholder = h("div", { class: "mirror-ph" }, h("span", { class: "mirror-ph-mark" }, mark("mirror", 30)), title, sub, start);

  const body = h("div", { class: "mirror" }, video, placeholder);
  const card = frame("mirror", body, ctx.back);
  card.classList.add("bare");

  function paint() {
    const s = camera.state;
    body.classList.toggle("live", s === "on");
    start.style.display = s === "starting" || s === "on" ? "none" : "";
    switch (s) {
      case "on":
        break;
      case "starting":
        title.textContent = "Waiting for the camera…";
        sub.textContent = camera.slow
          ? "No answer yet. If no question appeared, allow the camera for Nook in Windows Settings → Privacy & security → Camera, then go back and try again."
          : "Windows may be asking for permission.";
        break;
      case "off":
        title.textContent = "Camera off";
        sub.textContent = "Nothing is recorded or saved. The camera stops the moment you leave this view.";
        start.textContent = "Turn camera on";
        break;
      default: {
        const [heading, how] = MESSAGES[s] ?? MESSAGES.error;
        title.textContent = heading;
        sub.textContent = how;
        start.textContent = "Try again";
      }
    }
  }

  return {
    id: "mirror",
    small,
    card,
    paint,
    opened: (opts) => {
      resetCamera();
      if (opts.camera) void startCamera(video);
    },
    stop: (why) => stopCamera(video, why),
  };
}
