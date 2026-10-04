// DEV ONLY. A made-up Nook for the Shelf in a plain browser (`npx vite`): its
// saved state lives in the browser's own storage, and what only Nook can do
// (the system player, the project folders) answers with made-up data.
// backend.ts loads this file on a dev server outside Tauri only, and a build
// leaves it out.

import type { MediaInfo, ProjectInfo } from "../core/bridge";

const KEY = "nook.shelf.fake.";

export function load(widget: string): unknown {
  try {
    const raw = localStorage.getItem(KEY + widget);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function save(widget: string, value: unknown): boolean {
  try {
    localStorage.setItem(KEY + widget, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// ── A made-up player ──────────────────────────────────────────────────────────

const TRACKS = [
  { title: "Paper Lanterns", artist: "The Low Tides", seconds: 214 },
  { title: "Night Bus Home", artist: "Marlowe & Finch", seconds: 187 },
  { title: "Soft Static", artist: "Juniper Vale", seconds: 245 },
];
const player = { index: 0, playing: true, at: 47, since: Date.now(), volume: 64 };

function position(): number {
  const track = TRACKS[player.index];
  return Math.min(track.seconds, player.playing ? player.at + (Date.now() - player.since) / 1000 : player.at);
}

export function mediaState(): MediaInfo {
  const track = TRACKS[player.index];
  return {
    kind: "session", reason: null, title: track.title, artist: track.artist, album: "Made up", app: "Fake player",
    playing: player.playing, positionMs: Math.round(position() * 1000), durationMs: track.seconds * 1000,
    canPrevious: true, canNext: true, canToggle: true, trackKey: `fake|${track.title}`,
  };
}

export function mediaControl(action: "previous" | "toggle" | "next"): boolean {
  if (action === "toggle") {
    player.at = position();
    player.playing = !player.playing;
  } else {
    player.index = (player.index + (action === "next" ? 1 : -1) + TRACKS.length) % TRACKS.length;
    player.at = 0;
  }
  player.since = Date.now();
  return true;
}

// ── Made-up project folders: nothing is launched, it is only said ─────────────

export function projectsList(): ProjectInfo[] {
  const now = Date.now();
  return [
    { path: "D:\\work\\personal\\nook", name: "nook", at: now - 2 * 60_000 },
    { path: "D:\\work\\korus", name: "korus", at: now - 60 * 60_000 },
    { path: "D:\\work\\clients\\sbe-hub", name: "sbe-hub", at: now - 26 * 3_600_000 },
    { path: "D:\\work\\personal\\ig-post", name: "ig-post", at: now - 5 * 86_400_000 },
  ];
}

export function projectsLaunch(program: "code" | "wt", path: string): boolean {
  console.info(program === "code" ? `would run: code "${path}"` : `would run: wt.exe -d "${path}" claude`);
  return true;
}

export const mediaVolume = (): number => player.volume;
export const mediaSetVolume = (percent: number) => void (player.volume = percent);
