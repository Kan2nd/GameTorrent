/**
 * Guesses which console a search result is for BEFORE anything is
 * downloaded, so the browse/search UI can show "NDS", "GBA", "Switch"...
 * next to each torrent. Purely informational: the download itself still
 * settles the real platform from the downloaded files (see pipeline.js
 * detectPlatform), which is more reliable than anything a title can say.
 *
 * Signals, strongest first:
 *   1. category  — the indexer's own category text from Jackett
 *                  (e.g. "Console/NDS"). The Torznab spec only standardises
 *                  a few console ids (1010 NDS, 1020 PSP), so we mostly read
 *                  the text.
 *   2. title     — an explicit platform word: GBA, NDS, "Game Boy Advance",
 *                  NSP/XCI... (bare "DS"/"Switch" count, but as a guess).
 *   3. game      — a well-known game name that only exists on one console
 *                  ("Pokemon Platinum" -> NDS). This is what makes ROM
 *                  hacks classifiable, since hack titles rarely say the
 *                  console. Guess-level confidence.
 *
 * Also flags ROM hacks and likely bare patch files (.ips/.bps/.ups), which
 * are not playable until applied to a clean base ROM.
 */

'use strict';

const pipeline = require('../../poc/pipeline');

// Consoles we can recognise but GameTorrent can't sort/launch (no emulator config, no
// ROM-extension rules) — flagged in the UI instead of silently downloading gigabytes.
const UNSUPPORTED_PLATFORMS = ['wii', 'wiiu', 'xbox', 'xbox360', 'ps2', 'ps3', 'ps4', 'psvita'];

const EXTRA_KEYWORDS = [
  ['wiiu', /\bwii ?u\b/i],
  ['wii', /\b(wii|wiiware)\b/i],
  ['xbox360', /\b(xbox ?360|x360)\b/i],
  ['xbox', /\bxbox\b/i],
  ['ps4', /\b(ps4|playstation 4)\b/i],
  ['ps3', /\b(ps3|playstation 3)\b/i],
  ['ps2', /\b(ps2|playstation 2)\b/i],
  ['psvita', /\b(ps ?vita|psv)\b/i],
  ['switch', /\bswitch\b/i],   // bare "switch"; NSP/XCI/NRO are already in pipeline's list
];

// When a more specific name matched, drop the generic one it contains ("Game Boy Advance" also matches "Game Boy").
const SUPERSEDES = {
  gba: ['gb', 'gbc'], gbc: ['gb'], '3ds': ['nds'], snes: ['nes'],
  psp: ['psx'], ps2: ['psx'], ps3: ['psx'], ps4: ['psx'], psvita: ['psx', 'psp'],
  wiiu: ['wii'], xbox360: ['xbox'],
};

// A bare "Switch" is only a guess (it's also an ordinary word); these are explicit.
const EXPLICIT_SWITCH = /\b(nintendo switch|nsp|nro|xci)\b/i;
const BARE_DS = /\bds\b/i;
const FILE_SIZE = /\b\d+(?:[.,]\d+)?\s?(?:gb|mb|kb|tb)\b/gi;   // "1.5 GB" must not read as Game Boy

const CATEGORY_KEYWORDS = [
  ['3ds', /\b3ds\b/i],
  ['nds', /\b(nds|nintendo ds)\b/i],
  ['gba', /\b(gba|game ?boy advance)\b/i],
  ['gbc', /\b(gbc|game ?boy colou?r)\b/i],
  ['switch', /\bswitch\b/i],
  ['wiiu', /\bwii ?u\b/i],
  ['wii', /\bwii/i],
  ['psp', /\bpsp\b/i],
  ['psvita', /\bvita\b/i],
  ['xbox360', /\bxbox ?360\b/i],
  ['xbox', /\bxbox\b/i],
  ['ps4', /\bps4\b/i],
  ['ps3', /\bps3\b/i],
  ['ps2', /\bps2\b/i],
  ['psx', /\b(psx|ps1|playstation)\b/i],
  ['n64', /\bn64\b|nintendo 64/i],
  ['snes', /\bsnes\b|super nintendo/i],
  ['nes', /\bnes\b/i],
  ['genesis', /genesis|mega ?drive/i],
  ['gamecube', /gamecube/i],
  ['dreamcast', /dreamcast/i],
  ['saturn', /saturn/i],
];
// Only the ids the Torznab spec defines for consoles we can name.
const CATEGORY_IDS = { 1010: 'nds', 1020: 'psp' };

