/**
 * Custom feed management. A "feed" is a remote feed.json matching the same
 * schema as catalog/catalog.json (see catalog/catalog.schema.json) — the
 * BYOC model's "point the app at your own feed" path from docs/ARCHITECTURE.md.
 * Feed URLs are stored locally; their content is fetched fresh (and
 * schema-validated) each time the combined catalog is requested, so an
 * updated remote feed shows up without any action here.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const pipeline = require('../../poc/pipeline');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FEEDS_PATH = path.join(DATA_DIR, 'feeds.json');
const SCHEMA_PATH = path.join(pipeline.ROOT, 'catalog', 'catalog.schema.json');

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const validate = ajv.compile(schema);

function loadFeeds() {
  if (!fs.existsSync(FEEDS_PATH)) return [];
  return JSON.parse(fs.readFileSync(FEEDS_PATH, 'utf8'));
}

function saveFeeds(feeds) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FEEDS_PATH, JSON.stringify(feeds, null, 2));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http://') ? http : https;
    lib.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        res.resume();
        return;
      }
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error(`Feed at ${url} is not valid JSON: ${err.message}`)); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('Feed fetch timed out')); });
  });
}

/** Fetches and schema-validates a feed URL; throws with details if invalid. Does not save it. */
async function fetchAndValidateFeed(url) {
  const data = await fetchJson(url);
  if (!validate(data)) {
    const details = validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new Error(`Feed does not match catalog schema: ${details}`);
  }
  return data;
}

async function addFeed(url) {
  const feeds = loadFeeds();
  if (feeds.some((f) => f.url === url)) throw new Error('That feed URL is already added');

  const data = await fetchAndValidateFeed(url); // throws if unreachable/invalid — don't save a broken feed
  const feed = { id: crypto.randomUUID(), url, name: data.name || url, addedAt: new Date().toISOString() };
  feeds.push(feed);
  saveFeeds(feeds);
  return feed;
}

function removeFeed(id) {
  const feeds = loadFeeds().filter((f) => f.id !== id);
  saveFeeds(feeds);
}

/**
 * Returns the default catalog's games plus every stored feed's games,
 * each tagged with which source it came from. A feed that's currently
 * unreachable/invalid is skipped (with a warning attached) rather than
 * failing the whole catalog view.
 */
async function getCombinedCatalog() {
  const defaultCatalog = pipeline.loadCatalog();
  const games = defaultCatalog.games.map((g) => ({ ...g, feedSource: 'default' }));
  const warnings = [];

  for (const feed of loadFeeds()) {
    try {
      const data = await fetchAndValidateFeed(feed.url);
      for (const g of data.games) games.push({ ...g, feedSource: feed.name });
    } catch (err) {
      warnings.push(`Feed "${feed.name}" (${feed.url}): ${err.message}`);
    }
  }

  return { games, warnings };
}

module.exports = { loadFeeds, addFeed, removeFeed, getCombinedCatalog, fetchAndValidateFeed };
