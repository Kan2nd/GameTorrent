# GameTorrent — Current Project Structure

A single point of reference tying together the app, the CI/CD pipeline, and
what's actually deployed — since those live in different folders/docs and
this project has grown a lot of pieces. For credentials to anything
mentioned here, see `credentials.md` (gitignored, not in this doc).

## 1. The big picture

```
                     ┌─────────────────────────────┐
                     │   catalog/catalog.json       │
                     │   (+ user feeds)              │
                     └──────────────┬────────────────┘
                                    │ read by
                     ┌──────────────▼────────────────┐
                     │   poc/pipeline.js               │  <- one shared engine
                     │   download → scan → extract →   │
                     │   verify → (launch)              │
                     └───────┬──────────────┬──────────┘
                             │              │
                  ┌──────────▼───┐   ┌──────▼───────────┐
                  │  poc/poc.js    │   │  webui/server.js  │
                  │  (CLI wrapper) │   │  (Express + login) │
                  └────────────────┘   └──────┬─────────────┘
                                               │ serves
                                     ┌─────────▼─────────┐
                                     │ webui/public/*.html │
                                     │ (browser dashboard)  │
                                     └───────────────────────┘

   cicd/.gitlab-ci.yml validates + scans + builds all of the above,
   then (once configured) deploys the built image to a plain Docker host.
```

## 2. Repo layout

```
Project GameTorrent/
├── poc/                      # the actual download/scan/extract/verify engine
│   ├── pipeline.js           # shared logic — no CLI or HTTP code in here
│   └── poc.js                # CLI: parses argv, wires console output, calls pipeline.js
├── webui/                    # browser dashboard over the same pipeline.js
│   ├── server.js             # Express app: session auth + REST API
│   ├── lib/
│   │   ├── auth.js           # login check & multi-user roles (reads data/users.json, hashes passwords)
│   │   ├── downloadManager.js  # in-memory job tracking + JSON history
│   │   ├── feeds.js          # custom feed URLs, schema-validated on add
│   │   ├── providers.js      # Jackett provider search (see docs/WEBUI.md)
│   │   ├── coverArt.js       # keyless box-art lookup (libretro) + optional RAWG fallback
│   │   ├── platformDetect.js # which console a search result is for, before downloading (docs/WEBUI.md)
│   │   ├── stats.js          # download counter tracking
│   │   └── rateLimit.js      # anti-bot rate limiting (5 downloads/min per IP)
│   ├── public/                # login.html, index.html, app.js, style.css (8-bit theme),
│   │                          #   sprites.js (pixel-art icons/logo), favicon.svg, fonts/ (self-hosted)
│   ├── data/                  # users.json, stats.json, feeds.json, downloads.json, providers.json (gitignored, runtime state)
│   └── docker-compose.yml    # deploy target — see docs/GITOPS.md
├── catalog/
│   ├── catalog.schema.json   # JSON Schema every catalog/feed entry must satisfy
│   └── catalog.json          # default bundled entries (2 fully verified, 2 placeholder)
├── config/
│   └── emulators.json        # per-platform emulator CLI templates (RetroArch, etc.)
├── Dockerfile                 # node:20-bookworm-slim image for poc/ — see §5 for why not Alpine
├── .dockerignore
├── cicd/                      # everything CI/CD-related lives here, not at repo root
│   ├── .gitlab-ci.yml         # the pipeline itself — see §4
│   ├── package.json / scripts/validate-catalog.js   # catalog schema validation tooling
│   ├── ansible/                # installs Docker Engine + Compose on a target host
│   ├── deploy/docker-compose.yml   # the poc CLI's Docker Compose deploy target
│   └── gitops/                 # Komodo bootstrap + gametorrent-webui Stack-as-code — see docs/GITOPS.md
├── docs/
│   ├── ARCHITECTURE.md        # original Phase 1 stack rationale
│   ├── CI_CD.md               # branch strategy + pipeline stage detail
│   ├── GITOPS.md              # Komodo-based GitOps deploy for webui
│   ├── CLOUDFLARE_TUNNEL.md   # no-domain Cloudflare quick-tunnel setup guide
│   ├── GIT_WORKFLOW.md        # dev/main rules + how to never hit MR conflicts (AI + humans)
│   ├── PROJECT_STRUCTURE.md   # this file
│   ├── POC.md                 # Phase 1 CLI setup (was poc/README.md)
│   ├── WEBUI.md                # web dashboard setup + API + Jackett search (was webui/README.md)
│   └── devsecops-notes/        # historical reference from the old separate devsecops-pipeline project
├── downloads/, roms/           # runtime output (gitignored) — raw downloads, then extracted/placed ROMs
├── credentials.md              # gitignored — every password/token created this session
└── README.md
```

