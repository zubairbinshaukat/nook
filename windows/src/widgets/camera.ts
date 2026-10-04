import { Bridge } from "../core/bridge";

// The Mirror's camera (plans/tabs-plan.md §4).
//
// The stream exists only while Mirror is expanded. `stopCamera` ends every
// track at once and lets go of the video; a start still waiting for the
// permission prompt when `stopCamera` is called is cancelled, and its stream is
// stopped the moment it arrives. Nothing is recorded: there is no MediaRecorder,
// no canvas capture, no frame is read and nothing is saved. No audio is asked for.

export type CameraState = "off" | "starting" | "on" | "denied" | "missing" | "busy" | "error";

export const camera = {
  state: "off" as CameraState,
  /** What the browser called the failure, for the message. */
  detail: "",
  /** The permission prompt has been up this long without an answer. */
  slow: false,
  onChange: () => {},
};

/** How long a start may wait before the view says what to check. */
const SLOW_MS = 8000;

let stream: MediaStream | null = null;
let attempt = 0;
let slowTimer = 0;

/** Tracks still delivering frames: 0 whenever the camera is said to be off. */
export function liveTracks(): number {
  return stream ? stream.getTracks().filter((t) => t.readyState === "live").length : 0;
}

function set(state: CameraState, detail = "") {
  camera.state = state;
  camera.detail = detail;
  camera.onChange();
}

function endSlowTimer() {
  if (slowTimer) window.clearTimeout(slowTimer);
  slowTimer = 0;
  camera.slow = false;
}

export async function startCamera(video: HTMLVideoElement) {
  if (camera.state === "on" || camera.state === "starting") return;
  if (!navigator.mediaDevices?.getUserMedia) {
    set("error", "This page cannot reach a camera");
    return;
  }
  const mine = ++attempt;
  // One timer, only while a start is waiting on the permission prompt.
  endSlowTimer();
  slowTimer = window.setTimeout(() => {
    slowTimer = 0;
    camera.slow = true;
    camera.onChange();
  }, SLOW_MS);
  set("starting");
  try {
    const got = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    endSlowTimer();
    if (mine !== attempt) {
      // Mirror closed while the prompt was up: this stream is nobody's.
      for (const track of got.getTracks()) track.stop();
      return;
    }
    stream = got;
    video.srcObject = got;
    void video.play().catch(() => {});
    set("on");
  } catch (err) {
    endSlowTimer();
    if (mine !== attempt) return;
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") set("denied", name);
    else if (name === "NotFoundError" || name === "OverconstrainedError") set("missing", name);
    else if (name === "NotReadableError" || name === "AbortError") set("busy", name);
    else set("error", name || "unknown");
  }
}

/** Every track stopped, the video emptied. A refusal stays on show until the next try. */
export function stopCamera(video: HTMLVideoElement | null, why: string) {
  const wasBusy = camera.state === "on" || camera.state === "starting";
  attempt++; // cancels a start in flight
  endSlowTimer();
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (video) video.srcObject = null;
  if (wasBusy) {
    // One line in the log: when the camera stopped, and why — so that "it stopped when it should" can be read back.
    void Bridge.log(`camera stopped: ${why}`);
    set("off");
  }
}

/** Back to the "Turn camera on" placeholder after a refusal. */
export function resetCamera() {
  if (camera.state !== "off" && camera.state !== "on" && camera.state !== "starting") set("off");
}
