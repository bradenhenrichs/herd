# Herd — project guide for Claude Code

A single-file, no-build progressive web app that logs into the **Herdwatch** livestock
API, shows a herd dashboard + records browser, and includes an LLM chat assistant.
It was reverse-engineered from the Herdwatch iOS app — there is **no official API**.
It is a personal-use client for the owner's own Herdwatch account and data.

## Stack & layout
- **No framework, no build step, no bundler.** Plain HTML + CSS + JS.
- `index.html` — the entire app. It contains two `<script>` blocks that share one
  global scope:
  1. **main app** — data loading, view/nav rendering, the Home dashboard, the live
     Herdwatch client, and the SVG chart renderer.
  2. **chat** — an Anthropic tool-use loop with a local query engine; reuses the
     chart renderer from the main script.
- `manifest.webmanifest`, `sw.js`, `icon-192.png`, `icon-512.png`,
  `apple-touch-icon.png` — PWA install + offline app-shell.
- Hosted on **GitHub Pages**; installed to iOS via Safari → Add to Home Screen.

## How the Herdwatch API works (hard-won — keep this accurate)
- Base host is **regional**: `https://mc<region>-prod.hwbe.io`
  (IE → `mcie-prod.hwbe.io`). Host / region / app-version are user-editable on the
  connect screen under "Advanced", and stored on `CFG`.
- All calls are **POST, JSON body, `credentials: "omit"`, only a `Content-Type`
  header** (no auth header, no cookies). Flow:
  1. `POST /tlogin` with `{username, password, countryCode, country, language,
     version, codeVersion, appVersion, deviceType}`
     → `{ success, token, url_token }`. **Use `url_token`.**
  2. `POST /api/2/` with `{ HWKEY: url_token, ...common }` → bootstrap; returns the
     farm profile including `farmIds[0].id` (the farm id) and herd metadata.
  3. `POST /api/2/get` with `{ HWKEY, farm, system_type: true,  lastSync: 0 }`
     → reference/lookup data (the enum tables).
     `POST /api/2/get` with `{ HWKEY, farm, system_type: false, lastSync: 0 }`
     → farm records (`animals`, `tasks`, `mobs`, `paddocks`, and more).
- **`HWKEY` (the url_token) goes in the request BODY on every authenticated call**,
  not in a header. This is set by the app's `post()` helper.
- **"common" body fields required on every call:** `source:"farmer"`, `country`,
  `countryCode`, `region`, `deviceType:"ios"`, `dbAdapter:"sqlite"`, `version`,
  `codeVersion`, `appVersion`, `deviceId`.
- **VERSION GATE:** the API returns `HTTP 426 {"error":"Please upgrade your
  application to the latest version."}` unless the body carries `version` set to a
  current app version (currently **`9.9.28`**) alongside the deviceType fields. This
  string **goes stale**: when 426s reappear, bump the "App version" field (i.e.
  `CFG.version`) to the current app version. Re-derive it from a fresh `.ipa` by
  grepping the `www` bundle for `tm={version:"..."}`.
- **CORS is open:** `access-control-allow-origin: *`, `POST` allowed; only
  `Content-Type` is in the allow-headers list and cookies aren't used — so
  browser-direct calls work with credentials omitted. **No proxy is needed.**
- **Firebase** config ships inside the app bundle, but the REST API authenticates via
  `HWKEY`, **not** Firebase. `system_type` is the enum lookup table (`id` →
  `displayName`); the app resolves all coded values (breed, sex, status, milking
  status, species, event types…) through it (`LOOKUP`).
- **Demo herd** (shared, read-mostly, resets periodically): password `demo1234`,
  username is a per-region dummy phone number. IE demo user: `0861234567`.

## Code map — `index.html`, main script
- `ingest(objs)` — merges entities from one or more payloads (API or dropped JSON
  files); builds `LOOKUP` from `system_type`; calls `detectFields` then `bootUI`.
- `detectFields(animals)` — **schema-adaptive**: finds the tag/name/sex/breed/dob/
  status/mob fields by name pattern *and* whether they're actually populated. `tag`
  prefers a real populated tag field over compound `*Tag` fields. `tagOf(item)`
  returns a safe headline value (never the literal `null`).
- `disp(v)` — display formatter: resolves enum codes via `LOOKUP`, formats `{date:ms}`
  or bare epoch-ms as dates, booleans, and arrays. Used everywhere for output.
