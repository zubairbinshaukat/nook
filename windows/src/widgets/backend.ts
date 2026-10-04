// What the Shelf's widgets ask of Nook, in one place: the commands of
// core/bridge.ts that they use. Outside the app, on a dev server, a made-up
// Nook answers instead (fake.ts: the browser's own storage, a made-up player);
// a build leaves that file out altogether.

import { Bridge, IS_TAURI, type MediaInfo, type ProjectInfo } from "../core/bridge";

type Fake = typeof import("./fake");
const fake: Promise<Fake> | null = import.meta.env.DEV && !IS_TAURI ? import("./fake") : null;

export const ShelfBackend = {
  /** A widget's saved part, or null. */
  async load(widget: string): Promise<unknown> {
    if (fake) return (await fake).load(widget);
    return IS_TAURI ? Bridge.shelfLoad(widget) : null;
  },

  /** True when it was kept. */
  async save(widget: string, value: unknown): Promise<boolean> {
    try {
      if (fake) return (await fake).save(widget, value);
      if (!IS_TAURI) return false;
      await Bridge.shelfSave(widget, value);
      return true;
    } catch (err) {
      void Bridge.log(`shelf: ${widget} was not saved: ${String(err)}`);
      return false;
    }
  },

  // ── Media: the system's player, asked a call at a time ──────────────────────
  media: {
    async state(): Promise<MediaInfo | null> {
      if (fake) return (await fake).mediaState();
      return IS_TAURI ? Bridge.mediaState() : null;
    },
    async cover(): Promise<string | null> {
      if (fake) return null;
      return IS_TAURI ? Bridge.mediaCover() : null;
    },
    async control(action: "previous" | "toggle" | "next"): Promise<boolean> {
      if (fake) return (await fake).mediaControl(action);
      return IS_TAURI ? ((await Bridge.mediaControl(action)) ?? false) : false;
    },
    async volume(): Promise<number | null> {
      if (fake) return (await fake).mediaVolume();
      return IS_TAURI ? Bridge.mediaVolume() : null;
    },
    async setVolume(percent: number): Promise<void> {
      if (fake) return (await fake).mediaSetVolume(percent);
      if (IS_TAURI) await Bridge.mediaSetVolume(percent);
    },
  },

  // ── Projects: the folders sessions have run in, and two launchers ───────────
  projects: {
    async list(): Promise<ProjectInfo[]> {
      if (fake) return (await fake).projectsList();
      return (IS_TAURI ? await Bridge.projectsList() : null) ?? [];
    },
    async note(cwd: string): Promise<void> {
      if (fake) return;
      if (IS_TAURI) await Bridge.projectsNote(cwd);
    },
    async openInCode(path: string): Promise<boolean> {
      if (fake) return (await fake).projectsLaunch("code", path);
      return IS_TAURI ? ((await Bridge.projectsOpenCode(path)) ?? false) : false;
    },
    async newSession(path: string): Promise<boolean> {
      if (fake) return (await fake).projectsLaunch("wt", path);
      return IS_TAURI ? ((await Bridge.projectsNewSession(path)) ?? false) : false;
    },
  },
};
