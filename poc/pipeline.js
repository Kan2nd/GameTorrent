/**
 * GameTorrent pipeline core — shared by the CLI (poc.js) and the web UI
 * (../webui). Download -> ClamAV scan -> extract -> hash verify -> VirusTotal
 * lookup -> optional emulator launch.
 *
 * This module never prints directly: every step reports through the
 * `emitter` passed in ('log' and 'progress' events), so a CLI can print to
 * stdout and the web UI can store the same events per-job for polling,
 * without either caller needing to know about the other.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');

const WebTorrent = require('webtorrent');
const extractZip = require('extract-zip');

const ROOT = path.resolve(__dirname, '..');
// GT_DOWNLOADS_DIR / GT_ROMS_DIR override these so tests can use throwaway folders.
const DOWNLOADS_DIR = path.resolve(process.env.GT_DOWNLOADS_DIR || path.join(ROOT, 'downloads'));
const ROMS_DIR = path.resolve(process.env.GT_ROMS_DIR || path.join(ROOT, 'roms'));
const CATALOG_PATH = path.join(ROOT, 'catalog', 'catalog.json');
const EMULATORS_PATH = path.join(ROOT, 'config', 'emulators.json');

// --- Path safety ---
// Folder/file names in a job (destSubfolder, platform, a direct-URL's filename) come from outside
// this program — a web form, a request, a third-party feed. Each one ends up in a path.join() that
// decides where on disk files get written, so each one must be a single plain name: no separators,
// no "." / "..", nothing that could climb out of downloads/ or roms/.
const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_PLATFORM_RE = /^[a-z0-9]{1,20}$/;

function assertSafeName(value, label) {
  const s = String(value == null ? '' : value);
  if (!SAFE_NAME_RE.test(s) || s === '.' || s === '..') {
    throw new Error(`${label} must be a plain folder/file name (letters, digits, ".", "_", "-"), got "${s.slice(0, 60)}"`);
  }
  return s;
}

function assertSafePlatform(value) {
  const s = String(value == null ? '' : value);
  if (s !== 'auto' && !SAFE_PLATFORM_RE.test(s)) throw new Error(`platform must be a short lowercase id like "gba", got "${s.slice(0, 30)}"`);
  return s;
}

/** Throws unless target is strictly inside base — the last line of defence before any write/read. */
function assertInside(base, target, label) {
  const b = path.resolve(base);
  const t = path.resolve(target);
  if (!t.startsWith(b + path.sep)) throw new Error(`${label} resolves outside ${b} — refusing`);
  return t;
}

// --- Outbound fetch guard (SSRF) ---
// Feed URLs and direct-download URLs are typed in by people, and the server fetches them from
// INSIDE the network — where it can reach things a visitor can't (Komodo, Jackett, Uptime Kuma,
// the LAN, the Docker network). So these fetches may only go to public addresses. Checked at two
// points: IP-literal hosts before the request (Node skips DNS lookup for those), and every
// DNS-resolved address at connect time via a custom `lookup` (which also closes DNS-rebinding and
// redirect-to-internal tricks, since each hop reconnects through it). ALLOW_PRIVATE_FETCH=1 turns
// the guard off for setups that deliberately host feeds/files on the LAN.
const net = require('net');
const dns = require('dns');

const BLOCKED_NETS = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
]) BLOCKED_NETS.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  BLOCKED_NETS.addSubnet(addr, prefix, 'ipv6');
}

function isBlockedAddress(ip) {
  if (process.env.ALLOW_PRIVATE_FETCH === '1') return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip); // IPv4-mapped IPv6 -> check as IPv4
  if (mapped) return BLOCKED_NETS.check(mapped[1], 'ipv4');
  return BLOCKED_NETS.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

