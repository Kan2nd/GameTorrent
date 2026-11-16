'use strict';
/**
 * Typo-tolerant search: the matcher (webui/public/fuzzy.js, shared with the browser) and the widening
 * logic around an indexer (providers.smartSearch). Needs no database and no network: the indexer is a
 * fake that, like most real ones, only matches whole words.
 */
const path = require('path');
const Fuzzy = require(path.join(__dirname, '..', '..', 'webui', 'public', 'fuzzy.js'));
const { smartSearch } = require(path.join(__dirname, '..', '..', 'webui', 'lib', 'providers.js'));

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` (${detail})`}`);
}
const hit = (q, t) => Fuzzy.score(q, t) > 0;

(async () => {
  // --- the matcher ---
  check('exact title', hit('Mario Kart DS', 'Mario Kart DS'));
  check('case, accents and punctuation do not matter', hit('pokemon emerald', 'POKÉMON - Emerald (USA, Europe) [GBA]'));
  check('missing plural "s" (legend -> Legends)', hit('legend of zelda', 'The Legends of Zelda'));
  check('extra "s" (zeldas -> Zelda)', hit('legend of zeldas', 'Legend of Zelda'));
  check('possessive', hit('zeldas adventure', "Zelda's Adventure"));
  check('a prefix', hit('poke', 'Pokemon Platinum'));
  check('one missing letter', hit('pokemon emerad', 'Pokemon Emerald'));
  check('one wrong letter', hit('mario cart', 'Mario Kart DS'));
  check('two swapped letters', hit('pokemno', 'Pokemon'));
  check('"&" and "and"', hit('sonic & knuckles', 'Sonic and Knuckles'));
  check('an unrelated title does not match', !hit('zelda', 'Mario Kart DS'));
  check('a short word gets no typo allowance ("gba" is not "gbc")', !hit('gba', 'Game Boy Color gbc'));
  check('a different number is a different game', !hit('donkey kong country 2', 'Donkey Kong Country 3'));
  check('the right number matches', hit('donkey kong country 2', 'Donkey Kong Country 2'));
  check('every word must match', !hit('pokemon zelda', 'Pokemon Emerald'));
  check('a long query may miss one word', hit('super mario bros deluxe edition', 'Super Mario Bros Deluxe'));
  check('rank puts the closest first', Fuzzy.rank(['Pokemon Platinum', 'Pokemon'], 'pokemon', (x) => x)[0] === 'Pokemon');
  check('an empty query keeps everything', Fuzzy.rank(['a', 'b'], '  ', (x) => x).length === 2);

  // --- widening a thin search ---
  const DB = ['The Legend of Zelda Minish Cap GBA', 'Legends of Zelda Collection', 'Pokemon Emerald GBA', 'Pokemon Platinum NDS', 'Mario Kart DS', 'Zelda Twilight Princess'];
  const calls = [];
  const run = async (q) => {
    calls.push(q);
    const words = Fuzzy.tokens(q);
    return {
      warnings: [],
      results: DB.filter((t) => words.every((w) => Fuzzy.normalize(t).split(' ').includes(w)))
        .map((t) => ({ title: t, magnetUri: `magnet:?${t}`, seeders: 3, providerId: 'p', size: 1 })),
    };
  };
  let r = await smartSearch('pokemon emerald', run);
  check('an exact search finds its game', r.results.length >= 1 && /Emerald/.test(r.results[0].title));
  const many = async (q) => { calls.push(q); return { warnings: [], results: Array.from({ length: 6 }, (_, i) => ({ title: `Pokemon Version ${i}`, magnetUri: `m${i}`, providerId: 'p' })) }; };
  calls.length = 0;
  r = await smartSearch('pokemon version', many);
  check('a search with plenty of close matches is not widened', r.expandedFrom.length === 0 && calls.length === 1 && r.results.length === 6);
  calls.length = 0;
  r = await smartSearch('legend of zeldas', run);
  check('"legend of zeldas" finds the Zelda games the indexer could not match', r.results.some((x) => /Minish/.test(x.title)) && r.results.some((x) => /Collection/.test(x.title)), JSON.stringify(r.results.map((x) => x.title)));
  check('...and not unrelated ones that a broad query returned', !r.results.some((x) => /Mario|Pokemon/.test(x.title)));
  check('...and says it widened', r.expandedFrom.length > 0);
  r = await smartSearch('pokemon emerad', run);
  check('a typo ("emerad") still finds Pokemon Emerald, first', r.results[0] && /Emerald/.test(r.results[0].title), JSON.stringify(r.results.map((x) => x.title)));
  check('every result carries a match score', r.results.every((x) => typeof x.match === 'number'));
  const dup = await smartSearch('zelda', async () => ({ warnings: [], results: [{ title: 'Zelda', magnetUri: 'm1', providerId: 'p' }, { title: 'Zelda', magnetUri: 'm1', providerId: 'p' }] }));
  check('duplicates are merged', dup.results.length === 1);
  const down = await smartSearch('zelda', async () => ({ warnings: ['Jackett: down'], results: [] }));
  check('provider warnings are passed through', down.warnings.length === 1 && down.results.length === 0);

  // --- "looking for" picks ---
  const { parseKinds, listKinds } = require(path.join(__dirname, '..', '..', 'webui', 'lib', 'searchKinds.js'));
  check('picks: unknown ids are dropped, duplicates merged, case ignored', parseKinds('nds, GBA ,bogus,nds').map((k) => k.id).join() === 'nds,gba');
  check('picks: the page can list consoles and file kinds', listKinds().some((k) => k.id === 'nds' && k.group === 'console') && listKinds().some((k) => k.id === 'video' && k.group === 'file'));
  const ran = [];
  const mixed = async (q) => {
    ran.push(q);
    const all = [
      { title: 'Pokemon Platinum NDS', detect: { platform: 'nds' }, magnetUri: 'a', providerId: 'p', seeders: 5 },
      { title: 'Pokemon Emerald GBA', detect: { platform: 'gba' }, magnetUri: 'b', providerId: 'p', seeders: 9 },
      { title: 'Pokemon Gameplay Walkthrough mp4', detect: {}, magnetUri: 'c', providerId: 'p', seeders: 1 },
      { title: 'Pokemon mystery pack', detect: {}, magnetUri: 'd', providerId: 'p', seeders: 1 },
    ];
    return { warnings: [], results: q.includes('nds') || q.includes('mp4') ? all : all.slice(0, 2) };
  };
  r = await smartSearch('pokemon', mixed, parseKinds('nds'));
  check('picking NDS also searches "pokemon nds"', ran.includes('pokemon nds'), JSON.stringify(ran));
  check('...and keeps only NDS results', r.results.length === 1 && /Platinum/.test(r.results[0].title), JSON.stringify(r.results.map((x) => x.title)));
  check('...and says how many were hidden', r.hiddenByKinds >= 2, String(r.hiddenByKinds));
  r = await smartSearch('pokemon', mixed, parseKinds('nds,video'));
  check('picks combine (NDS or video)', r.results.length === 2 && r.results.some((x) => /mp4/.test(x.title)) && r.results.some((x) => /Platinum/.test(x.title)), JSON.stringify(r.results.map((x) => x.title)));
  r = await smartSearch('pokemon', mixed, []);
  check('no picks: nothing is hidden', r.hiddenByKinds === 0 && r.results.length === 2);

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall search checks passed');
  process.exit(failed ? 1 : 0);
})();
