# Screenshot stage

`dev/claude-preview.html` is the real island, driven by made-up Claude Code sessions, standing on a made-up
Windows desktop (`dev/stage/`: Nook's own wallpaper, taskbar, desktop icons, generic browser / editor / terminal
windows; no product logos, no external assets). The URL steers everything. Dev only: not in `vite build`.

```
cd windows
npm run dev            # http://127.0.0.1:1420/dev/claude-preview.html
npm run shots          # the whole set into windows/shots/ (git-ignored)
node scripts/shot.mjs "home=4&scene=browser&theme=light" --out shots/x.png
```

Press `S` or `` ` `` (or the small corner button) for the sidebar: every control writes the URL, so a state is a
link. Unknown keys are ignored; invalid values fall back to the default. `shot=1` wins over `ui=1`.

## Stage keys

| Key | Values (default first) | Notes |
|---|---|---|
| `scene` | `desktop` `browser` `editor` `terminal` `none` | `browser`: the island over the tab strip |
| `theme` | `dark` `light` | wallpaper, taskbar, windows. `light=1` still works |
| `wallpaper` | `nook` `bloom` | `nook`: Nook's own silk-ribbon picture (committed, see below). `bloom`: the Windows 11 Bloom photo (local files, see below); Nook's shows when they are missing. `original` (old links) means `nook` |
| `taskbar` | `bottom` `top` `hidden` | docks follow the work area, as the app does |
| `dock` | `top` `bottom` `left` `right` | island's edge; bottom/sides sit in the work area |
| `time`, `date` | `10:09`, `10/6/2026` | taskbar clock text (`HH:MM`; any short text for the date) |
| `bg` | `#rrggbb` or `transparent` | page colour; for `scene=none` (flat or transparent) |
| `w`, `h` | px, 200..8192 | display size; default the window. `shot.mjs` sets both from `--size` |
| `scale` | `1`..`3` (`1.25`) | display scaling like Windows' 125 %; alias `zoom` |
| `seed` | integer | the made-up CPU/GPU numbers; shot mode uses 1 if absent |
| `motion` | `reduce` `full` | shot mode defaults to `reduce` (springs jump to their end) |
| `ui` | `0` `1` | sidebar open. It overlays: the stage never moves |
| `toggle` | `1` `0` | the corner button that opens the sidebar |
| `shot` | `0` `1` | capture mode: no sidebar, button, cursor or hover; numbers frozen; no stage animation |

Capture mode sets `<html data-ready="1">` and `window.__shotReady = true` once fonts are loaded and the island
has settled. The `S` key does nothing in it.

## Nook wallpaper

`wallpaper=nook` (the default) is Nook's own art: luminous silk ribbons (mint, blue, violet, one warm amber glint)
sweeping up from the lower left to a crest right of centre, on a near-black sky (dark) or a pale lilac one (light).
The top centre (island), the top-left icon column and the taskbar edge stay calm, and the subject keeps clear of
the edges so any 16:9 crop works. The files are `dev/stage/wallpapers/nook-dark.jpg` and `nook-light.jpg`
(3840x2400, committed). They are drawn procedurally by `dev/stage/wallpaper-gen/` (one WebGL fragment shader,
no dependency, no network) and rendered by headless Chrome or Edge with software WebGL. To regenerate, from `windows/`:

```
node scripts/make-wallpaper.mjs                    # both themes into dev/stage/wallpapers/
node scripts/make-wallpaper.mjs --theme light --size 1920x1200 --out shots/wp.jpg   # a quick look
```

Options: `--seed N` (1 is the committed picture; other seeds nudge the curves), `--quality` (0.9). To look at it
live: `dev/stage/wallpaper-gen/index.html?theme=light&fit=1`, from disk or the dev server. The ribbons are listed
at the top of `gen.js` (centre curve, width, twist) and the palette next to them.

## Bloom wallpaper (local only)