/** Throws unless url is http(s) and (if its host is an IP literal) a public address. */
function assertFetchAllowed(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`Not a valid URL: ${String(url).slice(0, 80)}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Only http/https URLs are allowed, got ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host)) throw new Error(`Refusing to fetch from a private/internal address (${host})`);
  return u;
}

/** Drop-in `lookup` for http(s).get: resolves normally, then refuses private/internal results. */
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad) return callback(new Error(`Refusing to connect to ${hostname}: it resolves to a private/internal address (${bad.address})`));
    callback(null, address, family);
  });
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadCatalog() {
  return loadJson(CATALOG_PATH);
}

function loadEmulators() {
  return loadJson(EMULATORS_PATH);
}

/** Tiny `*`-only glob matcher, enough for selecting torrent files by extension/name. */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Builds a job from a catalog.json/feed game id. Supports magnet, torrentFile, and directUrl sources. */
function buildJobFromGameId(gameId, catalog) {
  catalog = catalog || loadCatalog();
  const game = catalog.games.find((g) => g.id === gameId);
  if (!game) throw new Error(`Game id "${gameId}" not found`);

  if (game.source.type === 'torrentFile') {
    throw new Error(
      `PoC doesn't implement source.type "torrentFile" yet (magnet and directUrl work); "${game.id}" uses it. ` +
      `See docs/ARCHITECTURE.md — the Rust build handles all three.`
    );
  }

  let emulator = null;
  if (game.launch.emulatorId) {
    const emulators = loadEmulators();
    emulator = emulators[game.launch.emulatorId];
    if (!emulator) throw new Error(`Emulator "${game.launch.emulatorId}" not found in ${EMULATORS_PATH}`);
  }

  return {
    gameId: game.id,
    title: game.title,
    platform: assertSafePlatform(game.platform),
    sourceType: game.source.type,
    magnetUri: game.source.magnetUri,
    directUrl: game.source.directUrl,
    selectPatterns: game.source.selectFiles || [],
    // Feeds are third-party content — never trust their folder names.
    destSubfolder: assertSafeName((game.extraction && game.extraction.destSubfolder) || game.id, 'destSubfolder'),
    archiveFormat: (game.extraction && game.extraction.archiveFormat) || 'none',
    romFile: game.launch.romFile,
    verification: game.verification,
    emulator,
    emulatorId: game.launch.emulatorId || null,
    extraArgs: (game.launch.extraArgs) || [],
  };
}

/**
 * Builds a job from plain params (direct/manual mode) — used by the CLI's
 * --magnet flags and the web UI's manual-download form. No emulator is
 * required: a job with no emulatorId just downloads/extracts/verifies and
 * stops there. romFile is also optional — if omitted, resolveRomPath()
 * auto-detects it by file extension once extraction finishes (see
 * ROM_EXTENSIONS below).
 */
function buildJobFromParams(params) {
  if (!params.magnetUri && !params.directUrl) throw new Error('magnetUri or directUrl is required');
  if (!params.destSubfolder) throw new Error('destSubfolder is required');
  assertSafeName(params.destSubfolder, 'destSubfolder');
  if (params.platform) assertSafePlatform(params.platform);

  let emulator = null;
  if (params.emulatorId) {
    const emulators = loadEmulators();
    emulator = emulators[params.emulatorId];
    if (!emulator) throw new Error(`Emulator "${params.emulatorId}" not found in ${EMULATORS_PATH}`);
  }

  return {
    title: params.title || params.destSubfolder,
    platform: (params.platform && params.platform !== 'auto')
      ? params.platform
      : (guessPlatformFromText(`${params.title || ''} ${params.destSubfolder}`) || 'auto'),
    sourceType: params.magnetUri ? 'magnet' : 'directUrl',
    magnetUri: params.magnetUri,
    directUrl: params.directUrl,
    selectPatterns: params.selectPatterns || [],
    excludeTypes: (params.excludeTypes || []).filter((t) => Object.prototype.hasOwnProperty.call(FILE_TYPE_EXTENSIONS, t)),
    destSubfolder: params.destSubfolder,
    archiveFormat: params.archiveFormat || 'auto',
    romFile: params.romFile || null,
    verification: params.sha256 ? { algorithm: 'sha256', hash: params.sha256 } : null,
    emulator,
    emulatorId: params.emulatorId || null,
    extraArgs: params.extraArgs || [],
  };
}

// File-type groups a job can exclude from a torrent (job.excludeTypes). Only affects which torrent
// files get downloaded — e.g. skipping the video/audio/screenshots some ROM torrents bundle.
const FILE_TYPE_EXTENSIONS = {
  video: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.vob'],
  audio: ['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.wma', '.opus'],
  images: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tif', '.tiff'],
  docs: ['.txt', '.nfo', '.pdf', '.doc', '.docx', '.rtf', '.diz', '.url', '.html', '.htm'],
};

