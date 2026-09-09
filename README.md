# Herd — deploy to your iPhone (GitHub Pages)

A self-contained herd viewer that logs into the Herdwatch API and adds an
"Ask" chat. This bundle turns it into an installable, offline-launching PWA.

## Files
- `index.html` — the app
- `manifest.webmanifest`, `sw.js` — PWA install + offline shell
- `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` — icons

## Put it online (free, ~5 min)
1. Create a new GitHub repo, e.g. `herd` (public is fine — no secrets are stored here).
2. Upload all six files to the repo root (drag them into GitHub's "Add file → Upload files").
3. Repo → **Settings → Pages** → Source: **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
4. Wait ~1 minute, then open the URL it shows (e.g. `https://<you>.github.io/herd/`).

## Install on the iPhone
1. Open that URL in **Safari** on the phone.
2. Share button → **Add to Home Screen**.
3. Launch from the new icon — it opens fullscreen and will open offline.

## Use it
- Tap **Ask** → the ⚙ button → paste your Anthropic API key (console.anthropic.com) and pick a model.
  The key stays in memory only; you re-enter it each launch. Requests bill to your account.
- To see the demo herd: on the sign-in screen tap **Use demo herd**. For your own animals,
  enter your Herdwatch phone number + password (and your region's host under Advanced).

## Updating later
- Re-upload `index.html`, and bump the cache name in `sw.js` (`herd-v1` → `herd-v2`)
  so the service worker refreshes instead of serving the old shell.
- If the API starts returning "upgrade your application", raise the **App version** field
  under Advanced to the current app version (re-grep `tm.version` from a fresh .ipa).

## Notes
- Offline launch shows the app shell; live herd data still needs a connection
  (the service worker deliberately never caches API responses).
- Data stays on the device; only chat questions and small results are sent to Anthropic.
