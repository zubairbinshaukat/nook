# Screenshots

The pictures on the website guides and in the README come from one command. Automatic shots are drawn from the dev
stage (a made-up Windows desktop with the real island, driven by made-up sessions) and from the Settings page in its
fake mode, then encoded to small WebP files in `site/assets/img/shots/`. A few need the real Windows UI and are
taken by hand (table below).

## Run it

From `windows/`:

```powershell
npm ci
npm run shots                          # every auto shot, dark and light, into site/assets/img/shots/
npm run shots -- --only hero,dock-left # some shots
npm run shots -- --theme light         # one theme
npm run shots -- --125 --only hero     # at Windows' 125 % scaling; files get a -125 suffix (--150, --200, --scale 175)
npm run shots -- --size 1280x720 --only hero
npm run shots:list                     # the manifest as a table
npm run shots:check                    # every auto file present? every manual file present? exit 1 if not
npm run shots:stage                    # the older, quick set of stage PNGs into windows/shots/ (git-ignored)
```

It needs Edge or Chrome and Node 22 or newer. It reuses the dev server on <http://127.0.0.1:1420> when one answers,
otherwise it starts `vite` on a free port and stops it at the end (`--keep-server` leaves it; `--base-url` points
at another one). Other flags: `--out DIR`, `--budget KB` (override every budget), `--quality N` (start quality,
default 90), `--browser EXE`. The run fails (exit 1) on a page error, a missing crop selector, a manifest typo or
a shot that takes more than 30 s.

Each image is captured by the browser as WebP at quality 90, then 85, 80, 75, 70 until it is under its budget
(`budgetKB`, 150 by default, the hero 320). A loud warning follows if it is still over at 70.
`site/assets/img/shots/shots.json` lists `{id, variant, file, width, height, bytes, alt}` for every image, for the
`width`/`height` attributes. A file is rewritten only when its pixels changed; some idle animation in the island
makes a few stage shots differ by a few pixels from run to run, so after a full run use `git status` and keep only
the images you meant to change (or run with `--only`).

## The manifest

`windows/scripts/shots.json`: `defaults` plus a `shots` list. To add a shot, add an entry and run
`npm run shots -- --only <id>`, then put the figure in the page (copy the markup of an existing `figure.shot`).

| Field | Meaning |
|---|---|
| `id`, `out` | unique id; file base name (lowercase, digits, dashes). Files are `out-dark.webp` and `out-light.webp` |
| `kind` | `auto` or `manual` |
| `used-in` | pages (`guides/first-run#tour`, `README.md`) |
| `page` | `stage` (`/dev/claude-preview.html`), `settings` (`/dev/settings-frame.html`: the Settings fake page in a Windows-style window with a shadow, on a transparent background) or `agents` |
| `params` | query string or object: the keys of `windows/dev/README.md` (stage) or the fake-mode keys at the top of `src/settings/fake.ts` (settings). `theme`, `shot`, `w`, `h`, `time`, `date`, `seed`, `motion`, `wallpaper` and `scale` are added by the script |
| `size` | `WxH`: the stage's display, or the Settings window |
| `scale` | percent (default 100); `--125` etc. override it |
| `crop` | `{selector, pad}` (e.g. `#island` plus 40 px) or `{x,y,w,h}` in CSS px; clamped to the page; none = everything |
| `variants` | `["dark","light"]` (default); `[]` for a manual shot with one file |
| `wallpaper` | `nook` (default) or `bloom` |
| `frame` | `false` for a bare Settings window |
| `alt`, `budgetKB`, `notes` | alt text; size budget; what the shot shows |

## Wallpaper rule

