# GameTorrent Web UI

A browser dashboard over the same pipeline the CLI (`../poc/poc.js`) uses —
see `../poc/pipeline.js`, which both share. Browse the catalog (default +
your own feeds), start downloads, watch live progress, and launch a
configured emulator once a download finishes.

## Why this exists / what it isn't

This was built to be **exposed on a LAN**, not just localhost — see
`ARCHITECTURE.md` for the reasoning. Because anyone who can reach it
could otherwise trigger downloads, every route except the login page
requires a session. It supports a multi-user model via `webui/data/users.json`:
- **Admin**: Can start downloads, and can **delete** games from the server.
- **Standard User**: Can only download games and view the library.

There is no user-management UI; just edit `users.json` to add new standard users.
The first run automatically creates an admin using your `WEBUI_USER` and `WEBUI_PASSWORD` env vars.

**Launching emulators only makes sense on a machine with a display.** If
this runs on a headless server (e.g. a VM with no GUI), the "Launch"
button will spawn the emulator process, but it has nowhere to render —
useful mainly when this runs on the same machine you actually play on.

## Setup

```bash
cd webui
npm install
```

Required environment variables (the server refuses to start without both):

| Var | Purpose |
|---|---|
| `WEBUI_USER` | Login username |
| `WEBUI_PASSWORD` | Login password |
| `SESSION_SECRET` | Signs session cookies. Optional — a random one is generated per run if unset, which just means everyone's logged out on restart. Set it explicitly if you want sessions to survive a restart. |
| `PORT` | Defaults to `3000`. |
| `RAWG_API_KEY` | Optional. Cover art works **without** it (see "Cover art" below); a [RAWG](https://rawg.io/login/?forward=developer) key just adds a fallback for titles the box-art library doesn't have. |

```bash
WEBUI_USER=admin WEBUI_PASSWORD='choose-something-strong' node server.js
```

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
`kan2server`, a VMware VM at `192.168.96.145` on **VMnet8 (NAT)** — a private
network that only the Windows PC running VMware can see. So:

| From | Address | Works? |
|---|---|---|
| The Windows PC | `http://192.168.96.145:3000` | yes |
| A phone/laptop on the home Wi-Fi (`192.168.1.x`) | `http://192.168.96.145:3000` | **no** — that subnet isn't routable from the Wi-Fi |
| Any device on the same **Tailscale** account | `http://100.70.108.20:3000` | yes, from any network (Wi-Fi or mobile data) |

**Phone via Tailscale (recommended):** install the Tailscale app, sign in with
the same account as the VM (`kan2server` is already on the tailnet), turn it
on, then open `http://100.70.108.20:3000`. The same address works for Uptime
Kuma (`:3001`) and Komodo (`:9120`). No ports are opened to the internet.
`tailscale status` on the VM lists which devices are online. Cover art needs
the *phone* to have internet access too (see "Cover art").

Alternatives, with the catch of each: switch the VM's adapter to **Bridged**
in VMware so it gets a `192.168.1.x` address the phone can reach directly
(but every reference to `192.168.96.145` — docs, Komodo, the webhook, bookmarks
— then has to change); or forward a port on the Windows host
(`netsh interface portproxy` + a firewall rule; only works while the PC is on
and its Wi-Fi IP stays put). The app is HTTP-only, so don't expose it to the
internet directly — use Tailscale or put a TLS-terminating proxy in front.

## API (all under `/api`, session-cookie auth)

| Route | Notes |
|---|---|
| `POST /api/login` | `{ username, password }` |
| `GET /api/games` | Default catalog + all feeds, combined; `feedSource` on each game says where it came from |
| `GET /api/feeds` / `POST /api/feeds` `{url}` / `DELETE /api/feeds/:id` | A feed must pass `catalog/catalog.schema.json` validation to be accepted |
| `GET /api/emulators` | Read-only view of `config/emulators.json` |
| `GET /api/providers` / `POST /api/providers` `{name, baseUrl, apiKey}` / `DELETE /api/providers/:id` | Manage Jackett connections — see "Searching for torrents" below. `apiKey` is never echoed back (only `apiKeySet: true`) |
| `GET /api/search?q=&providerId=` | `providerId` omitted searches every configured provider at once ("All providers"); returns `{results: [{title, magnetUri, size, seeders, peers, indexer, providerId, providerName}], warnings}` — a provider that errors lands in `warnings`, not a failed request |
| `GET /api/discover` | Powers the Search tab's default provider sections: a blank-query ("latest") browse per provider, magnet-only, cover-art-enriched, each result flagged `installed` against download history. A provider is omitted entirely if it has fewer than 5 usable results |
| `GET /api/downloads` / `GET /api/downloads/:id` | Job list / single job (status, progress, logs) |
| `DELETE /api/downloads/:id` / `DELETE /api/downloads` | Delete one job's log entry (a running job is cancelled first) / clear every finished entry. Only log records — downloaded files in `roms/` are never touched |
| `GET /api/installed` | Library's "Installed" section: scans `roms/<platform>/<folder>/` on disk. Includes `downloadCount` tracking. |
| `DELETE /api/installed/:platform/:folder` | Admin-only route. Completely deletes the game and its folder from disk. |
| `GET /api/installed/file?platform=&folder=&file=` | Downloads one installed file to the browser. Increments `downloadCount`. Has a rate limit (max 5 per minute per IP) to prevent bot scraping. Session required. |
| `POST /api/downloads` | `{ gameId }` or the direct-mode fields (`magnetUri`, `platform`, `destSubfolder`, `romFile`, ...) — same shape as `pipeline.buildJobFromParams`. `romFile` is optional: omit it to auto-detect by the platform's known ROM extension (see `docs/POC.md`). `excludeTypes` (array of `video`/`audio`/`images`/`docs`) skips those file types inside a torrent. `platform` and `archiveFormat` also accept `"auto"` (the default) — see "Auto-detection" in `docs/POC.md` |
| `POST /api/downloads/:id/launch` | Only valid once a job's `status` is `"done"` and `canLaunch` is true |

## Searching for torrents (Search tab)

GameTorrent doesn't ship or scrape any torrent indexer itself — that would
both be legally messy and impossible to keep working as sites change. Instead,
the **Search** tab proxies queries to a [Jackett](https://github.com/Jackett/Jackett)
instance you run and configure yourself:

1. Run Jackett (Docker image `lscr.io/linuxserver/jackett` is the easiest
   route) and add whatever indexers you have the right to search, from its
   own web UI.
2. Copy Jackett's API key (shown on its dashboard) and add it under
   **Search → Providers** here, along with Jackett's base URL
   (e.g. `http://192.168.1.10:9117`).
3. Search by game name; results with a magnet link show a **Download**
   button that starts the download immediately — platform, archive format
   and ROM file are all auto-detected (see `docs/POC.md`), so there's no
   form to fill in. If the platform genuinely can't be told, the job fails
   with a message pointing at **Add custom download**, where you can pick
   it by hand.

Results whose indexer only exposes a `.torrent` file link (no magnet URI)
show as unusable — `poc/pipeline.js` only knows how to fetch magnet links
today, not arbitrary `.torrent` files (same limitation as catalog entries
with `source.type: "torrentFile"`).

Provider configs (including the Jackett API key) are stored in
`webui/data/providers.json`, gitignored like `feeds.json`/`downloads.json`.

### File-type filter and dead torrents

The Search tab has a **Skip these file types** row (Video, Audio, Images, Text/docs; remembered per browser). Ticked types are not downloaded from the torrent — by default video and audio are skipped, untick everything to keep every file. It applies to the one-click **Download** buttons. Results are sorted by seeders, and ones with 0 seeders are dimmed, tagged "likely dead" and offer **Download anyway** — a torrent nobody seeds never gets its file list, so it just times out.

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

- Download history persists to `webui/data/downloads.json`; in-progress
  jobs do not survive a server restart (they just vanish — there's no resume).
- Search only supports Jackett today (not Prowlarr or a raw Torznab URL),
  and only surfaces results that already have a magnet URI.
- Cover art matching is fuzzy: a messy torrent title with an unusual name,
  or a game the box-art library doesn't have (most homebrew), just keeps
  its generated tile. See "Cover art" below.
- Same scan/extraction limits as the CLI — see `POC.md`.