`wallpaper=bloom` puts
 Microsoft's Windows 11 Bloom wallpaper behind the stage: dark for `theme=dark`,
light for `theme=light`. The pictures are Microsoft's artwork, so they are NOT in the repo: `dev/stage/assets/` is
git-ignored and nothing there is committed or shipped. Without the files (a fresh clone) the stage silently shows
Nook's wallpaper instead, so nothing breaks. On a Windows 11 machine, set them up from `windows/`:

```
mkdir dev/stage/assets
copy C:\Windows\Web\Wallpaper\Windows\img19.jpg dev/stage/assets/wallpaper-dark.jpg
copy C:\Windows\Web\Wallpaper\Windows\img0.jpg  dev/stage/assets/wallpaper-light.jpg
```

(PowerShell: `New-Item -ItemType Directory -Force dev/stage/assets`, then `Copy-Item` with the same paths.) Both are
3840x2400, enough for 2560x1440 at dpr 2. Do not publish screenshots made with them as part of the repo or site
without checking Microsoft's terms; `wallpaper=nook` is the free-to-share look.

## Scenario keys (read by `claude-preview.ts`; the sidebar lists the usual ones)

`view=overview|session|question|approval|finished` (+ `live` `list` `file` `idle` `answered` `multi` `many` `diff`
`reply=1|long`), `target=claude|vscode|cursor|wt|powershell|cmd|none`, `home=0|1|4|8|9|needs|long` (+ `hooks=0`
`decision=1|main` `subs=two|asking|stopped|six`), `tools=claude,claude,cursor` (the tool of each home session) + `names=web,api,docs` (their folders), `fold=1`, `cells=`, `screen=<px>`, `usage=fresh|stale|reset|soon|old|warm|hot|worst|none|off`,
`metrics=live|worst|wait|off`, `gpu=none`, `tab=shelf` (+ `hidden=` `order=`), `sessions=1`, `subagents=1`
(+ `ask=question|none` `queued=1` `stop=early|real|silent|both|same` `ids=missing`), `phantoms=`, `quiet=<s>`, `step=read|run`, `asked=1`.

## Copy-paste links

```
http://127.0.0.1:1420/dev/claude-preview.html?home=4&theme=light
http://127.0.0.1:1420/dev/claude-preview.html?home=4&scene=browser&theme=light
http://127.0.0.1:1420/dev/claude-preview.html?view=approval&scene=editor
http://127.0.0.1:1420/dev/claude-preview.html?view=session&scene=terminal
http://127.0.0.1:1420/dev/claude-preview.html?home=4&dock=bottom&theme=light
http://127.0.0.1:1420/dev/claude-preview.html?home=4&dock=left
http://127.0.0.1:1420/dev/claude-preview.html?home=4&fold=1&taskbar=hidden&scale=1.25
http://127.0.0.1:1420/dev/claude-preview.html?home=4&scene=none&bg=transparent&shot=1
http://127.0.0.1:1420/dev/claude-preview.html?home=4&ui=1
```

## Capturing: `scripts/shot.mjs`

Node only, no dependency. Finds Chrome or Edge, drives it over DevTools, waits for `__shotReady`, saves the PNG.

```
node scripts/shot.mjs "<query or URL>" [--size 1920x1080] [--out file.png] [--dpr 2] [--transparent]
node scripts/shot.mjs --set [name,name]  [--out dir]     # the set; --list prints it
```

`--cli` uses the plain headless CLI with a virtual-time budget instead (less exact). `--base` or `$NOOK_DEV`
points at another dev server; `--browser` or `$CHROME_PATH` at another executable. The set: `hero-dark`,
`hero-light`, `dock-bottom`, `dock-left`, `dock-right`, `over-browser-tabs`, `over-editor`, `over-terminal`,
`approval`, `approval-diff`, `question`, `session`, `home`, `shelf`, `folded-metrics(-light)`, `agents`.
Page errors are printed. For a transparent PNG use `scene=none&bg=transparent` with `--transparent`.