## 3. The app itself

**`poc/pipeline.js`** is the one implementation of the actual work — nothing
else re-implements download/scan/extract/verify/launch logic:

1. **Fetch** — `source.type` is `magnet` (BitTorrent, via `webtorrent`,
   selective per-file download) or `directUrl` (plain HTTPS GET, follows
   redirects — most small homebrew, including Switch homebrew, ships this
   way rather than as a torrent). `torrentFile` is schema-valid but not
   implemented yet.
2. **Scan** — ClamAV (`clamscan`; installed in the webui Docker image, DB fetched at build and refreshed at each container start; soft-skips with a warning if missing or if it fails to run) on
   the raw download, then a VirusTotal hash lookup (hash only, never the
   file; needs `VT_API_KEY`, currently unset on both deployed containers).
3. **Extract** — `none` (copy as-is) or `zip`. With `zip`, `extractIfNeeded()`
   picks the single downloaded file ending in `.zip` — zero or multiple
   `.zip` candidates errors out asking to disambiguate with a `--select`
   pattern, rather than blindly grabbing the first downloaded file (which
   used to silently extract the wrong thing, or the right thing named
   confusingly, whenever a torrent had more than one file selected).
   Picking `none` when the payload actually is a zip leaves the raw `.zip`
   sitting in `roms/` unextracted — the ROM auto-detect step below then
   correctly reports no matching file, since there isn't one yet.
4. **Verify** — sha256/sha1/md5 against `catalog.json`'s pinned hash, if present.
5. **Launch** — optional. `launch.emulatorId` is not required by the
   schema; a game with none just stops after verification (this is how
   Switch entries and anything from the web UI's manual-download form work
   — no emulator config needed).

**Finding the ROM file after extraction** (`resolveRomPath()` /
`autoDetectRomFile()`): `romFile` is optional for manual/direct-mode jobs
(catalog entries still specify it explicitly) — omit it and the pipeline
scans the extracted output by the platform's known extension
(`ROM_EXTENSIONS` — `dos`/`pc` excluded on purpose, `.exe`/`.com` aren't
unique enough to guess safely). Zero or multiple matches both error out
asking for `romFile` explicitly rather than guessing wrong.

