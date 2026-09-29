/**
 * Cover-art lookup for game cards. Two sources, tried in order:
 *
 *  1. libretro-thumbnails (https://thumbnails.libretro.com) — the public
 *     box-art library RetroArch itself uses. No API key. Each system has a
 *     directory index of "Named_Boxarts"; we download that index once,
 *     cache it on disk, and fuzzy-match the (messy) torrent title against
 *     the real box-art file names. Needs to know the platform: the
 *     Installed cards pass it, browse/search cards guess it from the title.
 *  2. RAWG (https://rawg.io) — only if RAWG_API_KEY is set. Mainstream-
 *     skewed and looser matching, so it is the fallback, not the default.
 *
 * Everything here is best-effort and purely cosmetic: any failure resolves
 * to null and the card shows its generated tile instead.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const INDEX_CACHE_PATH = path.join(DATA_DIR, 'libretro-index.json');
const CDN = 'https://thumbnails.libretro.com';
const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // box art rarely changes
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;  // don't hammer the CDN if it's down

// GameTorrent platform key -> libretro-thumbnails system directory.
const LIBRETRO_SYSTEMS = {
  nes: 'Nintendo - Nintendo Entertainment System',
  snes: 'Nintendo - Super Nintendo Entertainment System',
  gb: 'Nintendo - Game Boy',
  gbc: 'Nintendo - Game Boy Color',
  gba: 'Nintendo - Game Boy Advance',
  nds: 'Nintendo - Nintendo DS',
  '3ds': 'Nintendo - Nintendo 3DS',
  n64: 'Nintendo - Nintendo 64',
  gamecube: 'Nintendo - GameCube',
  genesis: 'Sega - Mega Drive - Genesis',
  saturn: 'Sega - Saturn',
  dreamcast: 'Sega - Dreamcast',
  psx: 'Sony - PlayStation',
  psp: 'Sony - PlayStation Portable',
};

// Order matters: the more specific names must be tested before the
// generic ones they contain (3DS before DS, GBA/GBC before GB, SNES before NES).
const PLATFORM_HINTS = [
  ['3ds', /\b3ds\b/i],
  ['nds', /\b(nds|nintendo ds)\b/i],
  ['gbc', /\b(gbc|game ?boy color)\b/i],
  ['gba', /\b(gba|game ?boy advance)\b/i],
  ['gb', /\b(gb|game ?boy)\b/i],
  ['snes', /\b(snes|super nintendo|super famicom)\b/i],
  ['nes', /\bnes\b/i],
  ['n64', /\b(n64|nintendo 64)\b/i],
  ['gamecube', /\b(gamecube|gcn|ngc)\b/i],
  ['genesis', /\b(genesis|mega ?drive)\b/i],
  ['saturn', /\bsaturn\b/i],
  ['dreamcast', /\bdreamcast\b/i],
  ['psp', /\bpsp\b/i],
  ['psx', /\b(psx|ps1|playstation)\b/i],
];

function guessPlatform(title) {
  const t = String(title || '');
  for (const [key, re] of PLATFORM_HINTS) if (re.test(t)) return key;
  return null;
}

// Words that carry no identity for matching: articles, region/format noise,
// and platform names (already handled by choosing the right system index).
const STOP = new Set([
  'the', 'of', 'and', 'a', 'an', 'in', 'on', 'to', 'for', 'version', 'edition', 'rom', 'roms', 'game', 'games',
  'usa', 'eur', 'europe', 'japan', 'jpn', 'world', 'rev', 'proper', 'repack', 'multi', 'en', 'fr', 'de', 'es', 'it',
  'nds', 'ds', 'gba', 'gbc', 'gb', 'nes', 'snes', 'n64', 'psx', 'ps1', 'psp', '3ds', 'nintendo', 'sega', 'sony',
  'playstation', 'genesis', 'saturn', 'dreamcast', 'gamecube',
]);

function tokens(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')          // drop [tags] and (regions)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && (t.length > 1 || /\d/.test(t)) && !STOP.has(t));
}

// --- libretro index (memory + disk cache) ---

const indexMemo = new Map(); // platform -> Promise<{ names, entries } | null>
let diskCache = null;        // { [platform]: { fetchedAt, names } }

function loadDiskCache() {
  if (diskCache) return diskCache;
  try { diskCache = JSON.parse(fs.readFileSync(INDEX_CACHE_PATH, 'utf8')); } catch { diskCache = {}; }
  return diskCache;
}

function saveDiskCache() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(INDEX_CACHE_PATH, JSON.stringify(diskCache));
  } catch { /* cache is an optimisation only */ }
}

