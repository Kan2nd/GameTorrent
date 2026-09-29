# Phase 1 — Architecture & Stack Recommendation

## 1. Tech stack

### Recommended end state: **Tauri (Rust) + web frontend**

| Layer | Choice | Why |
|---|---|---|
| Shell/runtime | **Tauri 2.x** | Native webview (no bundled Chromium) → ~10-20MB installers vs ~150MB+ for Electron; Rust host process gives direct, safe access to the filesystem and subprocess spawning needed for the emulator launcher. |
| Frontend | React or Svelte + TypeScript + Vite | Either works; Svelte is lighter if bundle size matters, React if you want the bigger ecosystem/component libraries for a library-browser UI. |
| Torrent engine | **`librqbit`** (pure Rust BitTorrent library) embedded directly in the Rust backend | No C++ toolchain / libtorrent-rasterbar build pain on Windows; supports magnet links, per-file selective download, and DHT. Exposed to the frontend via Tauri commands + events (progress, piece completion). |
| Archive extraction | `zip`, `sevenz-rust`, `unrar` (or shelling out to bundled `7z.exe`/`unrar.exe` binaries) | Cover `.zip`/`.7z`/`.rar` without requiring the user to have 7-Zip installed. **Must** validate that every extracted entry's resolved path stays inside the destination dir — archives are untrusted (torrent-sourced) input, and path-traversal/symlink-escape via crafted zip entries is a real, exploited vulnerability class (see `POC.md`'s security note on `extract-zip`). |
| Hashing | Rust `sha2`/`md-5`/`crc32fast` | Optional integrity check against `catalog.json`'s `verification` block before launch. |
| Emulator launcher | `std::process::Command` | Spawns the configured emulator binary with templated CLI args (see `config/emulators.json`). |

### Recommended path to get there: **prototype in Electron/Node.js first**

Native Rust torrent/archive crates are the right choice for a shippable v1, but
they have real setup friction (Rust toolchain, crate maturity for `.rar`,
Windows codesigning). For **Phase 1** — proving the pipeline end-to-end — a
Node.js PoC using `webtorrent` (pure JS, no native deps, built-in selective
download API) is faster to get running and is what's in [`poc/`](../poc). It
validates the pipeline shape (magnet → selective download → extract → verify
→ launch) that the Tauri/Rust version will later reimplement natively.

Do **not** ship the Electron/WebTorrent version as the final product if binary
size / resource usage matters — migrate the validated logic into the Rust
backend once the UX and catalog format are stable.

## 2. Folder structure (target, once `apps/desktop` exists)

```
apps/desktop/
├── src/                      # frontend
│   ├── components/
│   ├── pages/                # Library, Downloads, Settings, FeedManager
│   ├── stores/                # download progress, catalog state
│   └── main.tsx
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── torrent/          # librqbit session wrapper, selective-file logic
│   │   ├── extract/          # zip/7z/rar dispatch by catalog `extraction.archiveFormat`
│   │   ├── catalog/          # fetch/parse/validate catalog.json + remote feeds
│   │   ├── launcher/         # emulator CLI templating + spawn
│   │   └── hash/             # checksum verification
│   ├── Cargo.toml
│   └── tauri.conf.json
└── package.json

catalog/
├── catalog.schema.json       # JSON Schema (draft-07)
├── catalog.json              # default bundled legal homebrew catalog
└── feeds/                    # example third-party feed.json files

config/
└── emulators.json            # per-platform emulator CLI launch rules

roms/<platform>/              # download+extract destination, gitignored
```

## 3. Pipeline (both PoC and final app)

```
magnet: / .torrent  ──▶  torrent engine (selective file download)
                              │
                              ▼
                     ./downloads/<gameId>/  (raw torrent payload)
                              │
                    ClamAV scan (local, signature-based)
                              ▼
                   extract (.zip/.7z/.rar) per catalog.extraction
                              ▼
                     ./roms/<platform>/<destSubfolder>/
                              │
                 verify sha256 against catalog.verification (if present)
                              ▼
              VirusTotal hash lookup (hash only, ~70 vendors' signatures)
                              ▼
              spawn emulator: config/emulators.json[launch.emulatorId]
                 with args templated using {romPath}
```

A `malicious > 0` result from either scan step aborts the pipeline before
extraction/launch, with no override flag — see §5.

## 4. Legal/safety boundary

- The **engine** (torrent client, extractor, hash verifier, launcher) has zero
  knowledge of "what a game is" — it just executes catalog entries. No
  copyrighted magnet links, torrent files, or scraper code live in this repo.
- The **default catalog** (`catalog/catalog.json`) is hand-curated, containing
  only titles explicitly released as freeware/open-source/public-domain
  homebrew by their authors.
- **User feeds** (arbitrary `feed.json` URLs or local files matching the same
  schema) are a first-class, clearly separated input path — the app trusts
  the schema, not the content's legality. This mirrors how a generic torrent
  client or podcast app doesn't vet every feed it's pointed at.

## 5. Malware scanning

Both catalog-controlled hash pinning and active malware scanning matter here
because the trust models differ: the **default catalog** is hand-curated by
us, so a `verification.hash` mismatch means tampering/corruption, not
"unknown content." **User feeds** carry no such guarantee — anything they
point at is unvetted third-party content, so this is where scanning actually
earns its keep.

Two checks, both signature/hash-based (they catch *known* threats, not
novel ones — this is a detection layer, not a safety guarantee):

- **ClamAV** — free, open-source, local, offline. Signatures come from
  Cisco Talos + community submissions, distributed via `freshclam`. Scans
  the raw downloaded archive (including inside zips) before extraction.
- **VirusTotal hash lookup** — aggregates ~70 vendors' own signature
  databases (Defender, Kaspersky, Bitdefender, etc.) behind one API. Only
  the file's SHA-256 is sent, never the file itself, so it's privacy-safe
  for a hash that was going to be computed for verification anyway. A
  404 means "not previously seen," not "safe" — treat unknown the same
  as untrusted, don't treat it as a pass.

Implemented in the PoC as pipeline steps (`poc/poc.js`): `scanWithClamAV()`
before extraction, `checkVirusTotal()` after the final ROM hash is computed.
Either detecting `malicious > 0` throws and aborts before extraction/launch;
there's intentionally no CLI flag to proceed past a positive hit. Missing
ClamAV/no VT API key degrade to a warning + skip, not a hard failure, unless
`--require-scan` is passed — see [`POC.md`](POC.md) for
setup. The Rust build should carry the same two checks (`clamav-rs` bindings
or shelling out to `clamscan`, plus the same VT REST call) as one of the
pipeline stages, not an optional bolt-on.
