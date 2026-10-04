// Shelf preview — the Mirror's camera (plans/tabs-plan.md §4).
//
// The stream exists only while Mirror is open. `stop` ends every track at once;
// a start still waiting for the browser's permission prompt when `stop` is
// called is cancelled, and its stream is stopped the moment it arrives.
// Nothing is recorded: there is no MediaRecorder and no canvas capture here.

export type CameraState = "off" | "starting" | "on" | "denied" | "unavailable";

export const camera = {
  state: "off" as CameraState,
  /** The user pressed "Start camera" once on this page: Mirror may start it again by itself. */
  consented: false,
  /** Why it last stopped, for the read-out. */
  lastStop: "never started",
  onChange: () => {},
};

let stream: MediaStream | null = null;
let attempt = 0;

/** Tracks still delivering frames: 0 whenever the camera is said to be off. */
export function liveTracks(): number {
  return stream ? stream.getTracks().filter((t) => t.readyState === "live").length : 0;
}

function set(state: CameraState) {
  camera.state = state;
  camera.onChange();
}

export async function startCamera(video: HTMLVideoElement) {
  if (camera.state === "on" || camera.state === "starting") return;
  camera.consented = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    set("unavailable");
    return;
  }
  const mine = ++attempt;
  set("starting");
  try {
    const got = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
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
    if (mine !== attempt) return;
    const name = err instanceof DOMException ? err.name : "";
    set(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable");
  }
}

export function stopCamera(video: HTMLVideoElement | null, reason: string) {
  const wasBusy = camera.state === "on" || camera.state === "starting";
  attempt++; // cancels a start in flight
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (video) video.srcObject = null;
  if (wasBusy) camera.lastStop = reason;
  // "denied" and "unavailable" stay on show until the next try.
  if (wasBusy) set("off");
}

/** Back to the "Start camera" placeholder after a refusal. */
export function resetCamera() {
  if (camera.state === "denied" || camera.state === "unavailable") set("off");
}