const METADATA_TIMEOUT_MS = 3 * 60 * 1000;
const STATUS_LOG_INTERVAL_MS = 30 * 1000;

/**
 * Downloads the torrent, selecting only files matching selectPatterns (or all, if none given).
 * Logs peer/speed status while running, gives up if metadata never arrives (no reachable
 * peers), and aborts if the emitter fires 'cancel'.
 */
function downloadTorrent(job, emitter) {
  return new Promise((resolve, reject) => {
    const client = new WebTorrent();
    const outDir = assertInside(DOWNLOADS_DIR, path.join(DOWNLOADS_DIR, job.destSubfolder), 'download folder');
    fs.mkdirSync(outDir, { recursive: true });

    let settled = false;
    let metaTimer = null;
    let statusTimer = null;
    const settle = (fn) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(metaTimer);
      clearInterval(statusTimer);
      fn(value);
    };
    const ok = settle(resolve);
    const fail = settle((err) => { try { client.destroy(); } catch { /* already gone */ } reject(err); });

    client.on('error', fail);
    emitter.once('cancel', () => fail(new Error('Cancelled by user')));

    emitter.emit('log', 'Fetching torrent metadata (connecting to peers)...');
    metaTimer = setTimeout(() => fail(new Error(
      'Timed out after 3 minutes waiting for torrent metadata — no reachable peers or trackers for this magnet (dead torrent, or outbound torrent traffic is blocked).'
    )), METADATA_TIMEOUT_MS);

    const torrent = client.add(job.magnetUri, { path: outDir }, (t) => {
      clearTimeout(metaTimer);
      const matchers = job.selectPatterns.map(globToRegExp);
      let wanted = matchers.length
        ? t.files.filter((f) => matchers.some((re) => re.test(f.name)))
        : t.files;

      if (matchers.length && wanted.length === 0) {
        fail(new Error(`No files in torrent matched patterns: ${job.selectPatterns.join(', ')}`));
        return;
      }

      const excluded = job.excludeTypes || [];
      if (excluded.length) {
        const skipExts = new Set(excluded.flatMap((type) => FILE_TYPE_EXTENSIONS[type] || []));
        const before = wanted.length;
        wanted = wanted.filter((f) => !skipExts.has(path.extname(f.name).toLowerCase()));
        if (wanted.length === 0) {
          fail(new Error(`Every file in this torrent (${before}) is of a skipped type (${excluded.join(', ')}) — untick a type in the file filter to download it.`));
          return;
        }
        if (wanted.length < before) emitter.emit('log', `Skipping ${before - wanted.length} file(s) by type filter (${excluded.join(', ')}).`);
      }

      // Selective download: deselect everything, then select only what we want.
      t.deselect(0, t.pieces.length - 1, false);
      wanted.forEach((f) => f.select());

      emitter.emit('log', `Downloading ${wanted.length}/${t.files.length} file(s) to ${outDir}`);

      t.on('download', () => {
        emitter.emit('progress', t.progress);
      });

      t.on('done', () => {
        emitter.emit('progress', 1);
        emitter.emit('log', 'Download complete.');
        client.destroy(() => ok({ outDir, files: wanted.map((f) => f.path) }));
      });
    });

    statusTimer = setInterval(() => {
      const kbps = Math.round(torrent.downloadSpeed / 1024);
      const state = torrent.files && torrent.files.length ? `${Math.round(torrent.progress * 100)}%` : 'waiting for metadata';
      emitter.emit('log', `Status: ${torrent.numPeers} peer(s), ${kbps} KB/s, ${state}`);
    }, STATUS_LOG_INTERVAL_MS);
  });
}