Only `wallpaper: nook` (Nook's own picture, committed) may be used for anything written into the repo. `bloom` is
Microsoft's Windows 11 artwork, kept local in `windows/dev/stage/assets/` (git-ignored); the script refuses to write a
`bloom` shot into a folder inside the repo. Use it only with `--out` pointing outside the repo.

## How the pages use them

Each `figure.shot` holds a dark and a light `<img>` (`.shot-dark` / `.shot-light`); `site.css` shows the one
that matches the site's own theme (`data-theme` from the toggle, else `prefers-color-scheme`). The README uses
`<picture>` with the GitHub theme. A manual shot that is still missing is an HTML comment
`<!-- TODO screenshot: <id> (see docs/screenshots.md) -->` (or the old "Screenshot coming" box) at the spot.
When you have the file, run `shots:import` (below), replace the comment or box with
`<figure class="shot"><img class="shot-img" src="/assets/img/shots/<file>" width=".." height=".." alt=".." loading="lazy" decoding="async"><figcaption>..</figcaption></figure>`
and run `npm run shots:check`. `npm run shots:import` does the conversion and prints that markup (a single image, no dark/light pair, uses just `class="shot-img"`).

## Manual shots

Take them on Windows 11 at 100 % scaling, light or dark as noted, with no private paths, names or other windows in view.
Then import each one with a single command (from `windows/`):

```powershell
npm run shots:import -- C:\path\to\shot.png --id install-smartscreen
npm run shots:import -- shot.png --id <id> [--variant dark|light] [--width N] [--quality 90] [--budget KB] [--crop x,y,w,h] [--blur x,y,w,h]... [--force]
```

`shots:import` converts the PNG or JPEG to WebP with the same Edge or Chrome as `shots`, keeps the aspect ratio (the table
size is only a hint: a source over twice that wide is scaled down to 2x, a smaller one keeps its size), strips metadata, cuts out `--crop x,y,w,h` (source pixels) first when given (use it to leave desktop around a dialog out of the picture),
hides private details with `--blur x,y,w,h` (see Privacy below),
steps the quality from 90 down to 70 until the file is under the budget (150 KB), and writes
`site/assets/img/shots/<id>.webp`, that folder's `shots.json` and the new size into the manifest. It then prints the
`<figure>` to paste at the TODO spot in the guide (nothing to paste when the guide already has it), and refuses an
unknown id or an auto shot (`--force` overrides the latter). Retaking a shot is the same command again.
`npm run shots:check` lists what is still missing. Never commit the original PNG.

### Hiding private details (`--blur`)

A screenshot of a real desktop can show your Windows user name (in `C:/Users/<name>/...` paths, an Explorer address bar)
or other private text. Prefer `--crop` when the detail is at an edge. For text in the middle of a picture use
`--blur x,y,w,h`, which can be given several times (one rectangle per line of text):

```powershell
npm run shots:import -- shot.png --id hooks-in-claude-code --blur 182,129,37,15 --blur 182,186,37,15
```

- **Coordinates** are in pixels of the ORIGINAL source image, the same grid as `--crop`. Blur is applied to the whole
  source first, then `--crop` is cut and the width rules apply. A rectangle outside the image fails the import.
- **What it does**: the rectangle becomes a mosaic of 8 px blocks (each block is the average colour of that part), drawn
  on the canvas before the WebP is encoded. The original pixels are not kept anywhere, so it cannot be undone. Make the
  rectangle just wider than the text (a pixel or two of margin) so the neighbouring characters stay readable.
- **Measure** by cropping a small area with `--crop` and a large `--width` into a scratch folder (`--out DIR`), then read
  off the character positions.
- **Always open the finished WebP** and check that the text really is unreadable, then delete the original screenshot.
| id | state | size | what to capture | used in | import |
|---|---|---|---|---|---|
| `install-release-page` | provided | 1229x617 | Browser at github.com/zubairbinshaukat/nook/releases/latest, assets list expanded, the installer and SHA256SUMS.txt rows highlighted (a red or accent box). Crop to the page, no other tabs or bookmarks. | guides/install | `npm run shots:import -- <file> --id install-release-page` |
| `install-smartscreen-first` | provided | 534x496 | The SmartScreen dialog as it first appears, before More info is clicked (a More info link and only Don't run). Capture the dialog only (Win+Shift+S, window snip), no desktop around it. | guides/install#smartscreen | `npm run shots:import -- <file> --id install-smartscreen-first` |
| `install-smartscreen` | provided | 534x498 | Run the installer on Windows 11: in the blue SmartScreen dialog click More info so the Run anyway button shows. Capture the dialog (Win+Shift+S, window snip). Needs the real Windows UI. | guides/install, guides/troubleshooting#smartscreen | `npm run shots:import -- <file> --id install-smartscreen` |
| `install-wizard` | provided | 499x388 | Run Nook-Windows-0.2.1-setup.exe past SmartScreen and capture the first page of the installer window (not the last). Window snip, 100 % scale. | guides/install#run-installer | `npm run shots:import -- <file> --id install-wizard` |
| `tray-menu` | provided | 248x265 | Windows 11, dark taskbar, 100 % scale. Open the hidden-icons chevron, right-click the Nook icon so its menu is open, then snip the menu plus the icon row (Win+Shift+S rectangle). Needs the real tray. | guides/install#run-installer, guides/troubleshooting#island-missing | `npm run shots:import -- <file> --id tray-menu` |
| `log-folder` | provided | 620x230 | File Explorer at %LOCALAPPDATA%\Nook (type it in the address bar), details view so file names and sizes show. Hide your user name in the address bar if it is visible (blur or crop). | guides/install#where-files, guides/troubleshooting#collect-logs | `npm run shots:import -- <file> --id log-folder --crop 162,128,620,230` |
| `log-file` | provided | 972x614 | nook.log open in Notepad (dark theme), text area only: crop out the title bar, menu and toolbar row, which show the account picture. | guides/troubleshooting#collect-logs | `npm run shots:import -- <file> --id log-file --crop 0,84,972,614` |
| `hooks-in-claude-code` | provided | 889x786 | Install the hooks, start `claude` in a terminal, type /hooks and capture the list that shows the nook-hook.exe entries. Use a dark terminal at a readable font size; crop to the list. Hide any private path. | guides/claude-code-hooks#diagnose | `npm run shots:import -- <file> --id hooks-in-claude-code` (user name blurred with 12 `--blur` rectangles) |
| `cursor-hooks-panel` | provided | 761x692 | After Settings -> Cursor -> Install hooks and a restart of Cursor, open Cursor's Hooks view (Cursor Settings) and capture the list with Nook's entries. Crop to the panel. | guides/cursor#setup | `npm run shots:import -- <file> --id cursor-hooks-panel` (user name blurred with 10 `--blur` rectangles) |
| `camera-privacy` | provided | 1014x620 | Windows 11 Settings -> Privacy & security -> Camera, scrolled so the 'Let desktop apps access your camera' switch is visible and on. Light or dark, 100 % scale. | guides/troubleshooting#camera | `npm run shots:import -- <file> --id camera-privacy` |
| `agents-list-real` | provided | 429x262 | In the real app turn on Settings -> Agents list with 3-4 real or fake-session sessions (npm run fake-session) so the small agents window shows rows. Snip the window with a bit of desktop around it; use the Nook wallpaper or a plain one. Not capturable in a plain browser. | README.md | `npm run shots:import -- <file> --id agents-list-real` |
| `real-approval-terminal` | provided | 1914x472 | Real Windows 11 desktop, a Claude Code permission prompt waiting in Windows Terminal and the real island open on the same request above it (use a throwaway project; no private paths, no other windows). Crop to the top of the screen and the terminal. | guides/first-run#approvals, README.md | `npm run shots:import -- <file> --id real-approval-terminal --crop 0,0,1914,472` |
| `cursor-session-list` | provided | 634x243 | Real Nook with one Claude Code session and one Cursor agent session running (Cursor hooks installed). Open the island on Home / the session list so both rows show; snip the island with 30 px around it over the Nook wallpaper or a plain desktop. | guides/cursor | `npm run shots:import -- <file> --id cursor-session-list` |
| `real-approval-command` | provided | 1916x772 | A PowerShell command permission prompt waiting in Windows Terminal with the real island open on the same request above it; crop to the top of the screen and the prompt. | guides/first-run#approvals | `npm run shots:import -- <file> --id real-approval-command --crop 0,0,1916,772` |
