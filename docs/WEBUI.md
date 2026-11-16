# GameTorrent Web UI

A browser dashboard over the same pipeline the CLI (`../poc/poc.js`) uses —
see `../poc/pipeline.js`, which both share. Browse the catalog (default +
your own feeds), start downloads, watch live progress, and launch a
configured emulator once a download finishes.

## Why this exists / what it isn't

This was built to be **exposed on a LAN**, not just localhost — see
`ARCHITECTURE.md` for the reasoning. Because anyone who can reach it
could otherwise trigger downloads, every route except the login and sign-up
pages requires a session. It's a "provider" model: one admin runs the server
for other people. Accounts live in PostgreSQL (see "Accounts" below), with
two roles:
- **Admin**: starts downloads immediately, **approves or rejects** other
  users' game requests, **deletes** games from the server, and manages
  accounts (add/remove users) from the **Admin** tab.
- **Standard User**: browses the library, and clicking Download on a game
  files a **request** instead of starting anything — it only downloads once
  an admin approves it (see "Requests" below). Can cancel their own
  still-pending requests. Everything that changes shared setup — feeds,
  search providers, other people's download jobs, launching an emulator —
  is admin-only (enforced server-side; the buttons are also hidden).

### Accounts

- **Sign-up** (login page, "Create account"): anyone who can reach the app can
  ask for an account. Sign-ups are always standard users, whatever the request
  says. With `SIGNUP_MODE=approval` (the default) the new account waits under
  **Admin → Users** with status *Waiting for approval* until an admin clicks
  **Approve**; with `open` it works immediately; with `off` the button is
  gone and only admins create accounts. Limited to 5 sign-ups per hour per IP
  and 30 per hour in total.
- **Admins** (Admin tab → Users) can create accounts (with a temporary
  password the person must replace at first sign-in, ticked by default),
  approve sign-ups, disable / re-enable, make admin / standard, reset a
  password (again temporary), sign someone out everywhere, or delete.
- **Everyone** (Account button, top right) can change their own password
  (current one required; signs out their other browsers) and sign out every
  other browser. The box has two sections (**Change password**, **Other
  devices**); labels sit above their fields, the 12-128 character rule is a
  hint under the field, Escape or a click outside closes it (not while an
  admin-forced password change is pending), the sign-out result shows inside
  the box, and on a phone the buttons stack full width with the main action
  on top. (Before 2026-11-16 the labels sat beside the fields and the three
  buttons ran out of the box on narrow screens.)
- **Takes effect at once.** Every request re-reads the user from the database,
  so disabling, demoting or deleting someone affects their very next click,
  and those changes also delete their sessions.
- **The last active admin** can't be demoted, disabled or deleted, and nobody
  can change or delete their own account from the Admin tab. That check holds
  even when two admins act at the same moment (it runs under a database lock;
  `cicd/tests/api-selftest.js` races two admins demoting each other).