**Platforms** (`config/emulators.json` + `catalog.schema.json`'s enum):
nes, snes, gb, gbc, gba, nds, 3ds, n64, gamecube, genesis, saturn,
dreamcast, psx, psp, dos, pc, switch. 3DS/GameCube/PSP use standalone
emulators (Azahar, Dolphin, PPSSPP) rather than RetroArch cores — same
`{romPath}` templating either way.

Every step reports through an `EventEmitter` (`'log'`, `'progress'`
events) rather than printing directly, so `poc.js` (console output) and
`webui/` (per-job state polled over HTTP) both consume the exact same
engine without duplicating it.

**Finding a magnet link to feed in** (`webui/lib/providers.js`, web UI only):
rather than the app shipping or scraping any torrent indexer itself, the
Search tab proxies queries to [Jackett](https://github.com/Jackett/Jackett)
instance(s) the user runs and points GameTorrent at (their own base URL +
API key per provider, stored in `webui/data/providers.json`). Two modes on
the same `rawSearch()` primitive: an explicit query (`GET /api/search`,
defaults to searching every configured provider at once, tagging each hit
with which one it came from) and a blank-query "browse" mode
(`GET /api/discover`) that shows one section per provider on the Search
tab by default, capped to results with a real magnet and only rendered at
all once a provider clears 5 of them — a preview, not a download. Browse
cards get a best-effort cover image from `lib/coverArt.js` (libretro box art,
no key; RAWG as an optional fallback — capped per page load) and are flagged `installed`
against `downloadManager.getInstalledMagnets()`. Either way, a result's
**Download** button starts a one-click job through the same
`buildJobFromParams()` (platform, archive format and ROM file all
auto-detected — see the pipeline section above; a Search-tab filter row
skips video/audio/image/doc files inside the torrent; results sort by
seeders and 0-seeder ones are flagged "likely dead") — no new fetch path,
no indexer-specific code in this repo. The Downloads tab can cancel or
delete a job's log entry (files in `roms/` are never touched), and the
Library's **Installed** section is built from `roms/` on disk.

**Catalog status** (`catalog/catalog.json`, **empty since 2026-09-19**): the two
bundled entries (`tobu-tobu-girl`, `super-haxagon` — real, hash-pinned free
homebrew) were removed at the maintainer's request; they're in git history if
wanted back. Games now come from the Search tab (Jackett) and user feeds. The
Library tab's **Installed** section is built from what's on disk under
`roms/`, with a **Download ROM** button per game (sends the file to your
browser) and box art from `lib/coverArt.js` (libretro thumbnails, no key needed; falls
back to RAWG if `RAWG_API_KEY` is set, else a generated platform-coloured tile).

`bobl` and `anguna` were **removed 2026-09-17** (previously shipped with
placeholder `example.org` sources, so their Download button just failed)
— checked and neither is actually torrent-distributed by its author, so
there was no real magnet to fill the placeholder in with. Full research
is preserved in git history and `catalog/catalog.json`'s `_note` in case
someone finds a real source later: `bobl`'s real distribution is itch.io
(download requires itch's own flow, not a static URL); `anguna`'s listed
homepage (`tolberts.net`) is dead — it now serves an unrelated site's TLS
cert, likely an expired/resold domain.

**Cover art lookup** (`cicd/scripts/lookup-art.js`): a research helper for
whoever curates the catalog — `RAWG_API_KEY=... npm run lookup:art --
"title"` prints candidate cover images from [RAWG](https://rawg.io) to
manually verify and copy in. Chosen as the "mainstream" option; RAWG skews
commercial/Steam-era so it's unlikely to cover niche homebrew like `bobl`/
`anguna` — TheGamesDB or LaunchBox Games DB (retro/emulation-focused) are
better bets for those, not yet integrated.

## 4. CI/CD (`cicd/`)

GitLab CI config lives at `cicd/.gitlab-ci.yml`, not the repo root — the
GitLab project setting **CI/CD → General pipelines → CI/CD configuration
file** needs to point there once/if this repo is pushed to GitLab (it
currently has no remote — see §6).

Runs only on: an MR, or a push to `dev`/`main` (never on raw `feature/*`
pushes).

| Stage | Job | State |
|---|---|---|
| validate | `validate:catalog`, `validate:poc-syntax` | active |
| sast | `semgrep-sast` | active, report-only |
| dependency-scan | `.trivy-dependency-scan` | disabled (leading `.`) |
| build | `build:poc`, `.build-image` | first active, second disabled |
| image-scan | `.trivy-image-scan` | disabled |
| deploy | `deploy:tauri-placeholder`, `.deploy:docker-compose` | first is a no-op until Phase 2 desktop app exists; second disabled, needs `SSH_PRIVATE_KEY`/`DEPLOY_HOST`/`DEPLOY_USER`/`REGISTRY` CI variables and a registry to push to (neither exists yet — `.build-image` only saves a local tarball today) |

This is where the now-merged former `devsecops-pipeline` project's security
gates and Docker deploy tooling (`cicd/ansible/`, `cicd/deploy/`) ended up —
see `docs/CI_CD.md` for the full history of that merge and
`docs/devsecops-notes/` for the original project's tutorial notes (dropped
Kubernetes and DVWA along the way; kept as reference only).

## 5. What's actually deployed right now

Everything below runs on **`kan2server`** (`<vm-ip>`), a single
Ubuntu Server VM on the homelab LAN, reached via key-based SSH
(`<ssh-user>@<vm-ip>`).

**`gametorrent-webui` is now deployed via Komodo** (see `docs/GITOPS.md`),
not by hand — it builds and runs `webui/docker-compose.yml` cloned fresh
from `kannguyen3105/gametorrent`'s `main` branch on GitLab. Redeploying
after a merge to `main` is a click in Komodo's UI (or the `DeployStack`
API — see below), not an SSH session.

| Container | Image | Port | Purpose |
|---|---|---|---|
| `gametorrent-webui` | `gametorrent-webui:local`, built by Komodo from `webui/Dockerfile` | 3000 | The web dashboard — login required, see `credentials.md` |
| `uptime-kuma` | `louislam/uptime-kuma:1` | 3001 | Monitors `gametorrent-webui`'s `/login.html` every 60s |
| `komodo-core-1` / `komodo-periphery-1` | `ghcr.io/moghtech/komodo-{core,periphery}:2` | 9120 | The GitOps controller itself — see below |
| `komodo-postgres-1` / `komodo-ferretdb-1` | `ghcr.io/ferretdb/{postgres-documentdb,ferretdb}` | — | Komodo's DB (FerretDB, not plain MongoDB — see the kernel-incompatibility note below) |

All six run `--restart unless-stopped`. Named Docker volumes
(`gametorrent-webui-data`, `gametorrent-downloads`, `gametorrent-roms`,
`uptime-kuma-data`, plus Komodo's own `postgres-data`/`ferretdb-state`/`keys`)
persist state across container recreates.

`gametorrent-webui`/`poc` images use `node:20-bookworm-slim`, **not**
Alpine — `node:20-alpine` (musl libc) segfaults the moment real BitTorrent
µTP traffic flows, because `webtorrent`'s `utp-native` dependency ships
native addons prebuilt for glibc. This was found by actually running a
real download inside the built container, not by any static check —
worth remembering if either Dockerfile ever gets "optimized" back to
Alpine for size.

**Network / who can reach it:** `<vm-subnet>` is VMware's VMnet8 (NAT)
network, visible only to the Windows host — not to phones or other devices
on the home Wi-Fi (`192.168.1.x`). Off-host access goes through Tailscale
(`kan2server` = `<tailscale-ip>`); details and the alternatives are in
`docs/WEBUI.md` → "Reaching it from a phone or another device".

A second VM, `<ssh-user-2>@<vm2-ip>`, was originally meant to be a
Kubernetes control-plane node before the project dropped k8s in favor of
plain Docker. It's currently powered off and unused.

### Komodo (GitOps controller) — live

Deployed per `docs/GITOPS.md`, using **FerretDB (Postgres-backed) instead
of MongoDB** — plain `mongo` refuses to start on this VM's kernel (7.0.0):
`"Linux kernel versions 6.19 and newer has a known incompatibility with
this version of MongoDB"` (SERVER-121912). `cicd/gitops/compose.yaml` was
updated to match what's actually running.

The `gametorrent-webui` Stack is configured with `run_build: true` and
`auto_pull: false` — Komodo's default assumes a registry image (`docker
compose pull`), but this project has no registry, only a local `build:`
context, so the default pull step fails with "repository does not exist."
Both flags are necessary; `run_build` alone still leaves the pull step
enabled and failing.

**A real Komodo bug hit during setup**, worth knowing if it recurs: a
`Variable` with an **empty string value** marked `is_secret: true` breaks
deploy log rendering — Komodo's log redaction replaces every occurrence of
a secret's value with a placeholder, and replacing an empty string matches
*between every character*, turning the log to noise. Fix: don't mark an
empty-valued variable (like `VT_API_KEY` when unset) as secret.

Auth for scripting against Komodo directly: `POST /auth/login/LoginLocalUser`
returns a JWT (also cached in the browser's `localStorage` under
`mogh-auth-tokens-v1`); pass it as `Authorization: Bearer <jwt>` on
`POST /read|write|execute/<RequestType>` calls (body = the params object,
no `{type, params}` wrapper — that's the Rust client's shape, not the wire
format).

**A GitLab webhook is live and confirmed working** (via a Cloudflare
tunnel — `gitlab.com` can't reach a private LAN address directly, see
`docs/GITOPS.md`). A second real bug hit getting there: a Stack's webhook
runs `DeployStackIfChanged` by default, which compares a *cached*
`latest_hash` and can silently no-op on stale data if a genuine new
commit lands between Komodo's poll cycles — no error, no deploy, nothing
in the logs at any level. Fix: `webhook_force_deploy = true` on the stack
(in `cicd/gitops/stacks.toml`), which makes every webhook call an
unconditional plain deploy instead. Confirmed by pushing a real commit
and watching `deployed_hash` update within ~10 seconds — note that
`ListUpdates`/`GetUpdate` didn't show this webhook-triggered deploy at
all, so the stack's own state (`deployed_hash`, container creation time)
is the reliable way to check whether one ran, not that endpoint.

### Recurring issue: Docker networking wedges after any network interruption — fixed

`kan2server` runs on a VMware `e1000` (legacy emulated) NIC, which flaps
its link (`NIC Link is Down` / `Up` in `dmesg`) somewhat often — and does
so *every time the VM is paused and resumed*, since a hypervisor-level
pause never triggers a real guest-OS suspend/resume (no ACPI event), so
the only observable signal to the guest is the NIC losing and regaining
carrier. Whenever that happens, Docker's `docker-proxy` port-forwarding
gets left stale: containers still show `Up`, but nothing answers on their
published ports — not even from `localhost` on the VM itself — until the
Docker daemon is restarted (`sudo systemctl restart docker`). This isn't a
GameTorrent-specific bug — Uptime Kuma break the exact same way, confirming
it's host/Docker-networking-level, not application code.

**Fixed** with a `networkd-dispatcher` hook at
`/etc/networkd-dispatcher/carrier.d/50-docker-recover` (not tracked in
this repo — it's host config, like the rest of `/etc`): fires whenever
`ens33` regains carrier, waits 5s for the link to settle, checks whether
`gametorrent-webui`/Komodo actually respond locally, and only if not,
restarts Docker. Guards against restart-loops by filtering to `ens33`
only (ignoring `docker0`/`br-*`/`veth*` interface events) and using a
`flock` to prevent overlapping runs. `networkd-dispatcher` is already
installed and enabled on this VM, so no new service was needed.

The **real** fix — switching the VM's network adapter from `e1000` to
VMware's `vmxnet3` (paravirtualized, doesn't have this flakiness) — is a
hypervisor-level VM setting, not something fixable over SSH; the
dispatcher hook is a mitigation for the symptom, not the underlying cause.

## 6. Honest gaps

- **No CI/CD-driven deploy** from `cicd/.gitlab-ci.yml` (that pipeline's
  deploy stage still targets the poc CLI image and isn't wired up) — but
  `gametorrent-webui` now deploys via Komodo instead, so this gap matters
  less than it used to.
- **Only 2 catalog entries** — `bobl`/`anguna` were removed (see §3) rather
  than shipped broken; the default catalog is small until real sources for
  more homebrew titles are found.
- **`torrentFile` source type** is schema-valid but not implemented in
  `pipeline.js` — only `magnet` and `directUrl` actually work end-to-end.
- **Switch entries have no `emulatorId`** by design — there's no PC
  emulator step for Switch homebrew; the user copies the `.nro` to their
  own homebrew-enabled console by hand.
