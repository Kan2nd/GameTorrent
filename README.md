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

## Legal model

- Zero hardcoded links to commercial copyrighted ROMs or scraper code for illegal sites, anywhere in this codebase.
- Bundled catalog = empty; anything it ever ships must be legal homebrew/freeware (the two entries it used to hold are in git history).
- Custom feeds are 100% user-supplied and user-responsible; the engine (torrent client, extractor, launcher) is content-agnostic and doesn't validate legality of user-added feeds beyond schema shape.
- Torrent search (web UI's Search tab) works the same way: GameTorrent contains no indexer-specific scraping code and ships zero built-in indexers. It only proxies a query to a [Jackett](https://github.com/Jackett/Jackett) instance the user runs and configures themselves, pointed at whatever indexers they have the right to search — see [docs/WEBUI.md](docs/WEBUI.md).