/** Plain HTTP(S) download for source.type "directUrl" — most small homebrew (Switch .nro, itch.io zips) is distributed this way, not via torrent. Follows one redirect hop. */
function downloadDirect(job, emitter, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const outDir = assertInside(DOWNLOADS_DIR, path.join(DOWNLOADS_DIR, job.destSubfolder), 'download folder');
    // Checked on every hop — this function recurses for each redirect, so a public URL that
    // redirects somewhere internal is caught here too (and by guardedLookup at connect time).
    let target;
    try { target = assertFetchAllowed(job.directUrl); } catch (err) { reject(err); return; }
    fs.mkdirSync(outDir, { recursive: true });

    const lib = target.protocol === 'http:' ? require('http') : https;
    lib.get(target, { lookup: guardedLookup }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        // Location may be relative — resolve it against the URL that sent it.
        const next = new URL(res.headers.location, target).toString();
        downloadDirect({ ...job, directUrl: next }, emitter, redirectsLeft - 1)
          .then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode} downloading ${job.directUrl}`));
        res.resume();
        return;
      }

      // The URL's last segment becomes the filename. Decoding can turn "%2F" into "/", so reduce
      // it to a bare basename afterwards and fall back to a fixed name if what's left isn't plain.
      let filename;
      try { filename = path.basename(decodeURIComponent(job.directUrl.split('/').pop().split('?')[0])); }
      catch { filename = ''; }
      if (!SAFE_NAME_RE.test(filename) || filename === '.' || filename === '..') filename = 'download.bin';
      const destPath = assertInside(outDir, path.join(outDir, filename), 'download file');
      const total = parseInt(res.headers['content-length'], 10) || 0;
      let received = 0;

      emitter.emit('log', `Downloading ${job.directUrl} to ${outDir}`);
      const file = fs.createWriteStream(destPath);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total) emitter.emit('progress', received / total);
      });
      res.pipe(file);
      file.on('finish', () => {
        emitter.emit('progress', 1);
        emitter.emit('log', 'Download complete.');
        file.close(() => resolve({ outDir, files: [filename] }));
      });
      file.on('error', reject);
    }).on('error', reject);
  });
}

/** Dispatches to the right transport based on job.sourceType. */
function fetchPayload(job, emitter) {
  if (job.sourceType === 'directUrl') return downloadDirect(job, emitter);
  return downloadTorrent(job, emitter);
}

function isZip(f) { return path.extname(f).toLowerCase() === '.zip'; }

/** The single .zip among the downloaded files — zero or several is ambiguous, so it errors rather than guessing. */
function pickZip(downloadResult) {
  const zipCandidates = downloadResult.files.filter(isZip);
  if (zipCandidates.length === 0) {
    throw new Error(
      `archiveFormat is "zip" but none of the downloaded file(s) (${downloadResult.files.join(', ')}) ` +
      `end in .zip — check "Select only files matching" or the archive format.`
    );
  }
  if (zipCandidates.length > 1) {
    throw new Error(
      `archiveFormat is "zip" but multiple .zip files were downloaded (${zipCandidates.join(', ')}) ` +
      `— use "Select only files matching" to narrow it down to one.`
    );
  }
  return path.join(downloadResult.outDir, zipCandidates[0]);
}

/** 'auto' means: exactly one downloaded .zip -> extract it, otherwise treat the files as-is. */
function resolveArchiveFormat(job, downloadResult, emitter) {
  if (job.archiveFormat !== 'auto') return job.archiveFormat || 'none';
  const format = downloadResult.files.filter(isZip).length === 1 ? 'zip' : 'none';
  emitter.emit('log', `Archive format auto-detected: ${format}`);
  return format;
}

/**
 * extract-zip, but refusing symlink entries. A zip can store a symlink (e.g. pointing at a folder
 * outside the target) and later entries can then be written *through* it — that's the known
 * extract-zip advisory. ROM archives never legitimately need symlinks, so any symlink entry
 * aborts the whole extraction. extract-zip itself already rejects plain "../" entry names.
 */
function safeExtractZip(zipPath, dir) {
  return extractZip(zipPath, {
    dir,
    onEntry(entry) {
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (mode === 0o120000) throw new Error(`Zip contains a symlink entry ("${entry.fileName}") — refusing to extract`);
    },
  });
}

async function extractIfNeeded(job, downloadResult, emitter) {
  const archiveFormat = resolveArchiveFormat(job, downloadResult, emitter);
  if (archiveFormat !== 'none' && archiveFormat !== 'zip') {
    throw new Error(
      `archiveFormat "${archiveFormat}" not implemented in this PoC (zip only). ` +
      `The Rust build uses sevenz-rust/unrar crates for .7z/.rar — see docs/ARCHITECTURE.md.`
    );
  }

  // Platform 'auto' has to be settled before we know which roms/<platform>/ folder to use, so a
  // zip is unpacked to a staging folder first and its contents inspected.
  let staged = null;
  if (archiveFormat === 'zip' && job.platform === 'auto') {
    staged = path.join(downloadResult.outDir, '_extracted');
    fs.mkdirSync(staged, { recursive: true });
    await safeExtractZip(pickZip(downloadResult), staged);
  }
  if (job.platform === 'auto') {
    const detected = detectPlatform(job, staged ? listFilesRecursive(staged) : downloadResult.files);
    job.platform = detected.platform;
    emitter.emit('log', detected.why
      ? `Platform not recognised (${detected.why}) - keeping it as "${UNKNOWN_PLATFORM}"; an admin can set the console in the Library.`
      : `Platform auto-detected: ${job.platform}`);
  }

  // platform may have just been auto-detected; both parts are re-checked before anything is written.
  assertSafePlatform(job.platform);
  const destDir = assertInside(ROMS_DIR, path.join(ROMS_DIR, job.platform, job.destSubfolder), 'install folder');
  fs.mkdirSync(destDir, { recursive: true });

  if (staged) {
    fs.cpSync(staged, destDir, { recursive: true });
    emitter.emit('log', `Extracted zip to ${destDir}`);
    return destDir;
  }

  if (archiveFormat === 'none') {
    for (const relPath of downloadResult.files) {
      const src = path.join(downloadResult.outDir, relPath);
      const dst = path.join(destDir, path.basename(relPath));
      fs.copyFileSync(src, dst);
    }
    return destDir;
  }

  await safeExtractZip(pickZip(downloadResult), destDir);
  emitter.emit('log', `Extracted zip to ${destDir}`);
  return destDir;
}

/**
 * Scans the raw downloaded payload (before extraction, so it covers what's
 * packed inside archives too) with the local ClamAV CLI. Missing `clamscan`
 * is a soft skip unless requireScan. See docs/POC.md for setup.
 */
function scanWithClamAV(targetPath, { skip, requireScan }, emitter) {
  return new Promise((resolve, reject) => {
    if (skip) {
      emitter.emit('log', 'ClamAV scan skipped.');
      resolve();
      return;
    }

    emitter.emit('log', `Running ClamAV scan on ${targetPath} ...`);
    const child = spawn('clamscan', ['-r', '--no-summary', targetPath]);
    let output = '';
    child.stdout.on('data', (d) => { output += d; });

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        const msg = 'clamscan not found on PATH (ClamAV not installed) — malware scan skipped.';
        if (requireScan) reject(new Error(`${msg} Install ClamAV or drop the require-scan option.`));
        else { emitter.emit('log', `WARNING: ${msg}`); resolve(); }
        return;
      }
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) { emitter.emit('log', 'ClamAV: no threats found.'); resolve(); }
      else if (code === 1) reject(new Error(`ClamAV detected a threat — aborting:\n${output}`));
      else {
        // 2 = scan error (e.g. signature DB not downloaded yet), null = killed (out of memory).
        // Not a detection, so don't block the download unless the caller demanded a scan.
        const msg = `clamscan did not complete (exit ${code}) — malware scan skipped.`;
        if (requireScan) reject(new Error(msg));
        else { emitter.emit('log', `WARNING: ${msg}`); resolve(); }
      }
    });
  });
}

function httpsGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }); }
        catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

/**
 * Looks up a file's SHA-256 against VirusTotal's database of known-malware
 * hashes. Only the hash is sent, never the file. Requires the user's own
 * free VT_API_KEY env var; silently skipped if it's not set.
 */
async function checkVirusTotal(hash, { skip }, emitter) {
  if (skip) { emitter.emit('log', 'VirusTotal check skipped.'); return; }

  const apiKey = process.env.VT_API_KEY;
  if (!apiKey) { emitter.emit('log', 'VT_API_KEY not set — skipping VirusTotal hash lookup.'); return; }

  emitter.emit('log', `Checking VirusTotal for hash ${hash} ...`);
  const { status, json } = await httpsGetJson(
    `https://www.virustotal.com/api/v3/files/${hash}`,
    { 'x-apikey': apiKey }
  );

  if (status === 404) {
    emitter.emit('log', 'VirusTotal: hash unknown to their database (not previously seen — not proof of safety).');
    return;
  }
  if (status !== 200) {
    emitter.emit('log', `VirusTotal lookup returned HTTP ${status}; continuing without a result.`);
    return;
  }

  const stats = json.data.attributes.last_analysis_stats;
  emitter.emit('log',
    `VirusTotal: malicious=${stats.malicious} suspicious=${stats.suspicious} ` +
    `harmless=${stats.harmless} undetected=${stats.undetected}`
  );
  if (stats.malicious > 0) {
    throw new Error(`VirusTotal: ${stats.malicious} engine(s) flagged this file as malicious — aborting.`);
  }
}

