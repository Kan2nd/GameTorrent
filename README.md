# GameTorrent — Local P2P Game Launcher & ROM Manager

Open-source, local-first game launcher that uses an embedded BitTorrent engine to
fetch game files, automatically extracts them, and launches them through local
emulators via CLI. Ships with a "Bring Your Own Content" (BYOC) model: the
bundled catalog is empty (it can hold only free, legally redistributable homebrew titles).
Users may point the app at their own remote/local feeds, or at their own Jackett instance for torrent search —
the app itself never links to or scrapes copyrighted commercial ROMs.

See [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md) for a full map of
what's in this repo and what each piece does. For specific pieces:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (Phase 1 stack rationale, data
flow), [docs/POC.md](docs/POC.md) (run the CLI proof-of-concept),
[docs/WEBUI.md](docs/WEBUI.md) (browser dashboard, setup, API, torrent
search), [docs/CI_CD.md](docs/CI_CD.md) (branch strategy and pipeline), and
[docs/GITOPS.md](docs/GITOPS.md) (Komodo-based GitOps deploy for the web UI).

## Repo layout

```
Project GameTorrent/
├── apps/desktop/          # (Phase 2) Tauri app — Rust backend + web frontend
├── catalog/               # catalog.schema.json + example catalog.json + feeds
├── cicd/                  # CI/CD pipeline config + tooling (see docs/CI_CD.md)
│   ├── .gitlab-ci.yml     # validate, SAST/dependency/image scans, build, deploy
│   ├── ansible/           # installs Docker Engine + Compose on the target host
│   ├── deploy/            # docker-compose.yml — poc CLI's plain Docker deploy target, no k8s
│   └── gitops/            # Komodo bootstrap + gametorrent-webui Stack-as-code (see docs/GITOPS.md)
├── config/                # emulators.json (per-platform CLI launch rules)
├── roms/<platform>/       # downloaded + extracted game files (gitignored)
├── poc/                   # Phase 1 Node.js proof-of-concept
│   └── pipeline.js        # shared download/scan/extract/verify/launch logic (used by poc.js AND webui/)
├── webui/                 # browser dashboard — see docs/WEBUI.md; docker-compose.yml is its deploy target
├── Dockerfile             # node:20-bookworm-slim image for poc/ (used by the CI/deploy above)
└── docs/                  # ARCHITECTURE.md, POC.md, WEBUI.md, CI_CD.md, GITOPS.md, CLOUDFLARE_TUNNEL.md, GIT_WORKFLOW.md, PROJECT_STRUCTURE.md, devsecops-notes/
```

## Tech stack

