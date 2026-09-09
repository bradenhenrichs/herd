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
  files); builds `LOOKUP` from `system_type`; calls `detectFields`, then `buildRefs`,
  then `bootUI`.
- `detectFields(animals)` — **schema-adaptive**: finds the tag/name/sex/breed/dob/
  status/mob fields by name pattern *and* whether they're actually populated. `tag`
  prefers a real populated tag field over compound `*Tag` fields. `tagOf(item)`
  returns a safe headline value (never the literal `null`).
- `buildRefs()` — builds `REF`, a global map of every entity's `id` (and, for animals,
  their tag) → a human name, so **cross-entity reference fields resolve to names, not
  raw ids**. Animals headline by tag; other entities (mobs, paddocks, …) by their
  `name`/`title` field. This is what turns `mob:"m1"` into "Milkers", `paddock` into a
  field name, and a `dam`/`sire` internal id into the referenced animal's tag.
- `disp(v)` — display formatter: resolves enum codes via `LOOKUP`, then entity
  references via `REF`, formats `{date:ms}` or bare epoch-ms as dates, booleans, and
  arrays. Used everywhere for output. Reference resolution is string-only (a numeric
  quantity is never mistaken for an id).
- `humanize(k)` — turns a field key into a label: whole-key overrides (`LABELS`), then
  per-word acronym casing (`ACR`: AI, TB, EID, DNA, ICBF, …) and abbreviation spell-out
  (`ABBR`: est→Estimated, qty→Quantity, …). It also strips a trailing "type id" / "id" /
  "type" (the value is resolved to a name, so the suffix is noise: `unitTypeId`→"Unit",
  `breedId`→"Breed"). Add jargon here rather than in call sites.
- `combineUnits(item)` — pairs a numeric quantity field with its unit field so a record
  reads the way a farmer says it (`purchasedAmount:1000` + `unitTypeId:"kg"` → one row,
  "1000 kg"); the standalone unit row is folded away. Used by `renderDetail` for all
  record types. Each unit pairs with the nearest quantity field by key position.
- **Recommendations (`computeRecs`)** — a local, deterministic rules engine that is the
  heart of the Home screen: overdue tasks, weaning-age calves, weighing gaps, missing
  dam, cull review, TB-test interval, scanning-due, active medicine withdrawals, calving
  windows. Every card and the exact animals behind it are computed on-device (the
  assistant never invents a count); each rule is **guarded** by whether the needed
  fields/records exist, so it stays quiet on a herd that doesn't carry that data.
  `herdSignals()` builds per-animal aggregates (last weight, withdrawal-until) by matching
  other entities back to animals via `animalIndex`/`recordAnimal`. Recs are grouped by who
  acts and when — **now** (in-house), **book** (needs the vet/a booking), **watch**
  (a constraint, not a task) via `REC_GROUPS`; a red stripe still marks a real alert in any
  group. Dismissed recs persist in `localStorage` `herd:handled`.
- **Reminders / write seam** — `writeAdapter` (create/setDone/remove) backs on-device
  reminders in `localStorage` `herd:reminders`; `reminderTasks()` folds them into the Tasks
  list. **This is the seam for future Herdwatch write-back**: when write endpoints are known,
  swap the adapter bodies to POST and keep the call sites. `toast()` is the transient confirmation.
- **Chat-first shell:** the app is **conversation-first** — it opens into **Collie**
  (the assistant), not a dashboard. `render()` is a screen router over `STATE.view` ∈
  `assistant` | `list` | `numbers`; `switchTo(target,opts)` changes screen (a tab key →
  list, `numbers`, or `assistant`). A slide-in **drawer** (`buildNav`/`navItems`,
  `openDrawer`/`closeDrawer`) holds the secondary destinations — Ask Collie, then Herd,
  Tasks, each record entity, By the numbers. The top bar is menu / title / (on the
  assistant only) settings + new-chat.
- **Collie's opening turn:** `renderAssistant()` renders the day's recommendations as the
  first thing in the conversation (`recFeedHTML` → greeting + grouped rec cards, injected
  at the top of `#chatMsgs`, preserved above any messages), plus suggestion chips from the
  recs. It needs no API key — the recs are local. `renderNumbers()` is the demoted charts
  screen (built from `computeHome()`). The old `renderHome` dashboard is gone.
