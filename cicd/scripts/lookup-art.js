#!/usr/bin/env node
// Cover-art lookup helper for whoever curates catalog/catalog.json — prints
// candidates from RAWG (rawg.io) for a title so you can eyeball and copy a
// real image URL into a game's `coverImage` field by hand.
//
// This is a research aid, not an automated pipeline step: results are
// shown for a human to verify, never written directly into the catalog.
// RAWG (mainstream game database) is unlikely to have niche homebrew
// titles — for those, try https://thegamesdb.net or
// https://gamesdb.launchbox-app.com instead, or just use the author's own
// site/itch.io page image, as tobu-tobu-girl and super-haxagon already do.
//
// Usage:
//   RAWG_API_KEY=your-key node scripts/lookup-art.js "Anguna"
// Free key: https://rawg.io/login/?forward=developer

const https = require('https');

const apiKey = process.env.RAWG_API_KEY;
const title = process.argv.slice(2).join(' ').trim();

if (!apiKey) {
  console.error('RAWG_API_KEY is not set. Get a free key at https://rawg.io/login/?forward=developer');
  process.exit(1);
}
if (!title) {
  console.error('Usage: RAWG_API_KEY=... node scripts/lookup-art.js "<game title>"');
  process.exit(1);
}

const url = `https://api.rawg.io/api/games?key=${encodeURIComponent(apiKey)}&search=${encodeURIComponent(title)}&page_size=8`;

https.get(url, (res) => {
  let body = '';
  res.on('data', (d) => { body += d; });
  res.on('end', () => {
    if (res.statusCode !== 200) {
      console.error(`RAWG returned HTTP ${res.statusCode}: ${body.slice(0, 300)}`);
      process.exit(1);
    }
    const data = JSON.parse(body);
    const results = data.results || [];
    if (!results.length) {
      console.log(`No RAWG results for "${title}" — expected for niche homebrew; try TheGamesDB/LaunchBox Games DB, or the author's own site.`);
      return;
    }
    console.log(`${results.length} candidate(s) for "${title}" — verify before using, this is a name match, not a guarantee:\n`);
    for (const r of results) {
      console.log(`- ${r.name} (${r.released || 'release date unknown'})`);
      console.log(`  image: ${r.background_image || '(none)'}`);
    }
  });
}).on('error', (err) => {
  console.error(`RAWG request failed: ${err.message}`);
  process.exit(1);
});