| Layer | Technology | Used for |
|---|---|---|
| Runtime | Node.js 20 (CommonJS) | Shared engine + web server |
| P2P / download | [`webtorrent`](https://webtorrent.io) | Magnet-link downloads, selective file picking |
| Archive extraction | [`extract-zip`](https://www.npmjs.com/package/extract-zip) | Unpacking downloaded archives |
| Malware scanning | [ClamAV](https://www.clamav.net/) (`clamscan` CLI) + [VirusTotal](https://www.virustotal.com/) hash-lookup API | Signature scan pre-extraction, known-malware hash check |
| Web framework | [Express](https://expressjs.com/) + `express-session` | Web UI HTTP server, session-based auth |
| Schema validation | [`ajv`](https://ajv.js.org/) + `ajv-formats` | Validating `catalog.json` against its JSON Schema |
| Torrent search | [Jackett](https://github.com/Jackett/Jackett) (user-hosted, proxied) | Indexer search without any built-in scraper |
| Cover art | [libretro-thumbnails](https://github.com/libretro-thumbnails) (keyless) + optional [RAWG](https://rawg.io/apidocs) fallback | Box-art lookup by title/platform text only |
| Frontend | Vanilla JS, HTML, CSS (no framework) — self-hosted `PressStart2P`/`VT323` fonts, hand-drawn inline-SVG sprites | 8-bit-styled dashboard UI |
| Containerization | Docker, `node:20-bookworm-slim` (glibc — Alpine/musl segfaults `utp-native`) | Both the CLI PoC and the web UI images |
| Orchestration (deploy target) | Docker Compose (deliberately **not** Kubernetes — see `docs/ARCHITECTURE.md`) | Running the web UI + its data volumes on the homelab VM |
| GitOps / CD | [Komodo](https://komo.do) (core + periphery), backed by Postgres + [FerretDB](https://github.com/FerretDB/FerretDB) | Watches `main`, auto-redeploys the Compose stack on merge |
| CI pipeline | GitLab CI (`cicd/.gitlab-ci.yml`) | validate → SAST → dependency-scan → build → image-scan → deploy gates |
| SAST | [Semgrep](https://semgrep.dev/) | Static code scanning in CI |
| Dependency / image scanning | [Trivy](https://aquasecurity.github.io/trivy/) | Vulnerable dependency + container image scanning in CI |
| Config management | [Ansible](https://www.ansible.com/) | Bootstrapping Docker Engine + Compose on the target VM |
| Ingress tunnel | [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (`cloudflared`, quick tunnel) | Outbound-only path for the GitLab deploy webhook — no inbound ports opened |
| Monitoring | [Uptime Kuma](https://github.com/louislam/uptime-kuma) | Web UI liveness monitoring |
| Password hashing | Node `crypto` (`scrypt` + per-user salt, `timingSafeEqual` compare) | `webui/lib/auth.js` |
| Version control / hosting | Git, GitLab (primary, GitOps source of truth) | `dev`/`main` branch workflow — see `docs/GIT_WORKFLOW.md` |
| Planned (Phase 2) | [Tauri](https://tauri.app/) (Rust backend + web frontend) | Native desktop app shell, in `apps/desktop/` |

## Legal model

- Zero hardcoded links to commercial copyrighted ROMs or scraper code for illegal sites, anywhere in this codebase.
- Bundled catalog = empty; anything it ever ships must be legal homebrew/freeware (the two entries it used to hold are in git history).
- Custom feeds are 100% user-supplied and user-responsible; the engine (torrent client, extractor, launcher) is content-agnostic and doesn't validate legality of user-added feeds beyond schema shape.
- Torrent search (web UI's Search tab) works the same way: GameTorrent contains no indexer-specific scraping code and ships zero built-in indexers. It only proxies a query to a [Jackett](https://github.com/Jackett/Jackett) instance the user runs and configures themselves, pointed at whatever indexers they have the right to search — see [docs/WEBUI.md](docs/WEBUI.md).

## Why this project is a security/DevOps exercise, not just a game launcher

The interesting problem here isn't the UI — it's that **every file this app
touches originates from an untrusted, anonymous peer on a torrent swarm**, and
the app still has to extract it, put it on disk, and hand it to a native
emulator process. That threat model is what shaped the pipeline and the
deployment setup below.

### Data flow: from a magnet link to a picture on your screen

```
 ┌────────────┐   ┌───────────────┐   ┌────────────┐   ┌───────────────┐
 │ 1. Search   │→ │ 2. Download    │→ │ 3. Isolate  │→ │ 4. Scan        │
 │ Jackett     │  │ webtorrent /   │  │ own subdir  │  │ ClamAV (local) │
 │ proxy query │  │ direct HTTP    │  │ per job,    │  │ + VirusTotal   │
 │ (no scrape) │  │ selective-file │  │ never overw │  │ hash lookup    │
 └────────────┘   │ download       │  │ -rites live │  └──────┬────────┘
                   └───────────────┘   │ install     │         │ clean
                                        └────────────┘         ▼
 ┌────────────┐   ┌───────────────┐   ┌────────────┐   ┌───────────────┐
 │ 8. Launch   │← │ 7. Track       │← │ 6. Serve    │← │ 5. Extract +   │
 │ emulator,   │  │ stats.js       │  │ web UI:     │  │ verify         │
 │ allowlisted │  │ download count │  │ auth'd      │  │ path-safe      │
 │ CLI args    │  │ (per-IP rate-  │  │ session,    │  │ unzip, SHA-256 │
 │ only        │  │ limited)       │  │ RBAC        │  │ hash check     │
 └────────────┘   └───────────────┘   └──────┬──────┘  └───────────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │ Cover art: title/  │
                                    │ platform text only │
                                    │ → libretro/RAWG     │
                                    │ (no file content    │
                                    │ ever leaves the box) │
                                    └────────────────────┘
```

1. **Search** — `webui/lib/providers.js` only forwards a search string to a
   Jackett instance the user owns; GameTorrent has no indexer code of its own.
2. **Download** — `poc/pipeline.js` pulls via `webtorrent` (magnet, selective
   file picking so a multi-disc torrent doesn't pull everything) or plain
   HTTPS with redirects (`directUrl`).
3. **Isolate** — every job gets its own destination folder under `roms/<platform>/<job>`;
   nothing is written outside that path (see path-traversal note below).
4. **Scan** — the raw downloaded payload is scanned with the local `clamscan`
   CLI (`scanWithClamAV`) before extraction. A scan failure or detected threat
   aborts the pipeline — the file is never extracted or exposed.
5. **Extract + verify** — archives are extracted with `extract-zip`; the
   resulting ROM's SHA-256 is computed and optionally checked against a
   user-supplied hash and against VirusTotal's *hash* database (`VT_API_KEY`) —
   never the file content itself, so nothing is uploaded to a third party.
6. **Serve** — the web UI only exposes what's already on disk, behind a
   session-authenticated, role-gated (admin/standard) Express app.
7. **Track** — download counts persist to `webui/data/stats.json`; the
   download-serving route is rate-limited per IP to blunt scripted scraping
   of the library.
8. **Launch** — an emulator is invoked from a fixed allowlist in
   `config/emulators.json`; the launcher only ever appends the resolved,
   validated ROM path as an argument — it never passes a torrent-supplied
   string into a shell.

### Isolation boundaries (what's supposed to stop a bad file from doing damage)

| Boundary | Mechanism | File |
|---|---|---|
| Peer → disk | Own job subfolder; extraction target is `path.resolve`'d and checked with `startsWith(base + path.sep)` before any write | `poc/pipeline.js`, `webui/lib/library.js` |
| Peer → scanner | ClamAV runs against the extracted directory before the app trusts any file in it | `poc/pipeline.js: scanWithClamAV` |
| Peer → identity | SHA-256 verify + VirusTotal *hash* lookup (metadata only, no upload) before launch | `poc/pipeline.js: verifyHash, checkVirusTotal` |
| Browser → filesystem | `/api/installed/*` and the admin delete route resolve paths under `ROMS_DIR` and reject `.`, `..`, and embedded separators | `webui/server.js`, `webui/lib/library.js` |
| User → app | Session auth (`express-session`) gates every `/api/*` route; `requireAdmin` gates delete | `webui/lib/auth.js`, `webui/server.js` |
| Client → server | Per-IP rate limiting on the ROM-download route (default: 5/min) | `webui/lib/rateLimit.js` |
| App → OS process | Emulator launch args come only from `config/emulators.json` + the already-verified ROM path — never raw torrent metadata | `poc/pipeline.js` |
| Container → host | `node:20-bookworm-slim` (glibc, not Alpine — `utp-native` segfaults on musl), runs as the image's default non-root-capable Node runtime, no host network mode | `Dockerfile`, `webui/Dockerfile` |
| Secrets → repo | `credentials.md`, `webui/data/`, `cicd/gitops/compose.env` are all gitignored; provider API keys (Jackett) are stored server-side only, masked (`apiKeySet: true/false`) before ever reaching the browser | `.gitignore`, `webui/lib/providers.js` |

Passwords in `webui/data/users.json` are scrypt-hashed with a per-user salt
(`webui/lib/auth.js`), with constant-time comparison (`crypto.timingSafeEqual`)
to resist timing attacks on login.

### DevOps: how this ships

- **CI (`cicd/.gitlab-ci.yml`)**: validate → SAST/dependency/image scanning →
  build → deploy, so a vulnerable dependency or a bad image is caught before
  it reaches the host, not after.
- **GitOps, not manual deploys**: [Komodo](https://komo.do) watches the
  `main` branch and redeploys the `gametorrent-webui` Docker Compose stack
  automatically on merge — see [docs/GITOPS.md](docs/GITOPS.md).
- **`dev`/`main` split with a hard rule**: all work lands on `dev`; merging to
  `main` is the deploy trigger, so nobody (human or AI) pushes to `main`
  directly — see [docs/GIT_WORKFLOW.md](docs/GIT_WORKFLOW.md).
- **No inbound ports opened on the router**: the deploy webhook reaches a
  private homelab VM through an outbound-only Cloudflare Tunnel, so the CI/CD
  trigger doesn't require exposing the host to the internet — see
  [docs/CLOUDFLARE_TUNNEL.md](docs/CLOUDFLARE_TUNNEL.md).
- **Config/secrets separation**: runtime secrets are environment variables
  and gitignored files, never baked into the image or committed
  (`WEBUI_USER`/`WEBUI_PASSWORD`/`SESSION_SECRET`/`VT_API_KEY`/`RAWG_API_KEY`).
- **Monitoring**: Uptime Kuma tracks the web UI's liveness independently of
  the app itself.

### Known gaps (documented, not hidden)

- ClamAV signature-based scanning only catches known malware; it is not a
  sandbox and won't catch a novel payload.
- `docs/GIT_WORKFLOW.md` and `docs/CLOUDFLARE_TUNNEL.md` also record real
  incidents from running this (a webhook secret reset, a path-traversal fix,
  a squash-merge conflict loop) as a working log of what broke and why.
- The Cloudflare quick tunnel has no domain, so its URL is not stable — see
  the tunnel doc for the tradeoffs and the upgrade path.