function fetchText(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timed out')));
  });
}

function parseIndex(html) {
  const names = [];
  for (const m of html.matchAll(/href="([^"]+)\.png"/g)) {
    let name = m[1].replace(/&amp;/g, '&');
    try { name = decodeURIComponent(name); } catch { /* keep as-is */ }
    names.push(name);
  }
  return names;
}

function buildIndex(names) {
  return { names, entries: names.map((name) => ({ name, tokens: new Set(tokens(name)) })) };
}

function getIndex(platform) {
  if (indexMemo.has(platform)) return indexMemo.get(platform);

  const promise = (async () => {
    const cache = loadDiskCache();
    const cached = cache[platform];
    if (cached && cached.names && Date.now() - cached.fetchedAt < INDEX_TTL_MS) return buildIndex(cached.names);

    try {
      const url = `${CDN}/${encodeURIComponent(LIBRETRO_SYSTEMS[platform])}/Named_Boxarts/`;
      const names = parseIndex(await fetchText(url, 30000));
      if (!names.length) throw new Error('empty index');
      cache[platform] = { fetchedAt: Date.now(), names };
      saveDiskCache();
      return buildIndex(names);
    } catch {
      if (cached && cached.names) return buildIndex(cached.names); // stale beats nothing
      // Let a later request retry, but not immediately.
      setTimeout(() => indexMemo.delete(platform), RETRY_AFTER_FAILURE_MS).unref();
      return null;
    }
  })();

  indexMemo.set(platform, promise);
  return promise;
}

/** Which release region the title is asking for; anything unspecified means USA. */
function wantedRegion(title) {
  const t = String(title || '');
  if (/\b(eur|europe|pal)\b/i.test(t)) return 'europe';
  if (/\b(jpn|japan|jap)\b/i.test(t)) return 'japan';
  return 'usa';
}

/**
 * How many of the query's words appear in a file's word set. Two adjacent
 * query words also count if the file spells them as one ("fire" + "red" vs
 * "FireRed") — libretro's names are No-Intro names, which do this a lot.
 */
function countHits(qList, fileTokens) {
  const matched = new Array(qList.length).fill(false);
  for (let i = 0; i < qList.length; i++) {
    if (fileTokens.has(qList[i])) matched[i] = true;
    else if (i + 1 < qList.length && fileTokens.has(qList[i] + qList[i + 1])) { matched[i] = true; matched[i + 1] = true; }
  }
  return matched.filter(Boolean).length;
}

/** Best box-art name for a title, or null. Requires most of the title's words to be present. */
function bestMatch(title, entries) {
  const qList = [...new Set(tokens(title))];
  if (!qList.length) return null;
  const region = wantedRegion(title);
  let best = null;
  let bestScore = -1;
  for (const e of entries) {
    const hit = countHits(qList, e.tokens);
    if (hit / qList.length < 0.75) continue;                     // most query words must match
    let score = hit / Math.max(qList.length, e.tokens.size);     // ...and the file shouldn't add many extras

    const tags = (e.name.match(/\([^)]*\)/g) || []).join(' ').toLowerCase();
    if (/\b(demo|kiosk|beta|proto|sample|unl|aftermarket|pirate|promo)\b/.test(tags)) score -= 0.3;
    if (tags.includes(region)) score += 0.06;                    // the release the title asked for (default USA)
    else if (/\b(world|usa)\b/.test(tags)) score += 0.03;
    if (/virtual console|switch online|rev \d/.test(tags)) score -= 0.01; // prefer the plain original

    if (score > bestScore) { bestScore = score; best = e; }
  }
  const needed = qList.length < 2 ? 0.9 : 0.5;                   // a one-word title must be an (almost) exact name
  return best && bestScore >= needed ? best : null;
}