- **Views:** `render()` dispatches Home vs List. `renderHome()` + `computeHome()`
  build the dashboard (composition + age charts, attention strip for overdue tasks,
  stat strip, records list). `renderList()` + `rowContent()` + `renderDetail()` are
  the herd/records browser (search, filter chips, master-detail). `facets()` builds
  the filter chips. `switchTo(target)` handles navigation. Animal rows carry a
  status badge (green `.good` for on-farm-ish statuses, neutral otherwise); overdue
  task rows get a rust left accent (`.row.overdue`). The animal detail view is
  sectioned into Identity / Breeding / Health / Movement / Other by `sectionOf(k)`
  (name-pattern based, with the detected `F.*` headline fields pinned to their
  group); sections that are entirely empty hide with the "show empty fields" toggle.
- **Nav:** `buildNav()` renders the same items into `#sidenav` (desktop sidebar) and
  `#bottomnav` (mobile tab bar): Home, Herd, Tasks, Ask.
- **Live client:** `post()`, `login()`, `sync()`, `connect(creds)`, `refresh()`.
- **Offline copy:** a successful `sync()` saves `{when, profile, payloads}` to
  `localStorage` (`herd:lastSync`) via `saveCache()` — **data only, never the token
  or credentials**, and never for the demo herd. The connect screen grows an
  "Open last sync — <when>" button when a copy exists (`openCachedSync()`), and the
  copy auto-opens when the app launches offline. Home's hero shows "synced <when>"
  live, "offline copy from <when>" when viewing the cache. Saving is best-effort
  (quota errors clear the key silently).
- **File mode:** `loadFiles()` accepts dropped `farmdata.json` + `reference.json` for
  offline / no-login use.
- **Charts:** `chartSVG(type, series)` + `barSVG` / `pieSVG` / `lineSVG` —
  self-contained SVG, no chart library. (Defined in the chat script; both scripts
  share global scope, so the dashboard reuses them.)

## Chat assistant — `index.html`, chat script
- Calls the **Anthropic Messages API directly from the browser** using the user's own
  API key (header `anthropic-dangerous-direct-browser-access: true`). The key is
  entered at runtime via the ⚙ panel, held **in memory only, never persisted**. The
  endpoint is configurable (can be pointed at a proxy).
- **Tool-use loop** (`llmTurn`): Claude is given two tools — `query_herd` (exact
  counts / filters / groupings / aggregates computed locally by `runQuery`) and
  `make_chart` (renders a bar/pie/line chart from a query). **Herd data stays on the
  device;** only the user's questions and small results go over the wire.
- `buildSystem()` builds the system prompt from the loaded schema (field list, date
  fields, enum fields, and derived `ageYears` / `ageMonths`).

## Design system
- **Palette:** paper `#F4F5F1`, card `#FFFFFF`, ink `#1A1E16`, muted `#6B7266`, line
  `#DADED3`, pasture green `#2F6B34` (primary / active state), accent-weak `#E4EFE2`,
  rust `#A5402A` (alerts only). Chart series palette is `PIE`.
- **Type:** system San Francisco for UI; **monospace only for tags / IDs** (they are
  codes, so mono is meaningful, not decorative). Sentence case; no ALL-CAPS labels.
- **Layout:** bottom tab bar on mobile (< 860px), left sidebar on desktop. The Home
  dashboard is the landing view.
- **Conventions:** resolve coded values through `LOOKUP` everywhere; never surface a
  raw enum code or the literal string `null`; keep alerts to the single rust colour;
  don't reach for gradients or drop-shadow card grids.

## Dev workflow (no build)
- Edit `index.html` directly — that's the whole app.
- **Test locally:** `python3 -m http.server 8000` in this folder, then open
  `http://localhost:8000/` (the chat and the service worker both work over
  `localhost`). Opening the file over `file://` shows a drop-zone instead of
  auto-loading and won't register the service worker — use the local server.
- **Deploy:** commit + push to the GitHub Pages branch; Pages redeploys in ~1 minute.
- **IMPORTANT:** whenever `index.html` (or any shell file) changes, **bump the cache
  name in `sw.js`** (`herd-v1` → `herd-v2` → …) or the old cached shell keeps being
  served after deploy. The service worker deliberately **never** caches API calls
  (`hwbe.io`, `herdwatch.com`, `api.anthropic.com`).

## Ideas / roadmap (not yet done)
- Purpose-built views for heavy record types (Reports, Fertilisers) instead of the
  generic list.
- Optional: a small key-holding proxy so the chat's API key isn't re-entered each
  launch and never touches a public page.

## Guardrails
- Personal-use client for the owner's own account and data — keep it that way. Don't
  add anything that scrapes, automates, or touches other people's accounts.
- **Never commit secrets** (API keys, session tokens). The Anthropic key is
  runtime-only by design; keep it that way.