// Platform names/abbreviations found in titles. Order matters: more specific first (3ds before nds,
// gba/gbc before gb, snes before nes, psp before psx).
const PLATFORM_KEYWORDS = [
  ['3ds', /\b(3ds|nintendo 3ds)\b/i],
  ['nds', /\b(nds|ndsi|nintendo ds)\b/i],
  ['gba', /\b(gba|game ?boy advance)\b/i],
  ['gbc', /\b(gbc|game ?boy colou?r)\b/i],
  ['gb', /\b(gb|game ?boy)\b/i],
  ['n64', /\b(n64|nintendo 64)\b/i],
  ['snes', /\b(snes|super nes|super nintendo|sfc)\b/i],
  ['nes', /\b(nes|nintendo entertainment system|famicom)\b/i],
  ['gamecube', /\b(gamecube|gcn|ngc)\b/i],
  ['genesis', /\b(genesis|mega ?drive)\b/i],
  ['saturn', /\bsaturn\b/i],
  ['dreamcast', /\bdreamcast\b/i],
  ['psp', /\b(psp|playstation portable)\b/i],
  ['psx', /\b(psx|ps1|psone|playstation)\b/i],
  ['switch', /\b(nintendo switch|nsp|nro|xci)\b/i],
];

// Extensions that identify exactly one platform. Shared/ambiguous ones (.iso, .bin, .cue, .chd, .md, .exe) are left out.
const UNIQUE_EXTENSION_PLATFORM = {
  '.nes': 'nes', '.sfc': 'snes', '.smc': 'snes', '.gba': 'gba', '.gbc': 'gbc', '.gb': 'gb',
  '.nds': 'nds', '.3ds': '3ds', '.cia': '3ds', '.cci': '3ds',
  '.n64': 'n64', '.z64': 'n64', '.v64': 'n64',
  '.gcm': 'gamecube', '.rvz': 'gamecube', '.ciso': 'gamecube', '.gen': 'genesis',
  '.gdi': 'dreamcast', '.cdi': 'dreamcast', '.cso': 'psp',
  '.nro': 'switch', '.nsp': 'switch', '.xci': 'switch',
  '.wbfs': 'wii', '.xex': 'xbox360', '.pbp': 'psp', '.vpk': 'psvita',
  '.sms': 'sms', '.gg': 'gamegear', '.pce': 'pcengine', '.a26': 'atari2600', '.a78': 'atari7800', '.lnx': 'lynx', '.ws': 'wonderswan', '.wsc': 'wonderswan', '.ngp': 'neogeopocket', '.ngc': 'neogeopocket',
};

