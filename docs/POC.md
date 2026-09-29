# Phase 1 PoC

Minimal Node.js proof of the pipeline: **magnet → selective download → ClamAV scan → extract → hash verify → VirusTotal hash lookup → launch**.
This validates the approach; the real app reimplements this in Rust (see [ARCHITECTURE.md](ARCHITECTURE.md)).

## Setup

```bash
cd poc
npm install
```

### Optional: malware scanning

Both checks are best-effort and additive — they detect *known* threats by
signature, they don't prove a file is safe. Neither is required to run the
PoC; both degrade gracefully (warn + continue) if not configured.

**ClamAV** (local, offline, scans inside archives):

1. Install ClamAV — on Windows, download the installer from
   [clamav.net/downloads](https://www.clamav.net/downloads) (or
   `choco install clamav` if you use Chocolatey); on macOS/Linux,
   `brew install clamav` / your package manager.
2. Update the signature database once (and periodically after):
   ```bash
   freshclam
   ```
3. Confirm `clamscan` is on PATH: `clamscan --version`.

**Docker image gotcha:** the web UI image needs `ca-certificates` next to `clamav` — the slim base has none, so `freshclam` fails with "Problem with the SSL CA cert", the signature DB stays empty, and every scan logs "clamscan did not complete (exit 2)" and is skipped. Check with `docker exec gametorrent-webui clamscan --version` ("Known viruses" must be non-zero in a real scan's summary) and `ls /var/lib/clamav` (needs main.cvd + daily.cvd).

If `clamscan` isn't found, the PoC prints a warning and continues — pass
`--require-scan` to make a missing ClamAV a hard failure instead.

**VirusTotal** (hash-only lookup against ~70 vendors' signature DBs, no file upload):

1. Get a free API key at [virustotal.com](https://www.virustotal.com/gui/join-us) (sign up → API key in your profile).
2. Set it as an environment variable before running the PoC:
   ```bash
   export VT_API_KEY="your-key-here"      # bash
   $env:VT_API_KEY = "your-key-here"      # PowerShell
   ```

Without `VT_API_KEY` set, the lookup is silently skipped. Pass `--no-vt` to
skip it even with a key set. A `malicious > 0` result from either check
aborts the pipeline before extraction/launch — there's deliberately no flag
to override a positive detection.

## Try it with a real, legal test torrent (no game files needed)

The catalog's bundled entries (`../catalog/catalog.json`) use **placeholder**
`example.org` magnet/URLs — they won't resolve. To smoke-test the download →
extract → verify pipeline itself before wiring up a real homebrew magnet,
use a known public-domain/CC-licensed test torrent, such as the "Sintel"
open movie demo magnet published on [webtorrent.io](https://webtorrent.io)
(Blender Foundation, Creative Commons) — copy the current magnet link from
that site and run:

```bash
node poc.js --magnet "<paste magnet uri from webtorrent.io>" \
  --select "*.mp4" \
  --platform pc \
  --dest sintel-test \
  --archive none \
  --rom "sintel.mp4"
```

This exercises selective-file download and the copy-to-`roms/` step without
touching any ROM/game content. Omit `--emulator` and it'll skip the launch
step entirely.

## Once you have a real homebrew magnet/torrent

1. Get the actual magnet URI or `.torrent` URL from the homebrew author's own
   site/release page (e.g. itch.io, GitHub Releases) and confirm the license.
2. Either pass it directly:

   ```bash
   node poc.js --magnet "magnet:?xt=urn:btih:...&dn=TobuTobuGirl" \
     --platform gb --dest tobu-tobu-girl --archive zip \
     --rom "TobuTobuGirl.gb" --emulator gb --launch
   ```

3. Or fill in the real magnet URI in `../catalog/catalog.json` for the
   matching game id, then run catalog mode:

   ```bash
   node poc.js --game tobu-tobu-girl --launch
   ```

`--emulator <id>` / catalog mode looks up `../config/emulators.json` for the
CLI template; edit `executable` there to match where RetroArch (or whichever
emulator) is actually installed on your machine. Without `--launch`, the
script prints the resolved command instead of running it.

`--rom` is optional in direct mode — omit it and the pipeline auto-detects
the ROM by file extension once extraction finishes (e.g. `--platform nds`
looks for a single `*.nds` file anywhere in the extracted output,
including nested folders). It errors out asking you to specify `--rom`
explicitly if it finds zero or more than one match, or if the platform has
no known extension mapped (`ROM_EXTENSIONS` in `pipeline.js` — `dos`/`pc`
are deliberately excluded, `.exe`/`.com` aren't unique enough to a "game"
to guess safely).

### Auto-detection (webui default)

When `platform` is `auto` (or omitted) and `archiveFormat` is `auto` — what the web UI's one-click **Download** sends — the pipeline works both out itself:

- **Archive:** exactly one downloaded `.zip` → extracted, otherwise files are used as-is.
- **Platform:** a platform word in the title ("GBA", "Nintendo DS", ...) is used up front; otherwise, after download, the file extensions decide (`.gba`, `.nds`, `.sfc`, ... — shared ones like `.iso`/`.bin` are ignored). A zip is unpacked to a staging folder first so its contents can be inspected. If nothing identifies the platform it fails and asks you to pick one via "Add custom download".

Jobs can also carry `excludeTypes` (`video`, `audio`, `images`, `docs` — see `FILE_TYPE_EXTENSIONS` in `pipeline.js`) to skip those files inside a torrent; if that leaves nothing to download, the job fails with a message saying so.

Torrent downloads also log peer count/speed every 30 s, give up after 3 minutes without metadata (dead torrent / no reachable peers), and can be cancelled from the Downloads tab.

### Archive format matters — set it to match what the torrent actually contains

`--archive none` copies whatever files were downloaded as-is (no
unzipping); `--archive zip` extracts a `.zip` first. If the torrent's
payload **is** a zip but you leave `--archive none` (the default), the
`.zip` file itself gets copied into `roms/`, never unpacked — so ROM
auto-detect then correctly reports "no file matching .gba found", because
there genuinely isn't a bare `.gba` yet, only a `.zip`. If you see that
error, check whether the download log mentions more than one file and
whether one of them is a `.zip` — if so, redo the download with
`--archive zip` (webui: "Archive format" → "Zip").

Conversely, `--archive zip` requires exactly one `.zip` among the
downloaded files — with no `--select` filter narrowing a multi-file
torrent down, it errors out asking you to disambiguate (e.g.
`--select "*.zip"`) rather than guessing which file to extract.

## Security note

`npm audit` flags `extract-zip` for an unpatched symlink path-traversal
advisory ([GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv))
and `webtorrent`'s tracker stack for a transitive `ip` SSRF issue. Both are
acceptable for a local Phase 1 PoC but matter for real use, since a malicious
torrent's zip is exactly the untrusted input this pipeline extracts. Before
shipping: the Rust build should extract via the `zip` crate with an explicit
check that every entry's resolved path stays inside the destination
directory (reject `../` traversal and symlinks pointing outside it), rather
than trusting the archive's paths as-is.

## Known PoC limitations (fine for Phase 1, not for shipping)

- Only `source.type: "magnet"` and `archiveFormat: "zip"` are implemented
  end-to-end (torrentFile/directUrl sources and .7z/.rar extraction throw a
  clear "not implemented, see Rust build" error).
- `crc32` verification is a no-op stub.
- No progress UI beyond a stdout percentage line — the real app surfaces
  this through Tauri events to the frontend.
- ClamAV/VirusTotal are signature/hash-based — they catch known threats,
  not novel ones. Treat them as one layer, not a guarantee; see the
  discussion in [ARCHITECTURE.md](ARCHITECTURE.md#5-malware-scanning).
