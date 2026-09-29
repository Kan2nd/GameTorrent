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
 * Provider records (including the Jackett API key) are stored in
 * webui/data/providers.json, which is gitignored — same treatment as
 * feeds.json/downloads.json.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { lookupCover } = require('./coverArt');
const { detectResult } = require('./platformDetect');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PROVIDERS_PATH = path.join(DATA_DIR, 'providers.json');

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

function loadProviders() {
  if (!fs.existsSync(PROVIDERS_PATH)) return [];
  return JSON.parse(fs.readFileSync(PROVIDERS_PATH, 'utf8'));
}

function saveProviders(providers) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PROVIDERS_PATH, JSON.stringify(providers, null, 2));
}

/** Never send the raw API key back to the browser once it's saved. */
function maskProvider(p) {
  const { apiKey, ...pub } = p;
  return { ...pub, apiKeySet: !!apiKey };
}

function listProviders() {
  return loadProviders().map(maskProvider);
}

function addProvider({ name, baseUrl, apiKey }) {
  if (!name || !baseUrl || !apiKey) throw new Error('name, baseUrl, and apiKey are all required');
  const providers = loadProviders();
  const provider = {
    id: crypto.randomUUID(),
    name,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    addedAt: new Date().toISOString(),
  };
  providers.push(provider);
  saveProviders(providers);
  return maskProvider(provider);
}

function removeProvider(id) {
  saveProviders(loadProviders().filter((p) => p.id !== id));
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
          const detail = looksLikeHtml
            ? 'got an HTML page back instead of an API response — the Base URL is likely a website, not a Jackett instance (Jackett\'s API never returns HTML). Double-check it points at your own running Jackett, e.g. http://192.168.x.x:9117, not a torrent site/link.'
            : body.slice(0, 200);
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

/** Searches one specific provider by id (existing single-provider search UI). */
async function searchProvider(id, query) {
  if (!query || !query.trim()) throw new Error('Search query is required');
  const provider = loadProviders().find((p) => p.id === id);
  if (!provider) throw new Error('Provider not found');
  return rawSearch(provider, query);
}

/**
 * Searches every configured provider at once and merges the results,
 * tagged with which provider each came from — backs the search bar's
 * default "All providers" mode. Providers that error are skipped with a
 * warning rather than failing the whole search.
 */
async function searchAllProviders(query) {
  if (!query || !query.trim()) throw new Error('Search query is required');
  const providers = loadProviders();
  const warnings = [];
  const settled = await Promise.allSettled(providers.map((p) => rawSearch(p, query)));

  const results = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') results.push(...outcome.value);
    else warnings.push(`${providers[i].name}: ${outcome.reason.message}`);
  });
  results.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
  return { results, warnings };
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
  const providers = loadProviders();
  const settled = await Promise.all(providers.map((p) => discoverProvider(p, installedMagnets)));
  return settled.filter(Boolean);
}

module.exports = {
  listProviders, addProvider, removeProvider,
  searchProvider, searchAllProviders,
  discoverAllProviders,
  lookupCover,
};