function guessPlatformFromText(text) {
  const hit = PLATFORM_KEYWORDS.find(([, re]) => re.test(text || ''));
  return hit ? hit[0] : null;
}

/** What detectPlatform returns when it can't decide. The game is KEPT (roms/unknown/<folder>/) and shown in the library
 *  with a generic tile; an admin can assign the real console later. Nothing is thrown away just because we can't name it. */
const UNKNOWN_PLATFORM = 'unknown';

/**
 * Platform for a job whose platform is 'auto': by file extensions first, then platform words in the title/file names.
 * Never throws: if nothing identifies it (or the files point at several consoles) the result is 'unknown' and `why` says so.
 */
function detectPlatform(job, fileNames) {
  const byExt = new Set(
    fileNames.map((f) => UNIQUE_EXTENSION_PLATFORM[path.extname(f).toLowerCase()]).filter(Boolean)
  );
  if (byExt.size === 1) return { platform: [...byExt][0], why: null };
  const guess = guessPlatformFromText(`${job.title || ''} ${job.destSubfolder} ${fileNames.join(' ')}`);
  if (guess) return { platform: guess, why: null };
  return {
    platform: UNKNOWN_PLATFORM,
    why: byExt.size > 1
      ? `the files match several consoles (${[...byExt].join(', ')})`
      : "no file extension or platform name in the title/file names identified it",
  };
}