- **Passwords:** 12-128 characters, no composition rules. scrypt with
  N=2^15, r=8, p=3 (OWASP's recommendation), parameters stored in each hash so
  they can be raised later. Older hashes are upgraded at the next sign-in.
- **The first admin:** on a brand-new, empty database (and nothing to import),
  the app creates an admin from `WEBUI_USER` / `WEBUI_PASSWORD`. After that
  those two variables do nothing; manage accounts from the Admin tab.
- **Sessions** are stored in the database too, so a restart no longer signs
  everyone out. They end after 8 hours without activity, and 7 days after
  sign-in at most.

### Requests (the "provider" workflow)

Since one person runs this for others, a standard user's Download click
doesn't start a download — it creates a pending request (database table `game_requests`),
visible to that user under **My Requests** and to the admin under **Admin →
Pending requests**, with the title, detected console, and who asked for it.
The admin can:
- **Approve** — starts the exact same download job an admin's own Download
  click would (same pipeline, same ClamAV/hash/VirusTotal checks); the
  request is linked to the resulting job. The **Skip ClamAV scan** / **Skip
  VirusTotal lookup** checkboxes on the request card are the admin's choice,
  unticked by default. A request itself never carries scan or launch options,
  whatever the browser sends (before 2026-11-05 it could, and Approve replayed
  them unseen). A game downloaded with the scan skipped shows an **UNSCANNED**
  tag in the Library, and the skip is in the audit log.
- **Reject** — with an optional short reason, shown back to the requester.

An admin's own Download click always starts immediately — admins don't
request from themselves.

**Two people requesting the same game doesn't mean two downloads.** Requests
are matched by exact identity (same `gameId`, or same magnet/direct URL).
Approving one automatically approves every other still-pending request for
that same identity too, all linked to the one job — and if a matching
download is already running or already finished, approving reuses it
instead of fetching it again. A small in-memory lock also covers the case
of approving two duplicate requests within the same instant (e.g. two
browser tabs), so exactly one download ever starts either way.

**Launching emulators only makes sense on a machine with a display.** If
this runs on a headless server (e.g. a VM with no GUI), the "Launch"
button will spawn the emulator process, but it has nowhere to render —
useful mainly when this runs on the same machine you actually play on.

## Setup

```bash
cd webui
npm install
```

The app needs PostgreSQL. In k3s that's `k8s/postgres/` (deployed together with the webui);
for local development any Postgres 17 works: create the roles and database with
`k8s/postgres/init-roles.sql`, then `node db/migrate.js` once (it also imports old
`webui/data/*.json` files, see "Data storage" below).

Environment variables (the server refuses to start without `DATABASE_URL` and `DATA_ENCRYPTION_KEY`):

| Var | Purpose |
|---|---|
| `DATABASE_URL` | `postgres://gt_app:<pw>@<host>:5432/gametorrent`. The app's role: read/write data, no schema changes, audit log insert-only. |
| `DATA_ENCRYPTION_KEY` | 64 hex characters (32 bytes, `openssl rand -hex 32`). Encrypts the Jackett API keys in the database. Losing it means re-entering those keys; changing it makes stored ones unreadable. |
| `DATABASE_OWNER_URL` | Only for `node db/migrate.js` (in k8s: the `db-migrate` initContainer). `gt_owner`, the role that may change the schema. The app itself never gets it. |
| `SIGNUP_MODE` | `approval` (default), `open` or `off`. See "Accounts". |
| `WEBUI_USER` / `WEBUI_PASSWORD` | Only used once, to create the first admin on an empty database. |
| `SESSION_SECRET` | Signs session cookies and the login device cookie. Set it: with a random per-run value every restart signs everyone out. |
| `PORT` | Defaults to `3000`. |
| `RAWG_API_KEY` | Optional. Cover art works **without** it (see "Cover art" below); a [RAWG](https://rawg.io/login/?forward=developer) key just adds a fallback for titles the box-art library doesn't have. |
| `TRUST_PROXY` | Optional, default **off**. Only set it (e.g. `127.0.0.1`) if a reverse proxy is put in front of the UI. Leaving it off means clients can't fake their IP with `X-Forwarded-For` — which the login/download rate limits and the audit log rely on. |
| `COOKIE_SECURE` | Optional. Set to `1` once the UI is served over HTTPS (e.g. `tailscale serve`): marks the session cookie `Secure` and turns on HSTS. Leave unset on plain HTTP or logins stop working. |
| `ALLOW_PRIVATE_FETCH` | Optional. By default feeds and direct-download URLs may only point at **public** addresses (SSRF guard — see "Security" below). Set to `1` only if you deliberately host feeds/files on your LAN. Jackett providers are exempt either way. |

```bash
DATABASE_URL=postgres://gt_app:...@localhost:5432/gametorrent DATA_ENCRYPTION_KEY=$(openssl rand -hex 32) \
  WEBUI_USER=admin WEBUI_PASSWORD='choose-something-strong' SESSION_SECRET=$(openssl rand -hex 32) node server.js
```

### Data storage

Everything the app remembers lives in PostgreSQL (`webui/db/migrations/001_init.sql`):
`users`, `sessions`, `game_requests`, `download_jobs`, `game_stats`, `feeds`, `providers`
(API key encrypted), `audit_log`. On disk it still keeps the ROMs (`roms/`), in-progress
downloads (`downloads/`) and a cover-art index cache (`webui/data/libretro-index.json`).

Until 2026-11 the same data lived in JSON files under `webui/data/`. The first
`db/migrate.js` run on an empty database copies them all in, in one transaction (all or
nothing), and only ever reads them: they stay on the volume, untouched, as a rollback copy.

Open `http://<host>:3000`.

## Docker

`Dockerfile` builds from the **repo root** as context (it needs `poc/`,
`catalog/`, `config/`, and `webui/` all together):

```bash
docker build -f webui/Dockerfile -t gametorrent-webui .
docker run -d --name gametorrent-webui --restart unless-stopped \
  -p 3000:3000 \
  -e WEBUI_USER=admin -e WEBUI_PASSWORD='...' -e SESSION_SECRET='...' \
  -v gametorrent-webui-data:/app/webui/data \
  -v gametorrent-downloads:/app/downloads \
  -v gametorrent-roms:/app/roms \
  gametorrent-webui
```

The image also installs ClamAV (plus `ca-certificates`, without which `freshclam` can't download signatures and every scan is silently skipped — see `POC.md`); the signature DB is fetched at build and refreshed in the background at each container start. Under Komodo, `RAWG_API_KEY` is passed through `docker-compose.yml` but has no value until a Komodo Variable of that name is added and referenced in the stack's environment (`cicd/gitops/stacks.toml`).

The three volumes matter: without them, download history, feeds, and
everything under `roms/`/`downloads/` disappear on every container restart.

Base image is `node:20-bookworm-slim` (glibc), **not** Alpine — see the
comment at the top of `../Dockerfile`: webtorrent's `utp-native` dependency
segfaults on musl the moment real peer traffic flows.

## Reaching it from a phone or another device

The web UI listens on every interface (`0.0.0.0:3000`), but *reachability*
depends on the network the host sits on. In the current homelab the host is
`kan2server`, a VMware VM on **VMnet8 (NAT)** — a private network that only
the Windows PC running VMware can see. The VM's LAN IP may change across restarts
(check `credentials.md` for the current one), so using the **Tailscale address**
is strongly recommended for stable access:

| From | Address | Works? |
|---|---|---|
| Any device on the same **Tailscale** account | `http://<tailscale-ip>:3000` | yes, from any network (Wi-Fi or mobile data) |
| The Windows PC | `http://<LAN_IP>:3000` (e.g. `192.168.96.x`) | yes |
| A phone/laptop on the home Wi-Fi (`192.168.1.x`) | `http://<LAN_IP>:3000` | **no** — that subnet isn't routable from the Wi-Fi |

**Phone via Tailscale (recommended):** install the Tailscale app, sign in with
the same account as the VM (`kan2server` is already on the tailnet), turn it
on, then open `http://<tailscale-ip>:3000`. The same address works for Uptime
Kuma (`:3001`) and Komodo (`:9120`). No ports are opened to the internet.
`tailscale status` on the VM lists which devices are online. Cover art needs
the *phone* to have internet access too (see "Cover art").

Alternatives, with the catch of each: switch the VM's adapter to **Bridged**
in VMware so it gets a `192.168.1.x` address the phone can reach directly
(but every hardcoded reference to the LAN IP — docs, bookmarks
— then has to change); or forward a port on the Windows host
(`netsh interface portproxy` + a firewall rule; only works while the PC is on
and its Wi-Fi IP stays put). The app is HTTP-only, so don't expose it to the
internet directly — use Tailscale or put a TLS-terminating proxy in front.

## API (all under `/api`, session-cookie auth)

| Route | Notes |
|---|---|
| `POST /api/login` | `{ username, password }`. Failed-login limits use a device cookie (`gt.dev`, signed, set on every successful login): from a browser that has signed in as that user before, 5 failures / 15 min **per browser**; from any other browser, 5 failures / 15 min **per username** (plus a 50 / 15 min flood cap per IP). An attacker can use up the second bucket but can't lock out the real user's browser. Attempts count when they start, so parallel guesses can't slip past. Over the limit → `429`. Issues a fresh session id on success |
| `GET /api/games` | Default catalog + all feeds, combined; `feedSource` on each game says where it came from |
| `GET /api/feeds` / `POST /api/feeds` `{url}` / `DELETE /api/feeds/:id` | A feed must pass `catalog/catalog.schema.json` validation to be accepted (including a plain-name `destSubfolder`). `POST`/`DELETE` are **admin-only** |
| `GET /api/emulators` | Read-only view of `config/emulators.json` |
| `GET /api/providers` / `POST /api/providers` `{name, baseUrl, apiKey}` / `DELETE /api/providers/:id` | Manage Jackett connections — see "Searching for torrents" below. `PATCH /api/providers/:id` (admin-only, `{name?, baseUrl?, apiKey?}`) edits one in place: leave `apiKey` out to keep the saved key, so a wrong URL can be fixed without typing the key again (the Search tab has an **Edit** button per provider; audited as `provider.update`, never logging the key). Prefer `http://jackett:9117` (the in-cluster name) as the Base URL over the VM's LAN or Tailscale address: it does not change with DHCP and does not depend on Tailscale being up. `apiKey` is never echoed back (only `apiKeySet: true`). `POST`/`DELETE` are **admin-only**, and `baseUrl` is only shown to admins |
| `GET /api/search?q=&providerId=` | `providerId` omitted searches every configured provider at once ("All providers"); `&kinds=nds,video` (optional, see "Looking for" below) returns `{results: [{title, magnetUri, size, seeders, peers, indexer, providerId, providerName, match}], warnings, expandedFrom, kinds, hiddenByKinds}` — a provider that errors lands in `warnings`, not a failed request. Typo-tolerant: see "Forgiving search" below (`match` is 0-1, how close the title is to the query; `expandedFrom` lists the wider queries that were also run) |
| `GET /api/discover` | Powers the Search tab's default provider sections: a blank-query ("latest") browse per provider, magnet-only, cover-art-enriched, each result flagged `installed` against download history. A provider is omitted entirely if it has fewer than 5 usable results |
| `GET /api/downloads` / `GET /api/downloads/:id` | Job list / single job (status, progress, logs). A standard user sees only jobs started for their own requests, without log lines |
| `DELETE /api/downloads/:id` / `DELETE /api/downloads` | Delete one job's log entry (a running job is cancelled first) / clear every finished entry. Only log records — downloaded files in `roms/` are never touched. **Admin-only** |
| `GET /api/installed` | Library's "Installed" section: scans `roms/<platform>/<folder>/` on disk. Includes `downloadCount` tracking. |
| `DELETE /api/installed/:platform/:folder` | Admin-only route. Completely deletes the game and its folder from disk. |
| `POST /api/installed/:platform/:folder/platform` | Admin-only. `{ platform }` moves the game to `roms/<platform>/<folder>/` (used to name the console of an `unknown` install); carries the download counter and job records along, audited as `game.platform`. 400 if the target already has that folder. |
| `GET /api/installed/file?platform=&folder=&file=` | Downloads one installed file to the browser. Increments `downloadCount`. Has a rate limit (max 5 per minute per IP) to prevent bot scraping. Session required. |
| `POST /api/downloads` | `{ gameId }` or the direct-mode fields (`magnetUri`, `platform`, `destSubfolder`, `romFile`, ...) — same shape as `pipeline.buildJobFromParams`. `romFile` is optional: omit it to auto-detect by the platform's known ROM extension (see `docs/POC.md`). `excludeTypes` (array of `video`/`audio`/`images`/`docs`) skips those file types inside a torrent. `platform` and `archiveFormat` also accept `"auto"` (the default) — see "Auto-detection" in `docs/POC.md`. `destSubfolder` must be a single plain name (letters, digits, `.`, `_`, `-`) and `platform` a short lowercase id — anything else is rejected with 400 before a job or request is created. **An admin session starts the job immediately** (returns the job); **a standard-user session instead creates a pending request** (returns `{ requested: true, request }`) — see Requests below |
| `POST /api/downloads/:id/launch` | Only valid once a job's `status` is `"done"` and `canLaunch` is true. **Admin-only** |
| `GET /api/requests/mine` | The current user's own requests, newest first |
| `GET /api/requests` | Admin-only. Every user's requests, cover-art-enriched |
| `POST /api/requests/:id/approve` | Admin-only. Starts the download (same as `POST /api/downloads` would for an admin) and links the resulting job to the request. If another pending request is for the exact same magnet/gameId/direct URL, it's auto-approved too and linked to the *same* job — no duplicate download — and if a job for that magnet is already running or finished, that job is reused instead of starting a new one. Body (optional): `{ skipScan, noVt }`, the admin's choice; anything else is ignored. Returns `{ ok, job, alsoApproved }` |
| `POST /api/requests/:id/reject` | Admin-only. `{ reason }` optional |
| `DELETE /api/requests/:id` | The requester can cancel their own request while it's still `pending`; an admin can remove any request record at any time |
| `GET /api/users` | Admin-only. `[{ id, username, role, status, mustChangePassword, createdAt, lastLoginAt, pendingRequests }]`; never password hashes. Sign-ups waiting for approval come first |
| `POST /api/users` | Admin-only. `{ username, password, role, mustChangePassword }`: `role` `"admin"` or `"user"` (default); `mustChangePassword` defaults to `true` (the person replaces the password at first sign-in). Username 3-32 chars (letters/digits/`_`/`.`/`-`), unique ignoring case; password 12-128 chars |
| `PATCH /api/users/:id` | Admin-only. `{ role }` and/or `{ status: "active" \| "disabled" }`. Approving a sign-up = `status: "active"`. Ends that user's sessions. Refused for your own account and for the last active admin |
| `POST /api/users/:id/password` | Admin-only. `{ password }`: sets a temporary password (user must replace it) and ends their sessions |
| `POST /api/users/:id/logout` | Admin-only. Ends every session of that user |
| `DELETE /api/users/:id` | Admin-only. Refuses to delete the account you're logged in as, and the last active admin. Their requests stay (with the name they had), their sessions go |
| `POST /api/signup` | Public. `{ username, password }`. Creates a standard user, `pending` or `active` depending on `SIGNUP_MODE` (403 when `off`). 5/hour per IP, 30/hour total |
| `POST /api/account/password` | `{ currentPassword, newPassword }`. Changes your own password and signs out your other sessions. The only call (with `/api/session` and `/api/logout`) allowed while you have a temporary password |
| `POST /api/account/logout-everywhere` | Signs out all your other sessions |

## Searching for torrents (Search tab)

GameTorrent doesn't ship or scrape any torrent indexer itself — that would
both be legally messy and impossible to keep working as sites change. Instead,
the **Search** tab proxies queries to a [Jackett](https://github.com/Jackett/Jackett)
instance you run and configure yourself:

1. Run Jackett (Docker image `lscr.io/linuxserver/jackett` is the easiest
   route) and add whatever indexers you have the right to search, from its
   own web UI.
2. Copy Jackett's API key (shown on its dashboard) and add it under
   **Search → Providers** here, along with Jackett's base URL. Note: saved providers cannot
   be edited, only deleted and re-added. For the base URL: Jackett runs in the same k3s
   namespace as this app now, so use the stable **in-cluster address**, `http://jackett:9117`
   — it never changes, unlike a LAN IP (confirmed breaking across a VM reboot) or even the
   Tailscale address (which only helps a client *outside* the cluster, not pod-to-pod traffic).
3. Search by game name; results with a magnet link show a **Download**
   button that starts the download immediately — platform, archive format
   and ROM file are all auto-detected (see `docs/POC.md`), so there's no
   form to fill in. If the platform genuinely can't be told, the download
   is **not** thrown away: it is kept as an `unknown` game (generic tile,
   cover art looked up from the title when possible) and an admin names
   the console from its Library card (**Set console...**).

Results whose indexer only exposes a `.torrent` file link (no magnet URI)
show as unusable — `poc/pipeline.js` only knows how to fetch magnet links
today, not arbitrary `.torrent` files (same limitation as catalog entries
with `source.type: "torrentFile"`).

Provider configs (including the Jackett API key) are stored in
the `providers` table, with the API key encrypted (AES-256-GCM, `DATA_ENCRYPTION_KEY`) and never sent back to the browser.

### File-type filter and dead torrents

The Search tab has a **Skip these file types** row (Video, Audio, Images, Text/docs; remembered per browser). Ticked types are not downloaded from the torrent — by default video and audio are skipped, untick everything to keep every file. It applies to the one-click **Download** buttons. Results are sorted by seeders, and ones with 0 seeders are dimmed, tagged "likely dead" and offer **Download anyway** — a torrent nobody seeds never gets its file list, so it just times out.

### Phone layout

Below 720 px the header reads in order (logo and the Account / Sign out buttons on one row, the tabs across the
full width underneath; at 430 px and below the buttons and tabs are icon-only, their labels kept for screen
readers) and the wide tables (Admin users, Search results, Emulators) turn into stacked cards: each value is
printed after its column heading (`data-label`, set by `labelCells()` in `app.js`; CSS class `stack-on-phone`)
and the action buttons wrap full width, instead of scrolling sideways with the buttons off screen.

### Forgiving search (typos, plurals) and the Library filter

Indexers match whole words, so "legend of zeldas" or "pokemn" used to return nothing even though the
game is there. Two things fix that, both built on one small matcher, `webui/public/fuzzy.js` (a plain
script in the browser, a `require` on the server):

- **What it forgives:** capitals, accents, punctuation, `&` vs "and", a missing or extra plural/possessive
  `s` ("legend" finds "Legends", "zeldas" finds "Zelda's"), a prefix ("poke"), and one typo in a word of
  4+ letters (two in 8+): a missing, extra, wrong or swapped letter. All words must match (a query of 4+
  words may miss one) and a number must match exactly, so "Country 2" never finds "Country 3".
- **Search tab (server, `providers.smartSearch`):** the exact query runs first. If it returns fewer than 5 close
  matches, up to four wider queries run too (the query without plural `s`, each of the two longest words
  alone, and the start of the longest word). Their results are kept only if the title still fuzzy-matches
  what was typed, merged without duplicates, and scored. Close matches sort before loose ones, then by
  seeders, and a note says the search was widened.
- **Library tab (browser):** a search box above Installed and Catalog (typo-tolerant, matches the title,
  the console name and the folder), **console chips with counts** (they count what the typed text matches),
  and a sort (newest / best match, name, biggest, most downloaded). "Clear search and filters" resets all.

### "Looking for": search by kind of file or console

Above the search box, chips choose what KIND of thing to look for together with the game's name. Pick any
(they combine with OR); the choice is remembered per browser, and clicking a chip while results are showing
re-runs the search. The choices come from `GET /api/search/kinds` (`webui/lib/searchKinds.js`):

- **Consoles:** NES, SNES, Nintendo 64, GameCube, Game Boy, Game Boy Color, Game Boy Advance, Nintendo DS, 3DS,
  Switch, Genesis, Saturn, Dreamcast, PlayStation, PSP.
- **File types:** Video (mp4, mkv...), Audio (mp3, flac, soundtrack), Disc image (iso, bin/cue, chd), Archive
  (zip, 7z, rar), Patch / ROM hack (ips, bps, ups).

Each pick does two things: it adds one extra query to the indexer (`pokemon platinum nds`, `pokemon mp4`...),
because an indexer only returns titles containing the words it is given; and it narrows the merged results to
the ones that really are that kind (a console pick keeps results whose detected console is that console, a file
pick keeps results whose title or indexer category names the format). A note under the search says what is
shown and how many other results were hidden. This is separate from **Skip these file types when downloading**,
which only decides what is fetched from a torrent after you pick a result.

### Browse sections (default Search tab view)

Before you type anything into the search bar, the Search tab shows one
section per configured provider — a blank-query Jackett search (indexers
return their "latest" torrents for an empty query), title + best-effort
cover art (see "Cover art" below), no download triggered. A section only appears once it
has **5 or more** usable (magnet-having) results, to avoid showing a
near-empty provider. Each card is tagged **Installed** (its magnet matches
a completed download) or **Available** (**Download** starts the same one-click
download as an explicit search result); "See more" reveals
additional already-fetched cards with no extra request. Typing a query and
hitting **Search** replaces this with the flat results table (now search
every provider by default — pick one from the dropdown to narrow it), with
**Back to browsing** to return to the sections.

## Which console is it? (detection before you download)

Search and browse results show the console next to each torrent, so a search
like "pokemon rom hack" tells you at a glance whether a result is GBA, DS or
Switch — without downloading anything. `webui/lib/platformDetect.js` works it
out from, strongest signal first:

1. **The indexer's category** (Jackett's `CategoryDesc`, e.g. `Console/NDS`).
   The Torznab spec only standardises a couple of console ids (NDS 1010,
   PSP 1020), so the category *text* is what's read.
2. **A platform word in the title** — `GBA`, `NDS`, "Game Boy Advance",
   `NSP`/`XCI`... A bare "DS" or "Switch" counts, but only as a guess.
3. **A well-known game name** — this is what classifies ROM *hacks*, whose
   titles rarely name the console: "Pokemon Radical Red" → GBA,
   "Pokemon Renegade Platinum" → DS, "Pokemon Brilliant Diamond" → Switch
   (not the DS "Diamond"). Currently a Pokémon table plus a few famous hacks;
   add more in `GAME_HINTS`.

What you see: a solid badge (e.g. **Nintendo DS**) is detected; a dashed badge
with a **?** (e.g. **Game Boy Advance?**) is a best guess — hover for the
reason; **Unknown** means no clue, and is shown on purpose instead of a wrong
guess (e.g. "Emerald Black Edition" matches both a GBA and a DS game, so it
stays Unknown). If a title names several consoles it shows them all with a `?`.

Extra flags: **Hack** (a fan-made ROM hack — it needs the original game
underneath) and **Patch?** (the title says IPS/BPS/UPS/patch, so it's probably a
patch file, not a playable ROM; "pre-patched" titles are not flagged).
Consoles GameTorrent can recognise but can't sort or launch (Wii, Wii U, Xbox,
Xbox 360, PS2/PS3/PS4, PS Vita) show "**Wii · unsupported**" and have no
Download button, rather than fetching gigabytes it can't place.

When a search returns more than one console, **filter chips** appear above the
table (`All`, `Game Boy Advance (3)`, `Nintendo DS (3)`, `Unknown (2)`...) to
narrow it to one console.

Limits, honestly: this only reads the *title and category*, so it is a
guess — hack titles are the weakest case, and indexer categories vary in
quality. It is informational only: **the download still decides the real
platform from the downloaded files** (file extensions, then title/file-name
words), which is far more reliable. Peeking inside the torrent's file list
before downloading would be more accurate still, but needs a peer to hand over
the torrent metadata first, so it isn't done here.

## Library, Downloads and Installed

- **Library → Installed** lists every game folder under `roms/<platform>/`, with a cover and a **Download ROM** button. It also tracks the total number of downloads per game. If you are logged in as an `admin`, a red **Delete** button allows you to permanently remove the game. To prevent scraping, downloading a ROM is rate-limited to 5 times per minute per IP. The bundled catalog is empty, so the rest of the tab only shows games from feeds you add.
- **Downloads** shows a job's status and a collapsible log. **Cancel** stops a running job; **Delete** / **Clear finished** remove log entries only. A torrent with no peers gives up after 3 minutes.
- **My Requests** (every user) lists the games you've asked for and their status — pending, approved (check Downloads for progress), or rejected (with the admin's reason, if given). A pending request can be cancelled from here.
- **Admin** (admin accounts only) has two parts: **Pending requests**, where Approve starts the download and links it to the request, and Reject takes an optional short reason; and **Users**, a table of every account with its pending-request count and a Delete button, plus a form to add a new account (username, password, role). You can't delete the account you're logged in as, or the last remaining admin.

## Security

What protects what (the reasoning behind each is in the 2026-10 audit notes):

| Layer | Protection |
|---|---|
| **Accounts** | scrypt + per-user salt, constant-time compare; hashing runs off the main thread (a login burst can't freeze the app); an unknown username costs the same work as a real one, so response time doesn't reveal which accounts exist; passwords 12-128 chars; failed-login limits per browser (device cookie) or per username, so an attacker can't lock out the real user (see `POST /api/login`) |
| **Sessions** | stored in PostgreSQL, 8h idle / 7 days absolute. The user is re-read on every request and their *current* role and status used, so disabling, demoting or deleting a user ends their access immediately (it used to last until the 24h cookie expired) |
| **Database** | separate roles: the app (`gt_app`) can read/write data but not change the schema, and can only insert into the audit log; schema changes run as `gt_owner` in an initContainer the app never shares credentials with. Only the webui pod may connect (NetworkPolicy), Postgres has no outbound network at all, and it runs non-root with a read-only filesystem |
| **Roles** | every route that changes shared setup (feeds, providers, users, other people's jobs, deleting games, launching) is `requireAdmin` on the server; standard users can only file requests, can't choose scan options, and only see their own jobs |
| **Cross-site requests** | every POST/DELETE with an `Origin` that isn't this site, or `Sec-Fetch-Site: cross-site`, is refused (`403`), on top of the `SameSite=Lax` cookie |
| **File paths** | download folder names and platforms must be single plain names; direct-URL filenames are reduced to a safe basename; every write is checked to stay inside `downloads/` or `roms/` (`assertInside`); zips containing symlinks are refused. Downloading an installed file checks platform, folder and file, before and after resolving symlinks: before 2026-11-05 only the file part was checked, so `platform=..&folder=webui` let any logged-in user download `data/users.json` |
| **Outbound requests (SSRF)** | feeds and direct downloads may only reach public addresses — checked on the URL, on every redirect, and on the DNS result at connect time. Opt out with `ALLOW_PRIVATE_FETCH=1` |
| **Browser** | strict Content-Security-Policy (`script-src 'self'`, no inline script anywhere), `frame-ancestors 'none'` (no clickjacking), `nosniff`, `HttpOnly` + `SameSite=Lax` session cookie |
| **Container** | runs as uid 1000 (`node`), read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, memory/pid limits, healthcheck; npm isn't even present in the runtime image |
| **Audit trail** | the `audit_log` table: one row per login, failed login, sign-up, account change and admin action (who, when, from which IP, what). The app's database role can only insert and read it, never change or delete it, so a compromised app can't erase its tracks. Each line is also printed to stdout with `"type":"audit"`, so it's in Loki: Grafana Explore → `{namespace="gametorrent"} \|= "type\":\"audit"`. Note the IPs: behind VMware NAT every LAN browser shows as `192.0.2.1`, and Tailscale traffic as one in-cluster address |
| **Tests** | `cicd/tests/api-selftest.js` starts the real server on throwaway folders and attacks each of the above over HTTP; runs in CI (`test:security`) |

The data volumes are owned by uid 1000. If you ever recreate them by hand, fix
ownership or the app can't write: `docker run --rm -v gametorrent-webui-data:/v busybox chown -R 1000:1000 /v`
(same for `gametorrent-downloads` and `gametorrent-roms`).

## Cover art

Game cards get real box art with **no API key**, via `webui/lib/coverArt.js`:

1. **libretro-thumbnails** (`thumbnails.libretro.com`, the box-art library
   RetroArch uses). For each platform the server downloads that system's
   directory of box-art file names once (a couple of MB), caches it in
   `webui/data/libretro-index.json` for 7 days, and fuzzy-matches the title
   against it. Installed cards know their platform; browse/search cards
   guess it from the title (`GBA`, `NDS`, `Genesis`, ...). Matching drops
   region/format noise, joins split words ("Fire Red" = "FireRed"), needs
   most of the title's words to match, prefers the USA release (or Europe/
   Japan if the title says so) and avoids demo/kiosk builds. A title with no
   confident match gets nothing rather than a wrong cover.
2. **RAWG**, only if `RAWG_API_KEY` is set — a looser, mainstream-skewed
   fallback for titles step 1 missed.
3. Otherwise the generated platform-coloured tile with the title's initials.

Lookups never block a page: each waits at most 5 seconds, keeps running in
the background and is remembered, and the server pre-loads the indexes for
platforms already in your library at startup. The images themselves are
loaded by your **browser** straight from the libretro CDN, so the device
viewing the UI needs internet access for covers (everything else — fonts,
icons — is self-hosted). Supported platforms: NES, SNES, GB, GBC, GBA, NDS,
3DS, N64, GameCube, Genesis, Saturn, Dreamcast, PSX, PSP.

## Look and feel (8-bit theme)

The UI is a deliberately retro, cartridge-and-CRT look. Everything lives in
`webui/public/` with no build step and no external requests:

- **Fonts** are self-hosted in `public/fonts/` (Press Start 2P for headings,
  buttons and badges; VT323 for body text — both SIL Open Font License), so
  the dashboard looks the same on a LAN with no internet.
- **Pixel art** is drawn in `public/sprites.js` as ASCII grids that render to
  crisp inline SVG. `X` paints in `currentColor` (tab icons follow the text
  colour); other letters map to palette colours (the multi-colour logo
  cartridge). `Sprites.html('name')` builds one in JS; `<span data-sprite="name">`
  fills itself in HTML. `public/favicon.svg` is generated from the same logo grid.
- **Frames**: panels, inputs and buttons have no real border — four hard
  box-shadows offset 4px draw a notched pixel frame, recoloured with the
  `--bc` custom property (magenta on hover, green for installed, cyan for a
  running download, red for an error). Because the frame sits outside the
  box, keep >= 8px gaps between siblings.
- **Game cards** are cartridges: a ridged grip band, then the cover in a
  label window. With no cover art you get a dithered platform-coloured tile
  with the title's initials, or the cartridge sprite.
- **Progress** is a segmented HP bar (cyan and marching while active, green
  when done, red on error). Logs are a green-phosphor terminal. Modals are
  RPG-style dialogue boxes. A slow two-layer starfield and CRT scanlines sit
  behind everything.
- `prefers-reduced-motion` turns every animation off; below ~430px the tabs
  collapse to icons only.

Colours are all CSS variables at the top of `style.css` (`--magenta`,
`--yellow`, `--cyan`, `--green`, ...) — retheme there.

## Known limitations

- Download history persists to the `download_jobs` table; in-progress
  jobs do not survive a server restart (they just vanish — there's no resume).
- Search only supports Jackett today (not Prowlarr or a raw Torznab URL),
  and only surfaces results that already have a magnet URI.
- Cover art matching is fuzzy: a messy torrent title with an unusual name,
  or a game the box-art library doesn't have (most homebrew), just keeps
  its generated tile. See "Cover art" below.
- Same scan/extraction limits as the CLI — see `POC.md`.
