/**
 * "Looking for" choices on the Search tab: what KIND of thing to look for together with the game's name.
 * Pick any (they combine with OR): consoles (NDS, GBA, ...) and file kinds (video, audio, disc images...).
 *
 * A pick does two things (see providers.smartSearch):
 *   1. it adds one extra query per pick ("pokemon platinum nds"), because an indexer only returns titles that
 *      contain the words it was given, and most titles name the console or the format;
 *   2. it narrows the merged results to the ones that really are that kind: a console pick keeps results whose
 *      detected console (lib/platformDetect.js) is that console; a file pick keeps results whose title, or whose
 *      indexer category, mentions the format.
 */

'use strict';

// Consoles GameTorrent can sort and launch. `term` is the word an indexer's titles most often use for it.
const CONSOLES = [
  ['nes', 'NES', 'nes'], ['snes', 'SNES', 'snes'], ['n64', 'Nintendo 64', 'n64'], ['gamecube', 'GameCube', 'gamecube'],
  ['gb', 'Game Boy', 'game boy'], ['gbc', 'Game Boy Color', 'gbc'], ['gba', 'Game Boy Advance', 'gba'],
  ['nds', 'Nintendo DS', 'nds'], ['3ds', 'Nintendo 3DS', '3ds'], ['switch', 'Nintendo Switch', 'switch'],
  ['genesis', 'Sega Genesis', 'genesis'], ['saturn', 'Sega Saturn', 'saturn'], ['dreamcast', 'Sega Dreamcast', 'dreamcast'],
  ['psx', 'PlayStation', 'ps1'], ['psp', 'PSP', 'psp'],
];

const FILE_KINDS = [
  ['video', 'Video (mp4, mkv...)', 'mp4', /\b(mp4|mkv|avi|webm|mov|m4v|video|videos|movie|gameplay|walkthrough)\b/i, /video|movie|tv|anime/i],
  ['audio', 'Audio (mp3, flac, soundtrack)', 'soundtrack', /\b(mp3|flac|ogg|wav|aac|ost|soundtrack|audio)\b/i, /audio|music/i],
  ['disc', 'Disc image (iso, bin/cue, chd)', 'iso', /\b(iso|bin|cue|chd|cso|rvz|gdi|cdi|disc)\b/i, null],
  ['archive', 'Archive (zip, 7z, rar)', 'zip', /\b(zip|7z|7-?zip|rar)\b/i, null],
  ['patch', 'Patch / ROM hack (ips, bps, ups)', 'patch', /\b(ips|bps|ups|xdelta|patch(?:es)?|rom ?hacks?)\b/i, null],
];

const KINDS = new Map();
for (const [id, label, term] of CONSOLES) KINDS.set(id, { id, label, term, group: 'console', platform: id });
for (const [id, label, term, re, category] of FILE_KINDS) KINDS.set(id, { id, label, term, group: 'file', re, category });

const MAX_KINDS = 6;

/** What the page needs to draw the choices. */
function listKinds() {
  return [...KINDS.values()].map(({ id, label, group }) => ({ id, label, group }));
}

/** "nds,gba,video" -> known kinds only, no duplicates, capped. Anything unknown is ignored. */
function parseKinds(value) {
  const ids = String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set(ids)].filter((id) => KINDS.has(id)).slice(0, MAX_KINDS).map((id) => KINDS.get(id));
}

function matchesKind(kind, result) {
  if (kind.group === 'console') return !!(result.detect && result.detect.platform === kind.platform);
  return kind.re.test(String(result.title || '')) || !!(kind.category && kind.category.test(String(result.category || '')));
}

/** True if the result is any one of the picked kinds (no picks = everything passes). */
function matchesAny(kinds, result) {
  return !kinds.length || kinds.some((k) => matchesKind(k, result));
}

module.exports = { listKinds, parseKinds, matchesKind, matchesAny, MAX_KINDS };
