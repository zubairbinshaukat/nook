// The scenarios claude-preview.ts can play, as the sidebar offers them: each one
// is a query string. Choosing one replaces every scenario key in the URL.

export interface Preset {
  label: string;
  /** The scenario's parameters, as a query string ("" is the default one). */
  q: string;
}

export const PRESET_GROUPS: { title: string; items: Preset[] }[] = [
  {
    title: "Cards",
    items: [
      { label: "At work", q: "view=overview" },
      { label: "Writing a file", q: "view=session&live=1" },
      { label: "File written last", q: "view=session" },
      { label: "Changes", q: "view=session&list=1" },
      { label: "A file's diff", q: "view=session&list=1&file=1" },
      { label: "Session stopped", q: "view=session&idle=1" },
      { label: "Question", q: "view=question" },
      { label: "Question, several answers", q: "view=question&multi=1" },
      { label: "Three questions", q: "view=question&many=1" },
      { label: "Permission", q: "view=approval" },
      { label: "Permission, an edit", q: "view=approval&diff=1" },
      { label: "Finished", q: "view=finished" },
      { label: "What Claude said", q: "view=session&answered=1" },
    ],
  },
  {
    title: "Replies",
    items: [
      { label: "In VS Code", q: "view=session&reply=1&target=vscode" },
      { label: "In Cursor", q: "view=session&reply=1&target=cursor" },
      { label: "In a terminal", q: "view=session&reply=1&target=wt" },
      { label: "A very long reply", q: "view=session&reply=long&target=vscode" },
      { label: "Finished: Read reply", q: "view=finished&reply=1&target=vscode" },
    ],
  },
  {
    title: "Home",
    items: [
      { label: "0 sessions", q: "home=0" },
      { label: "0, no hooks", q: "home=0&hooks=0" },
      { label: "1 session", q: "home=1" },
      { label: "4 sessions", q: "home=4" },
      { label: "8 sessions", q: "home=8" },
      { label: "8 asking", q: "home=needs" },
      { label: "Long name", q: "home=long" },
      { label: "Needs your decision", q: "home=4&decision=1" },
      { label: "The bot's card", q: "home=1&decision=main" },
      { label: "2 subagents", q: "home=4&subs=two" },
      { label: "A subagent asks", q: "home=4&subs=asking" },
      { label: "Stopped, subagents run", q: "home=4&subs=stopped" },
    ],
  },
  {
    title: "Usage and metrics",
    items: [
      { label: "Usage stale", q: "home=4&usage=stale" },
      { label: "Usage reset", q: "home=4&usage=reset" },
      { label: "Resets in 20 s", q: "home=4&usage=soon" },
      { label: "Usage 3 h old", q: "home=4&usage=old" },
      { label: "No usage", q: "home=4&usage=none" },
      { label: "Usage off", q: "home=4&usage=off" },
      { label: "No CPU yet", q: "home=4&metrics=wait" },
    ],
  },
  {
    title: "Folded",
    items: [
      { label: "Folded, 4 sessions", q: "home=4&fold=1" },
      { label: "Worst case", q: "home=6&fold=1&metrics=worst&usage=worst" },
      { label: "0 metrics", q: "home=4&fold=1&cells=none" },
      { label: "0 sessions", q: "home=0&fold=1" },
      { label: "9 sessions", q: "home=9&fold=1" },
      { label: "Narrow screen", q: "home=9&fold=1&screen=800" },
    ],
  },
  {
    title: "Subagents",
    items: [
      { label: "Subagents", q: "view=session&subagents=1&sessions=1" },
      { label: "A subagent asks", q: "view=approval&subagents=1" },
      { label: "Two subagents ask", q: "view=approval&subagents=1&queued=1" },
      { label: "A subagent's question", q: "view=question&subagents=1&ask=question" },
      { label: "Stop, subagents running", q: "view=session&subagents=1&ask=none&stop=early" },
      { label: "The turn really ends", q: "view=session&subagents=1&ask=none&stop=real" },
      { label: "No agent ids", q: "view=session&subagents=1&ids=missing" },
    ],
  },
  {
    title: "Shelf",
    items: [
      { label: "Shelf", q: "home=4&tab=shelf" },
      { label: "Every widget hidden", q: "home=4&tab=shelf&hidden=all" },
      { label: "Two hidden", q: "home=4&tab=shelf&hidden=mirror,media" },
      { label: "Another order", q: "home=4&tab=shelf&order=projects,timer,reminders" },
    ],
  },
];

/** Every key claude-preview.ts reads for the scenario (the stage's own are in options.ts). `target` is the island's and stays. */
export const SCENARIO_KEYS = [
  "view", "live", "list", "file", "idle", "answered", "multi", "many", "diff", "reply", "sessions", "subagents", "ask", "stop",
  "ids", "queued", "asked", "step", "phantoms", "quiet", "home", "hooks", "decision", "subs", "usage", "metrics", "gpu", "cells",
  "fold", "screen", "tab", "hidden", "order", "check",
] as const;