- **Views:** `renderList()` +
  `rowContent()` + `renderDetail()` are
  the herd/records browser (search, filter chips, master-detail). **Herd list:** on a
  wide screen (`isWide()`, ≥760px) the animals tab renders a sortable multi-column
  **table** (`renderAnimalsTable`) with a **column picker** (`colOptions` / `STATE.cols`,
  persisted to `localStorage` `herd:cols`, `renderColsPanel`) and a **CSV download**
  (`toCSV` / `downloadCSV`); on a phone it stays card rows whose meta follows the same
  chosen columns. `#viewList.astable` / `.hassel` classes flip the layout so the table
  goes full-width until an animal is selected, then the detail opens in a 400px pane.
  **Animal detail** has Details / Progeny / History tabs (`STATE.detailTab`): `progenyOf`
  finds animals whose dam/sire reference resolves back to this animal (`idsOf` collects
  its id/tag/mgmt identifiers); `historyOf` gathers records from other entities that
  reference the animal into a date-sorted timeline (`historyEntry` picks date/label,
  `measureText` formats the amount via `combineUnits` or a unit-suffixed number). `facets()` builds
  the filter chips. `switchTo(target)` handles navigation. `taskInfo(t)` is the one
  reading of a task (title / due date / status / overdue), shared by the dashboard's
  attention strip and the task list — keys are resolved **per task** (task records
  vary by type, so never sample only `tasks[0]`), a `due`-named key beats generic
  date keys, and created/completed/updated dates are never the deadline. The **task list**
  has status filter chips (Open / Overdue / Done / All via `STATE.taskFilter`, default
  Open so done tasks are hidden) and sorts overdue → soonest-due → undated → done
  (`taskPasses` / `taskCmp`); the dashboard's overdue strip opens Tasks pre-filtered to
  Overdue (`data-task` on the strip). Animal rows carry a
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

## Chat assistant (Collie) — `index.html`, chat script
- **Collie** is the assistant and the app's primary surface (named after a working farm
  dog; paw mark `PAW` as its avatar; persona set in `buildSystem()`). The conversation is
  the landing screen — see the chat-first shell above.
- Calls the **Anthropic Messages API directly from the browser** using the user's own
  API key (header `anthropic-dangerous-direct-browser-access: true`). The key is
  entered at runtime via the ⚙ panel, held **in memory only, never persisted**. The
  endpoint is configurable (can be pointed at a proxy).
- **Tool-use loop** (`llmTurn`): Claude is given read tools — `query_herd` (exact
  counts / filters / groupings / aggregates computed locally by `runQuery`) and
  `make_chart` — plus **action tools** that drive the app: `open_animal`, `filter_herd`
  (sets `STATE.recSet` + banner), `create_reminder`, `mark_done`, `show_recommendations`.
  `runTool` executes them against local state via the same `writeAdapter`/`render` the UI
  uses. **Herd data stays on the device;** only the user's questions and small results go
  over the wire.
- **Voice:** a mic on the compose uses `SpeechRecognition`/`webkitSpeechRecognition`
  (`setupVoice`) for dictation — the button hides where the API is absent (keyboard
  dictation still works), so there's no dead end. A "Read answers aloud" setting
  (`CFG.speak`) speaks assistant replies via `speechSynthesis` (`speak()`).
- The assistant is reachable everywhere: the Home **ask bar** and per-card **Ask** buttons
  call `openChat(seed)`, which sends a context-seeded question (held in `pendingSeed` until
  a key is added).
- `buildSystem()` builds the system prompt from the loaded schema (field list, date
  fields, enum fields, derived `ageYears`/`ageMonths`) and describes the action tools.

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
- **Herdwatch write-back** — the reverse-engineered API is read-only here, so reminders
  and "mark done" live on the device (`writeAdapter`). Capturing the real write endpoints
  from the app would let the adapter POST tasks/events back to Herdwatch.
- **MCP connector** — an optional, local-first, read-only MCP server that exposes the
  herd to the user's own ChatGPT/Claude (reuses the auth flow + query engine). Trades the
  "data stays on device" guarantee for the convenience of an existing assistant, so it is
  strictly opt-in.
- Purpose-built views for heavy record types (Reports, Fertilisers) instead of the
  generic list.
- Optional: a small key-holding proxy so the chat's API key isn't re-entered each
  launch and never touches a public page.

## Guardrails
- Personal-use client for the owner's own account and data — keep it that way. Don't
  add anything that scrapes, automates, or touches other people's accounts.
- **Never commit secrets** (API keys, session tokens). The Anthropic key is
  runtime-only by design; keep it that way.