// File extensions treated as "the ROM" per platform, for auto-detecting
// romFile when it isn't specified. dos/pc are deliberately excluded —
// .exe/.com aren't unique enough to a "game" to guess safely (a homebrew
// zip full of docs/utilities would false-positive constantly).
const ROM_EXTENSIONS = {
  nes: ['.nes'],
  snes: ['.sfc', '.smc'],
  gb: ['.gb'],
  gbc: ['.gbc'],
  gba: ['.gba'],
  nds: ['.nds'],
  '3ds': ['.3ds', '.cia', '.cci'],
  n64: ['.n64', '.z64', '.v64'],
  gamecube: ['.iso', '.gcm', '.rvz', '.ciso'],
  genesis: ['.md', '.gen', '.bin'],
  saturn: ['.iso', '.cue', '.chd'],
  dreamcast: ['.gdi', '.cdi', '.chd'],
  psx: ['.bin', '.cue', '.iso', '.chd'],
  psp: ['.iso', '.cso'],
  switch: ['.nro', '.nsp', '.xci'],
};

/** Every file under dir, as paths relative to dir (recurses into subfolders — extraction can nest, e.g. switch/Game/game.nro). */
function listFilesRecursive(dir, base = dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(listFilesRecursive(full, base));
    else results.push(path.relative(base, full));
  }
  return results;
}

/**
 * Auto-detects the ROM file by extension when romFile isn't given. Exactly
 * one match is required — zero or multiple candidates are both ambiguous
 * (e.g. a multi-disc dump, or an archive bundling extras) and mean the
 * caller needs to specify romFile explicitly instead of guessing wrong.
 */
function autoDetectRomFile(destDir, platform, emitter) {
  if (platform === UNKNOWN_PLATFORM) {
    // No extension rules for an unidentified console: the biggest file is the best guess at "the game".
    const files = listFilesRecursive(destDir)
      .map((f) => ({ f, size: fs.statSync(path.join(destDir, f)).size }))
      .sort((a, b) => b.size - a.size);
    if (!files.length) throw new Error(`Nothing was extracted into ${destDir}`);
    emitter.emit('log', `Unknown platform: using the largest file as the main one: ${files[0].f}`);
    return path.join(destDir, files[0].f);
  }
  const extensions = ROM_EXTENSIONS[platform];
  if (!extensions) {
    throw new Error(`No romFile given, and platform "${platform}" has no known ROM extension to auto-detect — specify romFile explicitly.`);
  }

  const candidates = listFilesRecursive(destDir)
    .filter((f) => extensions.includes(path.extname(f).toLowerCase()));

  if (candidates.length === 0) {
    throw new Error(`No romFile given, and no file matching ${extensions.join('/')} was found under ${destDir} — specify romFile explicitly.`);
  }
  if (candidates.length > 1) {
    throw new Error(`No romFile given, and multiple possible matches were found (${candidates.join(', ')}) — specify romFile to disambiguate.`);
  }

  emitter.emit('log', `Auto-detected ROM file by extension: ${candidates[0]}`);
  return path.join(destDir, candidates[0]);
}

/**
 * Torrent file names and catalog.json's romFile entry aren't guaranteed to
 * agree on case. Windows/macOS hide this by being case-insensitive; Linux
 * won't. Fall back to a case-insensitive match in destDir before failing.
 * romFile itself is optional — pass null/undefined to auto-detect by
 * platform's known extension instead (see ROM_EXTENSIONS).
 */