// Game-name clues. Extend freely — order doesn't matter for generic entries (a disagreement
// between them yields "unknown"), but named hacks (no `needs`) win outright. `needs` is a
// context word that must also appear so generic words ("red", "platinum", "sun") don't fire alone.
const POKEMON = /pok[eé]mon|pocket monsters/i;
const GAME_HINTS = [
  // famous hacks whose names don't contain their base game
  { re: /\bradical red\b/i, platform: 'gba', why: 'Radical Red (a FireRed hack)' },
  { re: /\bash gray\b/i, platform: 'gba', why: 'Ash Gray (a FireRed hack)' },
  { re: /\bpok[eé]mon unbound\b/i, platform: 'gba', why: 'Unbound (a FireRed hack)' },
  { re: /\blight platinum\b/i, platform: 'gba', why: 'Light Platinum (a FireRed hack)' },
  { re: /\bemerald seaglass\b/i, platform: 'gba', why: 'Emerald Seaglass (an Emerald hack)' },
  // base games
  // specific multi-word titles: these win over the generic words below ("Brilliant Diamond" is not the DS "Diamond")
  { re: /\b(brilliant diamond|shining pearl|legends:? arceus|let'?s go)\b/i, needs: POKEMON, specific: true, platform: 'switch', why: 'a Switch-era Pokémon game' },
  { re: /\b(omega ruby|alpha sapphire|ultra sun|ultra moon)\b/i, needs: POKEMON, specific: true, platform: '3ds', why: 'a 3DS-era Pokémon game' },
  { re: /\b(scarlet|violet|sword|shield)\b/i, needs: POKEMON, platform: 'switch', why: 'a Switch-era Pokémon game' },
  { re: /\b(sun|moon)\b/i, needs: POKEMON, platform: '3ds', why: 'a 3DS-era Pokémon game' },
  { re: /\b(heart ?gold|soul ?silver|diamond|pearl|platinum|black ?2|white ?2|black|white)\b/i, needs: POKEMON, platform: 'nds', why: 'a DS-era Pokémon game' },
  { re: /\b(fire ?red|leaf ?green|emerald|ruby|sapphire)\b/i, needs: POKEMON, platform: 'gba', why: 'a GBA-era Pokémon game' },
  { re: /\b(gold|silver|crystal)\b/i, needs: POKEMON, platform: 'gbc', why: 'a Game Boy Color-era Pokémon game' },
  { re: /\b(red|blue|yellow)\b/i, needs: POKEMON, platform: 'gb', why: 'a Game Boy-era Pokémon game' },
];

const HACK_RE = /\b(rom ?hacks?|hacks?|hacked|kaizo|randomi[sz]er|randomi[sz]ed|romhack)\b/i;
const PATCH_RE = /\b(ips|ups|bps|xdelta|patch(?:es)?)\b/i;
const PREPATCHED_RE = /\b(pre-?patched|patched rom|full rom|complete rom|ready to play)\b/i;

let supportedCache = null;
function supportedPlatforms() {
  if (!supportedCache) supportedCache = new Set([...Object.keys(pipeline.ROM_EXTENSIONS), ...Object.keys(pipeline.loadEmulators())]);
  return supportedCache;
}

function fromCategory(categoryDesc, categoryIds) {
  const text = String(categoryDesc || '');
  if (text) {
    const hit = CATEGORY_KEYWORDS.find(([, re]) => re.test(text));
    if (hit) return hit[0];
  }
  for (const id of categoryIds || []) if (CATEGORY_IDS[id]) return CATEGORY_IDS[id];
  return null;
}

/** All distinct platforms named in a title, after dropping generic names a specific one contains. */
function platformsInTitle(title) {
  const hits = new Set();
  for (const [key, re] of [...pipeline.PLATFORM_KEYWORDS, ...EXTRA_KEYWORDS]) if (re.test(title)) hits.add(key);
  for (const specific of [...hits]) for (const generic of SUPERSEDES[specific] || []) hits.delete(generic);
  return [...hits];
}

/**
 * Named hacks (no `needs`) and specific multi-word titles are authoritative. Generic base-game words are only trusted if every
 * one that matched points at the same console — "Emerald Black Edition" hits both a GBA and a DS
 * clue, and a wrong badge is worse than "Unknown".
 */
function fromGameName(title) {
  const named = GAME_HINTS.find((h) => !h.needs && h.re.test(title));
  if (named) return named;
  const specific = GAME_HINTS.find((h) => h.specific && h.needs.test(title) && h.re.test(title));
  if (specific) return specific;
  const generic = GAME_HINTS.filter((h) => h.needs && h.needs.test(title) && h.re.test(title));
  const platforms = new Set(generic.map((h) => h.platform));
  return platforms.size === 1 ? generic[0] : null;
}

/**
 * @param {{title: string, categoryDesc?: string, categoryIds?: number[]}} r
 * @returns {{platform: string|null, confidence: 'high'|'guess'|null, source: string|null, why: string|null,
 *            candidates: string[], supported: boolean|null, hack: boolean, patchLikely: boolean}}
 */
function detectResult({ title, categoryDesc, categoryIds }) {
  const t = String(title || '').replace(FILE_SIZE, ' ');
  const hack = HACK_RE.test(t);
  const patchLikely = PATCH_RE.test(t) && !PREPATCHED_RE.test(t);
  const base = { platform: null, confidence: null, source: null, why: null, candidates: [], supported: null, hack, patchLikely };

  const done = (platform, confidence, source, why) => ({
    ...base, platform, confidence, source, why,
    supported: UNSUPPORTED_PLATFORMS.includes(platform) ? false : supportedPlatforms().has(platform),
  });

  const cat = fromCategory(categoryDesc, categoryIds);
  if (cat) return done(cat, 'high', 'category', `the indexer files it under "${categoryDesc || cat}"`);

  const named = platformsInTitle(t);
  if (named.length === 1) {
    const weak = named[0] === 'switch' && !EXPLICIT_SWITCH.test(t);
    return done(named[0], weak ? 'guess' : 'high', 'title', weak ? 'the title says "Switch"' : 'the title names the console');
  }
  if (named.length > 1) return { ...base, candidates: named };

  if (BARE_DS.test(t)) return done('nds', 'guess', 'title', 'the title says "DS"');

  const game = fromGameName(t);
  if (game) return done(game.platform, 'guess', 'game', `the title looks like ${game.why}`);

  return base;
}

module.exports = { detectResult, UNSUPPORTED_PLATFORMS };