async function libretroLookup(title, platform) {
  if (!LIBRETRO_SYSTEMS[platform]) return undefined;
  const index = await getIndex(platform);
  if (!index) return undefined;                              // undefined = "couldn't check", null = "no match"
  const match = bestMatch(title, index.entries);
  if (!match) return null;
  return `${CDN}/${encodeURIComponent(LIBRETRO_SYSTEMS[platform])}/Named_Boxarts/${encodeURIComponent(match.name)}.png`;
}

// --- RAWG (optional fallback, needs RAWG_API_KEY) ---

const rawgCache = new Map();

/** Strips common torrent-release noise so the leftover reads like a game title. */
function cleanTitleForRawg(rawTitle) {
  return String(rawTitle || '')
    .replace(/[._]+/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(NES|SNES|GBA|GBC|GB|N64|Genesis|PSX|PS1|PS2|DOS|PC|Switch|NSP|XCI|NRO|Homebrew|ROM|USA|EUR|EUROPE|JPN|JAPAN|World|Region ?Free|REPACK|PROPER)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function rawgLookup(title) {
  return new Promise((resolve) => {
    const apiKey = process.env.RAWG_API_KEY;
    if (!apiKey) { resolve(null); return; }

    const cleaned = cleanTitleForRawg(title);
    if (!cleaned) { resolve(null); return; }
    const cacheKey = cleaned.toLowerCase();
    if (rawgCache.has(cacheKey)) { resolve(rawgCache.get(cacheKey)); return; }

    const url = `https://api.rawg.io/api/games?key=${encodeURIComponent(apiKey)}&search=${encodeURIComponent(cleaned)}&page_size=1`;
    https.get(url, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        let image = null;
        try {
          const data = JSON.parse(body);
          image = (data.results && data.results[0] && data.results[0].background_image) || null;
        } catch { /* leave null — cosmetic feature */ }
        rawgCache.set(cacheKey, image);
        resolve(image);
      });
    }).on('error', () => { rawgCache.set(cacheKey, null); resolve(null); })
      .on('timeout', function () { this.destroy(); rawgCache.set(cacheKey, null); resolve(null); });
  });
}

// --- public entry point ---

const coverMemo = new Map(); // "platform|title" -> url | null

async function lookupCoverUncapped(title, platform) {
  const plat = platform || guessPlatform(title);
  const key = `${plat || '?'}|${String(title || '').toLowerCase()}`;
  if (coverMemo.has(key)) return coverMemo.get(key);

  let url = null;
  let definitive = true;
  if (plat) {
    const r = await libretroLookup(title, plat);
    if (r) url = r;
    else if (r === undefined && LIBRETRO_SYSTEMS[plat]) definitive = false; // index unreachable: don't remember a miss
  }
  if (!url) url = await rawgLookup(title);

  if (url || definitive) coverMemo.set(key, url);
  return url;
}

/**
 * @param {string} title       torrent/folder title (messy is fine)
 * @param {string} [platform]  GameTorrent platform key if known; otherwise guessed from the title
 * @param {number} [timeoutMs] give up waiting after this long and resolve null. The lookup itself keeps
 *                             running and is remembered, so the *next* request gets the answer instantly —
 *                             the first request after a cold start never blocks a page on a CDN download.
 * @returns {Promise<string|null>} image URL, or null if none found (yet)
 */
function lookupCover(title, platform, timeoutMs = 5000) {
  return Promise.race([
    lookupCoverUncapped(title, platform),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs).unref()),
  ]);
}

/** Start downloading/loading the box-art indexes for these platforms in the background (fire and forget). */
function warm(platforms) {
  for (const p of platforms || []) if (LIBRETRO_SYSTEMS[p]) getIndex(p);
}

module.exports = { lookupCover, warm, guessPlatform, tokens, bestMatch, LIBRETRO_SYSTEMS };