function resolveRomPath(destDir, romFile, platform, emitter) {
  if (!romFile) return autoDetectRomFile(destDir, platform, emitter);

  // romFile can come from a feed and may be a relative path into subfolders — allowed, but it
  // must still land inside this game's own folder.
  const exact = assertInside(destDir, path.join(destDir, romFile), 'romFile');
  if (fs.existsSync(exact)) return exact;

  if (!romFile.includes('/') && !romFile.includes('\\')) {
    const lower = romFile.toLowerCase();
    const match = fs.readdirSync(destDir).find((f) => f.toLowerCase() === lower);
    if (match) return path.join(destDir, match);
  }

  throw new Error(`Expected rom file not found after extraction: ${exact}`);
}

function verifyHash(job, romPath, emitter) {
  if (!job.verification) return true;
  const { algorithm, hash } = job.verification;
  if (algorithm === 'crc32') {
    emitter.emit('log', 'crc32 verification not implemented in this PoC; skipping.');
    return true;
  }
  const data = fs.readFileSync(romPath);
  const actual = crypto.createHash(algorithm).update(data).digest('hex');
  const ok = actual.toLowerCase() === hash.toLowerCase();
  emitter.emit('log', `Verification (${algorithm}): expected=${hash} actual=${actual} -> ${ok ? 'OK' : 'MISMATCH'}`);
  if (!ok) throw new Error('Hash verification failed; refusing to launch.');
  return true;
}

/** Resolves once the emulator exits (or immediately, for dry-run/no-emulator). */
function launchEmulator(job, romPath, shouldLaunch, emitter) {
  if (!job.emulator) {
    emitter.emit('log', 'No emulator configured for this platform; skipping launch step.');
    return Promise.resolve();
  }
  const args = job.emulator.argsTemplate
    .map((a) => (a === '{romPath}' ? romPath : a))
    .concat(job.extraArgs || []);
  const exe = job.emulator.executable === '{romPath}' ? romPath : job.emulator.executable;

  emitter.emit('log', `Resolved launch command: ${exe} ${args.join(' ')}`);

  if (!shouldLaunch) {
    emitter.emit('log', '(dry run — launch not requested)');
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: 'inherit' });
    child.on('error', (err) => {
      emitter.emit('log', `Failed to launch emulator: ${err.message}`);
      resolve();
    });
    child.on('close', () => resolve());
  });
}

/**
 * Runs the full pipeline for one job. Emits 'log' and 'progress' (0-1)
 * events on `emitter` throughout — callers decide how to display or store
 * them. Returns { romPath, destDir } on success.
 */
async function runJob(job, opts, emitter) {
  const { skipScan, requireScan, noVt, launch } = opts || {};

  const downloadResult = await fetchPayload(job, emitter);
  await scanWithClamAV(downloadResult.outDir, { skip: skipScan, requireScan }, emitter);

  const destDir = await extractIfNeeded(job, downloadResult, emitter);
  const romPath = resolveRomPath(destDir, job.romFile, job.platform, emitter);

  verifyHash(job, romPath, emitter);

  const romHash = crypto.createHash('sha256').update(fs.readFileSync(romPath)).digest('hex');
  await checkVirusTotal(romHash, { skip: noVt }, emitter);

  await launchEmulator(job, romPath, !!launch, emitter);

  return { romPath, destDir, platform: job.platform };
}

module.exports = {
  ROOT, DOWNLOADS_DIR, ROMS_DIR, CATALOG_PATH, EMULATORS_PATH,
  loadJson, loadCatalog, loadEmulators,
  globToRegExp,
  buildJobFromGameId, buildJobFromParams,
  assertFetchAllowed, guardedLookup, assertSafeName,
  downloadTorrent, downloadDirect, fetchPayload, extractIfNeeded, scanWithClamAV, checkVirusTotal,
  resolveRomPath, verifyHash, launchEmulator,
  guessPlatformFromText, detectPlatform, UNKNOWN_PLATFORM, PLATFORM_KEYWORDS, ROM_EXTENSIONS, FILE_TYPE_EXTENSIONS,
  runJob,
};
