// Mirror: the camera, as a mirror. Small: a button, "Turn camera on", and
// nothing else — there is no camera here, ever. Expanded: a large rounded
// preview, mirrored, with no audio.
//
// The camera runs only while Mirror is expanded. It is stopped — every track
// stopped, the video emptied — the moment Mirror closes, the Shelf is left, the
// island folds or hides, or a card that asks something takes over (the Shelf
// tells every widget `stop`). It does not come back by itself: it is turned on
// again by a press. Nothing is recorded, nothing is saved, no frame is read.

import { h, im, setIslandText } from "../views/dom";
import type { IslandTranslationKey } from "../core/i18n.ts";
import { camera, resetCamera, startCamera, stopCamera } from "./camera";
import { notifyShelf } from "./core";
import { frame, mark, mini, shared, type Widget, type WidgetContext } from "./ui";

/** The Mirror's one video element. */
const video = h("video", { class: "mirror-video", muted: true, playsinline: true, "aria-label": im("island.widget.cameraPreview") });
video.muted = true;

camera.onChange = () => notifyShelf();
// The page is hidden or closed: whatever the island holds, the camera is let go.
window.addEventListener("pagehide", () => stopCamera(video, "the page was closed"));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopCamera(video, "the page was hidden");
});

const MESSAGES = {
  denied: ["island.widget.cameraDeniedTitle", "island.widget.cameraDeniedHelp"],
  missing: ["island.widget.cameraMissingTitle", "island.widget.cameraMissingHelp"],
  busy: ["island.widget.cameraBusyTitle", "island.widget.cameraBusyHelp"],
  error: ["island.widget.cameraErrorTitle", "island.widget.cameraErrorHelp"],
};

export function buildMirror(ctx: WidgetContext): Widget {
  // Small: one button. It expands Mirror and starts the camera there.
  const sNote = h("div", { class: "wmini-note", text: im("island.widget.cameraOffNote") });
  const sStart = shared(h("button", { class: "btn secondary wmini-btn", text: im("island.widget.cameraOn"), onclick: () => ctx.expand("mirror", { camera: true }) }), "mirror-start");
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
        setIslandText(title, im("island.widget.cameraWaiting"));
        setIslandText(sub, im(camera.slow ? "island.widget.cameraPermissionSlow" : "island.widget.cameraPermissionPending"));
        break;
      case "off":
        setIslandText(title, im("island.widget.cameraOff"));
        setIslandText(sub, im("island.widget.cameraPrivacy"));
        setIslandText(start, im("island.widget.cameraOn"));
        break;
      default: {
        const [heading, how] = MESSAGES[s] ?? MESSAGES.error;
        setIslandText(title, im(heading as IslandTranslationKey));
        setIslandText(sub, im(how as IslandTranslationKey));
        setIslandText(start, im("island.widget.cameraRetry"));
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
