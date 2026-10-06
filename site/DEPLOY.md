# Deploying the Nook website

The site is plain static files (no build step). Everything in this folder is the site. The domain is `nook.zubyr.dev`.

## Option A: Vercel (in use)

The site is deployed on Vercel, connected directly to this repo.

1. Vercel dashboard > the project > Settings > General > Root Directory: `site`. Framework preset: **Other** (static files, no build step).
2. Settings > Domains > add `nook.zubyr.dev`. Vercel shows the DNS record to add at the provider of `zubyr.dev` (usually a `CNAME` to `cname.vercel-dns.com`, or an `A` record if it's the apex domain).
3. Every push to `main` that touches `site/` redeploys automatically; no CNAME file or GitHub workflow is needed — Vercel manages the domain and TLS certificate itself.
4. `_headers` and `_redirects` are read natively by Vercel (same syntax as Netlify/Cloudflare Pages), so security headers and the `/download` redirect apply as-is.
5. Open https://nook.zubyr.dev/ and https://nook.zubyr.dev/guides/install/ to check.

## Option B: Cloudflare Pages

1. Cloudflare dashboard > Workers & Pages > Create > Pages > Connect to Git, pick the repo.
2. Framework preset: **None**. Build command: empty. Build output directory: `site`.
3. Custom domains > add `nook.zubyr.dev`. If zubyr.dev DNS is on Cloudflare this is one click.
4. `_headers` and `_redirects` are applied automatically (security headers, caching, /download redirect).

## Search engines

1. **Google Search Console**: add the property `https://nook.zubyr.dev/` (URL prefix, or the Domain property with a DNS TXT record), verify, then Sitemaps > submit `sitemap.xml`. Use URL Inspection > Request indexing for the home page and /guides/install/.
2. **Bing Webmaster Tools**: sign in, add the site (you can import it from Google Search Console), and submit `https://nook.zubyr.dev/sitemap.xml`.
3. **IndexNow tip**: after publishing or changing pages, ping IndexNow so Bing, Yandex and others re-crawl within minutes. Generate a key (any 8 to 128 hex characters), save it as `site/<key>.txt` containing just the key, then request `https://api.indexnow.org/indexnow?url=https://nook.zubyr.dev/&key=<key>` (or POST a list of URLs). Cloudflare also offers this as "Crawler Hints".
4. The sitemap lists every indexable page with `lastmod`. Update the dates when you change a page (`2026-10-04` is the current value).

## Keeping files in sync

- Pages carry "Last updated" dates, the sitemap carries `lastmod`, and `llms-full.txt` repeats the text of every page. When you change a page, update all three.
- CSS and JS are linked as `/assets/css/site.css?v=1` and `/assets/js/site.js?v=1` and cached for a year on Cloudflare/Netlify. Bump `v` in every page when you change them.
- The CSP in `_headers` allows one inline script by hash. If you edit the theme bootstrap script in `<head>`, recompute the hash (SHA-256, base64) and update `_headers`.

## Launch checklist

- [ ] Add real screenshots: replace each `<figure class="shot" data-shot="...">` with an `<img src width height alt>`. Placeholders are in the install, first-run and shelf-widgets guides (`install-1..3`, `first-run-1..3`, `shelf-1`). Use WebP or PNG with explicit width and height.
- [ ] Record a ~20 second demo (island folding and opening, approving a permission, jumping to a session) and add it to the home page; also use it in the GitHub README.
- [ ] Replace `assets/img/og.png` if the design changes (1200x630).
- [ ] GitHub repo: set the description and website (https://nook.zubyr.dev), and add the topics: `claude-code`, `dynamic-island`, `windows`, `tauri`, `ai-agents`, `developer-tools`, `nook`.
- [ ] Publish release 0.2.1 with `Nook-Windows-0.2.1-setup.exe` and `SHA256SUMS.txt`; check the Download buttons land on it.
- [ ] Submit the sitemap to Google Search Console and Bing Webmaster Tools; ping IndexNow.
- [ ] Share honestly: Product Hunt, Hacker News (Show HN), r/ClaudeAI. Say what it is, that it is free and open source, that the installer is unsigned for now, and that it is a fork of Coucou. Answer questions, take criticism well.
- [ ] Apply to the SignPath Foundation for free code signing when the project qualifies.
- [ ] Check https://nook.zubyr.dev/.well-known/security.txt and renew its `Expires` date before 2027-10-04.
- [ ] Optional: self-host the typeface and the Lenis script to remove the Google Fonts and jsDelivr requests, then tighten the CSP and update the privacy page.
