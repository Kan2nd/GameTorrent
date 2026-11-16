/**
 * Torrent search providers. GameTorrent ships zero indexers of its own —
 * a "provider" here is a Jackett instance the user runs and configures
 * themselves (pointing it at whatever indexers they have the right to
 * search). This module only ever proxies a search query to that instance
 * and returns results; it contains no site-specific scraping code, keeping
 * the "zero scraper code" legal stance from the main README intact while
 * still letting the user search by game name instead of hand-pasting a
 * pre-found magnet link.
 *
 * Provider records are stored in the `providers` table, with the Jackett API
 * key encrypted (lib/secretBox.js). The key is never sent back to the browser.
 */

'use strict';

const db = require('../db');
const secretBox = require('./secretBox');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { lookupCover } = require('./coverArt');
const { detectResult } = require('./platformDetect');
const Fuzzy = require('../public/fuzzy');
const { matchesAny } = require('./searchKinds');


// How many results per provider get a cover-art lookup. Art lookup is a
// network call per unique title (rate-limited, cached) — capping this
// keeps "browse all providers" pages fast and light on the cover-art sources.
const ART_LOOKUP_LIMIT = 8;
// A provider section is only worth showing if it actually has this many
// real (magnet-having) results — otherwise it's just noise.
const MIN_RESULTS_TO_DISPLAY = 5;
// How many raw results to pull per provider in browse/discover mode so
// "See more" has something to reveal without a second network round trip.
const DISCOVER_FETCH_LIMIT = 20;

/** Every provider, API key decrypted: for server-side use only, never returned to a client. */
async function loadProviders() {
  const { rows } = await db.query('select id, name, base_url, api_key_enc, added_at from providers order by added_at');
  return rows.map((r) => ({ id: r.id, name: r.name, baseUrl: r.base_url, apiKey: secretBox.decrypt(r.api_key_enc), addedAt: r.added_at }));
}

/** Never send the raw API key back to the browser once it's saved. */
function maskProvider(p) {
  const { apiKey, ...pub } = p;
  return { ...pub, apiKeySet: !!apiKey };
}

async function listProviders() {
  return (await loadProviders()).map(maskProvider);
}

function assertBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !/^https?:\/\/[^\s]+$/i.test(baseUrl) || baseUrl.length > 500) {
    throw new Error('baseUrl must be an http(s) URL, e.g. http://jackett:9117');
  }
}

async function addProvider({ name, baseUrl, apiKey }, addedBy) {
  if (!name || !baseUrl || !apiKey) throw new Error('name, baseUrl, and apiKey are all required');
  if (typeof name !== 'string' || typeof baseUrl !== 'string' || typeof apiKey !== 'string') throw new Error('name, baseUrl, and apiKey must be text');
  assertBaseUrl(baseUrl);
  const provider = {
    id: crypto.randomUUID(),
    name: name.slice(0, 100),
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    addedAt: new Date().toISOString(),
  };
  await db.query(
    'insert into providers (id, name, base_url, api_key_enc, added_by) values ($1, $2, $3, $4, $5)',
    [provider.id, provider.name, provider.baseUrl, secretBox.encrypt(provider.apiKey), addedBy || null],
  );
  return maskProvider(provider);
}

/**
 * Changes a provider's name and/or base URL and/or API key. Anything left out (or an empty apiKey) is kept as it is,
 * so the URL can be fixed without ever typing the key again. Returns the masked provider, or null if there is none.
 */
async function updateProvider(id, { name, baseUrl, apiKey }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const sets = [];
  const params = [id];
  const put = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };
  if (name !== undefined && name !== '') {
    if (typeof name !== 'string') throw new Error('name must be text');
    put('name', name.slice(0, 100));
  }
  if (baseUrl !== undefined && baseUrl !== '') {
    assertBaseUrl(baseUrl);
    put('base_url', baseUrl.replace(/\/+$/, ''));
  }
  if (apiKey !== undefined && apiKey !== '') {
    if (typeof apiKey !== 'string') throw new Error('apiKey must be text');
    put('api_key_enc', secretBox.encrypt(apiKey));
  }
  if (!sets.length) throw new Error('Nothing to change: give a name, a baseUrl or an apiKey');
  const { rowCount } = await db.query(`update providers set ${sets.join(', ')} where id = $1`, params);
  if (!rowCount) return null;
  return (await listProviders()).find((p) => p.id === id) || null;
}

async function removeProvider(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return;
  await db.query('delete from providers where id = $1', [id]);
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http://') ? http : https;
    lib.get(url, { timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        const looksLikeHtml = /^\s*<(!doctype|html)/i.test(body);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          // Don't echo the response body back to the browser — that would let this endpoint be
          // used to read pages from internal services. Log it server-side for debugging instead.
          if (!looksLikeHtml) console.warn(`Provider HTTP ${res.statusCode} body (truncated): ${body.slice(0, 200)}`);
          const detail = looksLikeHtml
            ? 'got an HTML page back instead of an API response — the Base URL is likely a website, not a Jackett instance (Jackett\'s API never returns HTML). Double-check it points at your own running Jackett, e.g. http://192.168.x.x:9117, not a torrent site/link.'
            : 'see the server log for the response details.';
          reject(new Error(`Provider returned HTTP ${res.statusCode}: ${detail}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (err) {
          const hint = looksLikeHtml
            ? 'got an HTML page back instead of JSON — the Base URL is likely a website, not a Jackett instance.'
            : err.message;
          reject(new Error(`Provider response was not valid JSON: ${hint}`));
        }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('Provider search timed out')); });
  });
}

/**
 * Raw call to one Jackett instance. An empty/blank query is intentionally
 * allowed — Jackett's aggregate endpoint returns each indexer's "latest"
 * torrents when Query is omitted, which is what powers the no-download
 * browse/preview sections (see discoverProvider below). `limit` trims the
 * result count (Jackett has no page-size param on this endpoint, so this
 * is applied client-side after normalizing).
 */
async function rawSearch(provider, query, limit) {
  const qParam = query && query.trim() ? `&Query=${encodeURIComponent(query.trim())}` : '';
  const url = `${provider.baseUrl}/api/v2.0/indexers/all/results?apikey=${encodeURIComponent(provider.apiKey)}${qParam}`;
  let data;
  try {
    data = await httpGetJson(url);
  } catch (err) {
    throw new Error(`Could not reach provider "${provider.name}": ${err.message}`);
  }

  const results = Array.isArray(data.Results) ? data.Results : [];
  const normalized = results
    .map((r) => ({
      title: r.Title,
      magnetUri: r.MagnetUri || null,
      size: r.Size || null,
      seeders: typeof r.Seeders === 'number' ? r.Seeders : null,
      peers: typeof r.Peers === 'number' ? r.Peers : null,
      indexer: r.Tracker || r.TrackerId || provider.name,
      category: r.CategoryDesc || null,
      // Which console this is, worked out before anything is downloaded (see lib/platformDetect.js).
      detect: detectResult({ title: r.Title, categoryDesc: r.CategoryDesc, categoryIds: r.Category }),
      publishDate: r.PublishDate || null,
      providerId: provider.id,
      providerName: provider.name,
    }))
    .sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
  return typeof limit === 'number' ? normalized.slice(0, limit) : normalized;
}

// A search with fewer than this many close matches is "thin" and gets widened (see smartSearch).
const THIN_RESULTS = 5;
const GOOD_MATCH = 0.55;

function resultKey(r) { return r.magnetUri || `${r.providerId}|${Fuzzy.normalize(r.title)}|${r.size}`; }

/**
 * Typo-tolerant search around one "run(query) -> { results, warnings }" call. Indexers match whole words, so
 * "legend of zeldas" (or "pokemn") finds nothing even though the game is there. When the exact query comes
 * back thin, a few broader queries are run as well (see Fuzzy.fallbackQueries), and what they bring back is
 * kept only if its title still fuzzy-matches what was typed. Every result carries `match` (0-1, how close the
 * title is to the query) so the page can put the best first, and `expandedFrom` says which wider queries ran.
 *
 * `kinds` (lib/searchKinds.js) are the "looking for" picks: one extra query per pick ("<query> nds") and, at the
 * end, only results that really are one of those kinds are kept (`hiddenByKinds` counts the others).
 */
async function smartSearch(query, run, kinds = []) {
  const first = await run(query);
  const seen = new Set();
  const results = [];
  const add = (r, exact) => {
    const k = resultKey(r);
    if (seen.has(k)) return;
    const m = Fuzzy.score(query, r.title);
    if (!exact && m === 0) return;           // from a broad query: only keep it if the title really resembles the search
    seen.add(k);
    results.push({ ...r, match: exact && m === 0 ? 0.5 : Math.round(m * 100) / 100 });
  };
  first.results.forEach((r) => add(r, true));

  const warnings = [...first.warnings];
  const fromPicks = kinds.map((k) => `${query.trim()} ${k.term}`);
  if (fromPicks.length) {
    const runs = await Promise.allSettled(fromPicks.map((q) => run(q)));
    runs.forEach((o) => { if (o.status === 'fulfilled') o.value.results.forEach((r) => add(r, false)); });
  }

  let expandedFrom = [];
  if (results.filter((r) => r.match >= GOOD_MATCH && matchesAny(kinds, r)).length < THIN_RESULTS) {
    const extra = Fuzzy.fallbackQueries(query);
    const runs = await Promise.allSettled(extra.map((q) => run(q)));   // a failing broad query is not worth a warning
    runs.forEach((o) => { if (o.status === 'fulfilled') o.value.results.forEach((r) => add(r, false)); });
    expandedFrom = extra;
  }

  const kept = results.filter((r) => matchesAny(kinds, r));
  kept.sort((a, b) => ((b.match >= GOOD_MATCH) - (a.match >= GOOD_MATCH)) || (b.seeders || 0) - (a.seeders || 0));
  return { results: kept, warnings, expandedFrom, kinds: kinds.map((k) => k.id), hiddenByKinds: results.length - kept.length };
}

/** Searches one specific provider by id (existing single-provider search UI). */
async function searchProvider(id, query, kinds) {
  if (!query || !query.trim()) throw new Error('Search query is required');
  const provider = (await loadProviders()).find((p) => p.id === id);
  if (!provider) throw new Error('Provider not found');
  return smartSearch(query, async (q) => ({ results: await rawSearch(provider, q), warnings: [] }), kinds);
}

/**
 * Searches every configured provider at once and merges the results,
 * tagged with which provider each came from — backs the search bar's
 * default "All providers" mode. Providers that error are skipped with a
 * warning rather than failing the whole search.
 */
async function searchAllProviders(query, kinds) {
  if (!query || !query.trim()) throw new Error('Search query is required');
  const providers = await loadProviders();
  return smartSearch(query, async (q) => {
    const warnings = [];
    const settled = await Promise.allSettled(providers.map((p) => rawSearch(p, q)));
    const results = [];
    settled.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') results.push(...outcome.value);
      else warnings.push(`${providers[i].name}: ${outcome.reason.message}`);
    });
    return { results, warnings };
  }, kinds);
}

// --- Cover art enrichment ---
// Best-effort only and purely cosmetic: lib/coverArt.js tries libretro's
// box-art library (no key needed), then RAWG if RAWG_API_KEY is set. A card
// with no match just shows its generated tile.

async function enrichWithArt(results, limit) {
  const toEnrich = results.slice(0, limit);
  const images = await Promise.all(toEnrich.map((r) => lookupCover(r.title, r.detect && r.detect.platform)));
  toEnrich.forEach((r, i) => { r.coverImage = images[i]; });
  results.slice(limit).forEach((r) => { r.coverImage = null; });
  return results;
}

/**
 * Browse mode for one provider: blank-query "latest" results, magnet-only,
 * art-enriched, tagged installed/not. Returns null if it doesn't clear
 * MIN_RESULTS_TO_DISPLAY — caller should skip rendering that section.
 */
async function discoverProvider(provider, installedMagnets) {
  let results;
  try {
    results = await rawSearch(provider, '', DISCOVER_FETCH_LIMIT);
  } catch (err) {
    return { providerId: provider.id, providerName: provider.name, error: err.message, results: [] };
  }

  const withMagnets = results.filter((r) => r.magnetUri);
  if (withMagnets.length < MIN_RESULTS_TO_DISPLAY) return null;

  await enrichWithArt(withMagnets, ART_LOOKUP_LIMIT);
  withMagnets.forEach((r) => { r.installed = installedMagnets.has(r.magnetUri); });

  return { providerId: provider.id, providerName: provider.name, results: withMagnets };
}

/** Browse mode across every configured provider — powers the Search tab's default sections. */
async function discoverAllProviders(installedMagnets) {
  const providers = await loadProviders();
  const settled = await Promise.all(providers.map((p) => discoverProvider(p, installedMagnets)));
  return settled.filter(Boolean);
}

module.exports = {
  listProviders, addProvider, updateProvider, removeProvider,
  searchProvider, searchAllProviders, smartSearch,
  discoverAllProviders,
  lookupCover,
};
